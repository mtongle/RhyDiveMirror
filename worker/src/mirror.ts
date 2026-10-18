/**
 * Serving side of the mirror: everything that answers from R2.
 *
 * Behaviours that matter for client compatibility:
 *  - `Range` and `HEAD` are honoured (the client streams audio with ranges and
 *    probes archives with HEAD).
 *  - `Content-Type` is always concrete; the client treats an HTML response to a
 *    chart URL as a hard failure.
 *  - A missing object returns `null` so the caller can fall back (404 for the
 *    download-site surface, upstream for the API surface).
 */
import { KEYS, type Config } from './config';
import { contentTypeFor } from './assets';
import { parseRange, sha256Hex, type ByteRange } from './http';
import type { BulkHead, BulkStore } from './storage';
import { extractEntry, readCentralDirectory } from './zip';

export interface ServeOptions {
  /** Fallback content type when the object carries no httpMetadata. */
  fallbackType?: string;
  /** Allow `If-None-Match` to produce a 304. */
  conditional?: boolean;
  /** Stable validator chosen by the caller for a content-addressed object. */
  etag?: string;
}

export async function serveObject(
  request: Request,
  store: BulkStore,
  key: string,
  options: ServeOptions = {},
): Promise<Response | null> {
  const head = await store.head(key);
  if (!head) return null;

  const etag = options.etag ?? head.etag ?? deterministicEtag(key, head.size, head.uploaded);
  const contentType = head.contentType ?? options.fallbackType ?? 'application/octet-stream';
  const cacheControl = head.cacheControl ?? 'public, max-age=60';

  if (options.conditional !== false) {
    const inm = request.headers.get('if-none-match');
    if (inm && etag && matchesEtag(inm, etag)) {
      return new Response(null, {
        status: 304,
        headers: {
          etag,
          'last-modified': head.uploaded.toUTCString(),
          'cache-control': cacheControl,
        },
      });
    }
  }

  const ifRange = request.headers.get('if-range');
  const allowRange = !ifRange || matchesIfRange(ifRange, etag, head.uploaded);
  const range = allowRange ? parseRange(request.headers.get('range'), head.size) : null;
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: {
        'content-range': `bytes */${head.size}`,
        'accept-ranges': 'bytes',
      },
    });
  }

  const isHead = request.method === 'HEAD';
  const headers = new Headers();
  headers.set('content-type', contentType);
  headers.set('cache-control', cacheControl);
  headers.set('accept-ranges', 'bytes');
  headers.set('etag', etag);
  headers.set('last-modified', head.uploaded.toUTCString());

  let status = 200;
  if (range) {
    status = 206;
    headers.set('content-length', String(range.length));
    headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
  } else {
    headers.set('content-length', String(head.size));
  }

  // HEAD requests must not execute body download or leak unconsumed streams
  if (isHead) {
    return new Response(null, { status, headers });
  }

  const object = await store.get(key, range ? { offset: range.offset, length: range.length } : undefined);
  if (!object) return null;
  return new Response(object.body ?? null, { status, headers });
}

/**
 * Resolve an asset: prefer the materialised object, fall back to extracting the
 * single entry from the stored archive and (optionally) cache it back into R2.
 */
