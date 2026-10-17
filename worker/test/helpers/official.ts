/**
 * A fake official RhyDive API (`sta.lunprin.com`) plus download site
 * (`dl.lunprin.com`), good enough to drive the full sync + serve pipeline.
 */
import { createHash } from 'node:crypto';
import { buildZip, type FixtureEntry } from './zip-builder';

export interface FixtureSong {
  id: string;
  title: string;
  entries: FixtureEntry[];
}

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface FakeOfficialOptions {
  songs: FixtureSong[];
  /** Extra handler for non-chart endpoints; return undefined for the default echo. */
  passthrough?: (request: Request) => Response | undefined;
}

export class FakeOfficial {
  readonly origin = 'https://sta.lunprin.test';
  readonly cdnOrigin = 'https://dl.lunprin.test';
  requests: RecordedRequest[] = [];
  catalogFetches = 0;
  archiveFetches = 0;
  cdnCatalogFetches = 0;
  cdnArchiveFetches = 0;

  private readonly songs = new Map<string, FixtureSong>();
  private readonly zips = new Map<string, Uint8Array>();
  private readonly manifests = new Map<string, unknown>();
  private readonly assets = new Map<string, Uint8Array>();
  private readonly songOrder: FixtureSong[];
  /** Song ids the download site has not published yet (catalog/CDN race). */
  private readonly cdnMissing = new Set<string>();
  /** Song ids whose catalog entry advertises a stale hash (re-upload race). */
  private readonly staleCatalogHash = new Map<string, string>();
  private readonly passthrough: ((request: Request) => Response | undefined) | undefined;

  constructor(options: FakeOfficialOptions) {
    this.songOrder = options.songs;
    this.passthrough = options.passthrough;
    for (const song of options.songs) {
      const zip = buildZip(song.entries);
      this.songs.set(song.id, song);
      this.zips.set(song.id, zip);
      const files = song.entries.map((entry) => {
        const data = typeof entry.data === 'string' ? new TextEncoder().encode(entry.data) : entry.data;
        this.assets.set(`${song.id}/${entry.name}`, data);
        return {
          name: entry.name,
          url: `/api/rhydive/assets/${song.id}/${entry.name.split('/').map(encodeURIComponent).join('/')}`,
          size: data.byteLength,
          sha256: sha256(data),
        };
      });
      this.manifests.set(song.id, {
        success: true,
        song: { id: song.id, source: 'server-upload', archiveHash: sha256(zip), title: song.title },
        files,
        archive: {
          url: `/api/rhydive/library/${song.id}/archive`,
          size: zip.byteLength,
          sha256: sha256(zip),
        },
        totalBytes: files.reduce((total, file) => total + file.size, 0),
      });
    }
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as RequestInfo, init);
    const url = new URL(request.url);
    this.requests.push({
      method: request.method,
      url: url.toString(),
      headers: Object.fromEntries(request.headers),
      body: request.body ? await request.clone().text() : null,
    });

    // Official download-site surface (dl.lunprin.com/rhydive/beatmap/...).
    const cdn = /^\/rhydive\/beatmap\/(.+)$/.exec(url.pathname);
    if (cdn) {
      const rest = cdn[1]!;
      if (rest === '_catalog/library.json') {
        this.cdnCatalogFetches += 1;
        // The real download site serves the same catalog without the API-only
        // `storage` key; emulate that so source selection is observable.
        return jsonResponse({ success: true, songs: this.catalog().songs });
      }
      const cdnManifest = /^_catalog\/manifests\/([^/]+)\.json$/.exec(rest);
      if (cdnManifest) {
        const id = decodeURIComponent(cdnManifest[1]!);
        if (this.cdnMissing.has(id)) return jsonResponse({ success: false, message: 'not in library' }, 404);
        const payload = this.manifests.get(id);
        if (!payload) return jsonResponse({ success: false, message: 'not in library' }, 404);
        return jsonResponse(payload);
      }
      const cdnArchive = /^([^/]+)\.zip$/.exec(rest);
      if (cdnArchive) {
        this.cdnArchiveFetches += 1;
        const id = decodeURIComponent(cdnArchive[1]!);
        if (this.cdnMissing.has(id)) return new Response('not found', { status: 404 });
        const zip = this.zips.get(id);
        if (!zip) return new Response('not found', { status: 404 });
        return rangeResponse(request, zip, 'application/zip');
      }
    }

    const asset = /^\/api\/rhydive\/assets\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (asset) {
      const key = `${asset[1]}/${decodeURI(asset[2]!)}`;
      const bytes = this.assets.get(key);
      if (!bytes) return new Response('not found', { status: 404 });
      return rangeResponse(request, bytes, 'application/octet-stream');
    }

    const manifest = /^\/api\/rhydive\/library\/([^/]+)\/download$/.exec(url.pathname);
    if (manifest) {
      const payload = this.manifests.get(manifest[1]!);
      if (!payload) return jsonResponse({ success: false, message: 'not in library' }, 404);
      return jsonResponse(payload);
    }

    const archive = /^\/api\/rhydive\/library\/([^/]+)\/archive$/.exec(url.pathname);
    if (archive) {
      this.archiveFetches += 1;
      const zip = this.zips.get(archive[1]!);
      if (!zip) return new Response('not found', { status: 404 });
      return rangeResponse(request, zip, 'application/zip');
    }

