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
import { parseRange, type ByteRange } from './http';
import type { BulkStore } from './storage';
import { extractEntry, readCentralDirectory } from './zip';

export interface ServeOptions {
  /** Fallback content type when the object carries no httpMetadata. */
  fallbackType?: string;
  /** Allow `If-None-Match` to produce a 304. */
  conditional?: boolean;
}

export async function serveObject(
  request: Request,
  store: BulkStore,
  key: string,
  options: ServeOptions = {},
): Promise<Response | null> {
  const head = await store.head(key);
  if (!head) return null;

  const etag = head.etag;
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
  const stored = await serveAssetObject(request, store, songId, assetName);
  if (stored) return stored;

  const archive = await store.get(KEYS.archive(songId));
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
  if (config.assetWriteThrough) {
    await store
      .put(KEYS.asset(songId, assetName), data, {
        contentType,
        cacheControl: 'public, max-age=31536000, immutable',
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
  });
  if (range) {
    headers.set('content-length', String(range.length));
    headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${data.byteLength}`);
    return new Response(request.method === 'HEAD' ? null : slice(data, range), { status: 206, headers });
  }
  headers.set('content-length', String(data.byteLength));
  return new Response(request.method === 'HEAD' ? null : data, { status: 200, headers });
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