export async function serveAsset(
  request: Request,
  store: BulkStore,
  config: Config,
  songId: string,
  assetName: string,
): Promise<Response | null> {
  const isHead = request.method === 'HEAD';
  const generation = await activeGeneration(store, songId);
  const assetKey = generation?.assetKeys?.[assetName] ?? generation?.assetPaths?.[assetName];
  const generationEtag = generation ? await assetEtag(generation.archiveHash, assetName) : undefined;
  if (assetKey) {
    const versioned = await serveObject(request, store, assetKey, {
      fallbackType: contentTypeFor(assetName),
      ...(generationEtag ? { etag: generationEtag } : {}),
    });
    if (versioned) return versioned;
  }

  if (!generation) {
    // Pre-generation deployments only have the stable path.
    const stored = await serveAssetObject(request, store, songId, assetName);
    if (stored) return stored;
  } else if (!assetKey) {
    // Lazy assets live under the stable key. Refuse a cache left behind by a
    // previous archive generation; otherwise a re-upload can briefly serve old
    // bytes under the new manifest.
    const stableKey = KEYS.asset(songId, assetName);
    const head = await store.head(stableKey);
    if (head?.customMetadata?.generation === generation.archiveHash) {
      const readable = await serveObject(request, store, stableKey, {
        fallbackType: contentTypeFor(assetName),
        ...(generationEtag ? { etag: generationEtag } : {}),
      });
      if (readable) return readable;
    }
  }

  const archiveKey = generation?.archiveKey ?? KEYS.archive(songId);
  if (isHead) {
    // Read the central directory directly from the tail of the object.
    const head = await store.head(archiveKey);
    if (!head || head.size < 22) return null;
    const tailLength = Math.min(head.size, 65_557);
    const tail = await store.get(archiveKey, { offset: head.size - tailLength, length: tailLength });
    if (!tail) return null;
    const bytes = new Uint8Array(await tail.arrayBuffer());
    let entry;
    try {
      entry = readCentralDirectory(bytes, head.size - tailLength).find((candidate) => candidate.name === assetName);
    } catch {
      return null;
    }
    if (!entry) return null;
    return metadataResponse(request,
      {
        size: entry.uncompressedSize,
        etag: `"${entry.crc32.toString(16)}-${entry.uncompressedSize.toString(16)}"`,
        uploaded: head.uploaded,
        contentType: contentTypeFor(assetName),
      },
      contentTypeFor(assetName),
      generationEtag,
    );
  }
  const archive = await store.get(archiveKey);
  if (!archive) return null;
  const bytes = new Uint8Array(await archive.arrayBuffer());
  let entry;
  try {
    entry = readCentralDirectory(bytes).find((candidate) => candidate.name === assetName);
  } catch {
    return null;
  }
  if (!entry) return null;

  let data: Uint8Array;
  try {
    data = await extractEntry(bytes, entry);
  } catch {
    return null;
  }

  const contentType = contentTypeFor(assetName);
  const etag = generationEtag ?? `"${entry.crc32.toString(16)}-${entry.uncompressedSize.toString(16)}"`;
  if (config.assetWriteThrough) {
    await store
      .put(KEYS.asset(songId, assetName), data, {
        contentType,
        cacheControl: 'public, max-age=31536000, immutable',
        customMetadata: { generation: generation?.archiveHash ?? '' },
      })
      .catch(() => undefined);
  }

  const range = parseRange(request.headers.get('range'), data.byteLength);
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: {
        'content-range': `bytes */${data.byteLength}`,
        'accept-ranges': 'bytes',
      },
    });
  }
  const headers = new Headers({
    'content-type': contentType,
    'cache-control': 'public, max-age=31536000, immutable',
    'accept-ranges': 'bytes',
    etag,
  });
  if (range) {
    headers.set('content-length', String(range.length));
    headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${data.byteLength}`);
    return new Response(request.method === 'HEAD' ? null : slice(data, range), { status: 206, headers });
  }
  headers.set('content-length', String(data.byteLength));
  return new Response(request.method === 'HEAD' ? null : data, { status: 200, headers });
}

function metadataResponse(request: Request, head: BulkHead, fallbackType: string, fixedEtag?: string): Response {
  const etag = fixedEtag ?? head.etag ?? deterministicEtagFromSize(head.size, head.uploaded);
  if (request.headers.get('if-none-match') && matchesEtag(request.headers.get('if-none-match')!, etag)) {
    return new Response(null, { status: 304, headers: { etag, 'last-modified': head.uploaded.toUTCString() } });
  }
  return new Response(null, {
    headers: {
      'content-type': head.contentType ?? fallbackType,
      'cache-control': head.cacheControl ?? 'public, max-age=31536000, immutable',
      'accept-ranges': 'bytes',
      etag,
      'last-modified': head.uploaded.toUTCString(),
      'content-length': String(head.size),
    },
  });
}

function deterministicEtag(key: string, size: number, uploaded: Date): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= size >>> 0;
  return `"${hash.toString(16)}-${size.toString(16)}-${Math.floor(uploaded.getTime() / 1000).toString(16)}"`;
}

async function assetEtag(archiveHash: string, name: string): Promise<string> {
  // Content-derived validator: identical across R2 and Drive and across lazy
  // extraction versus materialised serving paths.
  return `"${(await sha256Hex(new TextEncoder().encode(`${archiveHash}\0${name}`))).slice(0, 32)}"`;
}

function deterministicEtagFromSize(size: number, uploaded: Date): string {
  return `"${size.toString(16)}-${Math.floor(uploaded.getTime() / 1000).toString(16)}"`;
}

export interface ActiveGeneration {
  archiveHash: string;
  archiveKey: string;
  manifestKey?: string;
  assetPaths?: Record<string, string>;
  assetKeys?: Record<string, string>;
}

export async function activeGeneration(store: BulkStore, songId: string): Promise<ActiveGeneration | null> {
  const object = await store.get(KEYS.current(songId));
  if (!object) return null;
  try {
    const value = (await object.json()) as ActiveGeneration;
    return value && typeof value.archiveHash === 'string' && typeof value.archiveKey === 'string' ? value : null;
  } catch {
    return null;
  }
}

async function serveAssetObject(
  request: Request,
  store: BulkStore,
  songId: string,
  assetName: string,
): Promise<Response | null> {
  return serveObject(request, store, KEYS.asset(songId, assetName), {
    fallbackType: contentTypeFor(assetName),
  });
}

function slice(data: Uint8Array, range: ByteRange): Uint8Array {
  return data.subarray(range.offset, range.offset + range.length);
}

function matchesEtag(header: string, etag: string): boolean {
  if (header.trim() === '*') return true;
  return header
    .split(',')
    .map((value) => value.trim().replace(/^W\//, ''))
    .some((value) => value === etag.replace(/^W\//, ''));
}

function matchesIfRange(header: string, etag: string, uploaded: Date): boolean {
  const trimmed = header.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith('W/')) {
    return matchesEtag(trimmed, etag);
  }
  const date = Date.parse(trimmed);
  return Number.isFinite(date) && Math.floor(date / 1000) === Math.floor(uploaded.getTime() / 1000);
}