    if (url.pathname === '/api/rhydive/library') {
      this.catalogFetches += 1;
      return jsonResponse({
        success: true,
        songs: this.songOrder.map((song) => ({
          id: song.id,
          source: 'server-upload',
          archiveHash: this.staleCatalogHash.get(song.id) ?? sha256(this.zips.get(song.id)!),
          title: song.title,
          artist: 'fixture',
          cover: `/api/rhydive/assets/${song.id}/bg.png`,
          audio: `/api/rhydive/assets/${song.id}/audio.mp3`,
        })),
      });
    }

    const custom = this.passthrough?.(request);
    if (custom) return custom;

    // Default pass-through behaviour: prove the proxy forwarded everything.
    return jsonResponse({
      success: true,
      echo: { method: request.method, path: url.pathname, search: url.search, host: url.host },
    });
  };

  catalog(): { success: boolean; songs: unknown[] } {
    const songs = this.songOrder.map((song) => ({
      id: song.id,
      source: 'server-upload',
      archiveHash: this.staleCatalogHash.get(song.id) ?? sha256(this.zips.get(song.id)!),
      title: song.title,
    }));
    return { success: true, songs };
  }

  /**
   * Simulate a re-upload: the catalog keeps advertising the old hash while
   * `/download` and `/archive` already serve the new bytes.
   */
  markCatalogHashStale(id: string, staleHash: string): void {
    this.staleCatalogHash.set(id, staleHash);
  }

  zipOf(id: string): Uint8Array {
    const zip = this.zips.get(id);
    if (!zip) throw new Error(`no fixture zip for ${id}`);
    return zip;
  }

  manifestOf(id: string): {
    files: { name: string; size: number; sha256: string }[];
    archive: { size: number; sha256: string };
  } {
    const manifest = this.manifests.get(id) as {
      files: { name: string; size: number; sha256: string }[];
      archive: { size: number; sha256: string };
    };
    if (!manifest) throw new Error(`no fixture manifest for ${id}`);
    return manifest;
  }

  /** Replace a song's archive to simulate an upstream update. */
  updateSong(id: string, entries: FixtureEntry[]): void {
    const song = this.songs.get(id);
    if (!song) throw new Error(`unknown song ${id}`);
    song.entries = entries;
    const zip = buildZip(entries);
    this.zips.set(id, zip);
    for (const key of [...this.assets.keys()]) {
      if (key.startsWith(`${id}/`)) this.assets.delete(key);
    }
    const files = entries.map((entry) => {
      const data = typeof entry.data === 'string' ? new TextEncoder().encode(entry.data) : entry.data;
      this.assets.set(`${id}/${entry.name}`, data);
      return {
        name: entry.name,
        url: `/api/rhydive/assets/${id}/${entry.name.split('/').map(encodeURIComponent).join('/')}`,
        size: data.byteLength,
        sha256: sha256(data),
      };
    });
    this.manifests.set(id, {
      success: true,
      song: { id, source: 'server-upload', archiveHash: sha256(zip), title: song.title },
      files,
      archive: { url: `/api/rhydive/library/${id}/archive`, size: zip.byteLength, sha256: sha256(zip) },
      totalBytes: files.reduce((total, file) => total + file.size, 0),
    });
  }

  /** Simulate the download site lagging behind the catalog for one song. */
  removeCdnArchive(id: string): void {
    this.cdnMissing.add(id);
  }

  /** Simulate the download site catching up. */
  restoreCdnArchive(id: string): void {
    this.cdnMissing.delete(id);
  }

  removeSong(id: string): void {
    this.songs.delete(id);
    this.zips.delete(id);
    this.manifests.delete(id);
    for (const key of [...this.assets.keys()]) if (key.startsWith(`${id}/`)) this.assets.delete(key);
    const index = this.songOrder.findIndex((song) => song.id === id);
    if (index >= 0) this.songOrder.splice(index, 1);
  }

  requestedPaths(): string[] {
    return this.requests.map((request) => new URL(request.url).pathname);
  }

  requestedOrigins(): string[] {
    return this.requests.map((request) => new URL(request.url).origin);
  }
}

export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Minimal single-range support so proxied 206 responses can be asserted. */
function rangeResponse(request: Request, bytes: Uint8Array, contentType: string): Response {
  const header = request.headers.get('range');
  const match = header ? /^bytes=(\d+)-(\d*)$/.exec(header) : null;
  if (!match) {
    return new Response(request.method === 'HEAD' ? null : (bytes as unknown as BodyInit), {
      headers: { 'content-type': contentType, 'content-length': String(bytes.byteLength), 'accept-ranges': 'bytes' },
    });
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), bytes.byteLength - 1) : bytes.byteLength - 1;
  const slice = bytes.subarray(start, end + 1);
  return new Response(request.method === 'HEAD' ? null : (slice as unknown as BodyInit), {
    status: 206,
    headers: {
      'content-type': contentType,
      'content-length': String(slice.byteLength),
      'content-range': `bytes ${start}-${end}/${bytes.byteLength}`,
      'accept-ranges': 'bytes',
    },
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
