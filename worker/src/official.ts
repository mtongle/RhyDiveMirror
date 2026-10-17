/**
 * Client for the official RhyDive API (`https://sta.lunprin.com`).
 *
 * Only the public, chart-related read endpoints are used here; everything else
 * is forwarded verbatim by the proxy rather than interpreted.
 */
import type { Config } from './config';
import { globalFetch, type FetchLike } from './fetch';

export interface OfficialSong {
  id: string;
  source?: string;
  archiveHash: string;
  title: string;
  nativeTitle?: string;
  artist?: string;
  mapper?: string;
  cover?: string;
  audio?: string;
  previewTime?: number;
  bpm?: number;
  length?: string;
  accent?: string;
  uploadedAt?: string;
  tutorial?: boolean;
  hitSounds?: { name: string; url: string }[];
  difficulties?: OfficialDifficulty[];
  [key: string]: unknown;
}

export interface OfficialDifficulty {
  name: string;
  stars?: number;
  beatmap?: string;
  backgroundVideo?: string | null;
  storyboards?: string[];
  [key: string]: unknown;
}

export interface OfficialCatalog {
  success: boolean;
  songs: OfficialSong[];
  message?: string;
}

export interface ManifestFile {
  name: string;
  url: string;
  size: number;
  sha256: string;
}

export interface OfficialManifest {
  success: boolean;
  song: OfficialSong;
  files: ManifestFile[];
  archive: { url: string; size: number; sha256: string };
  totalBytes: number;
  message?: string;
}

export class OfficialError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

const TIMEOUTS = {
  catalog: 300_000,
  manifest: 120_000,
  archive: 900_000,
  asset: 300_000,
} as const;

/**
 * Reads the official chart artifacts from either:
 *
 *  - `api` — `sta.lunprin.com`, the canonical server. Measured at ~70 KB/s for
 *    the 3.5 MB catalog from the author's network, which is why the timeouts are
 *    deliberately generous: a truncated catalog is worse than a slow tick.
 *  - `cdn` — `dl.lunprin.com/rhydive/beatmap`, the official download site
 *    (~5 MB/s). Verified byte-identical: same song ids, same order, same
 *    `uploadedAt`, identical archives and assets.
 *
 * The surfaces differ only in that the API catalog additionally carries a
 * top-level `storage` key (`usedBytes`/`quotaBytes`) and per-difficulty
 * `accuracy`/`grade`/`score` fields. Neither affects the mirror.
 */
/**
 * Canonical URLs for one chart artifact on the configured source. Shared by the
 * sync client and by the request-time fallback proxy, so both always agree on
 * where an artifact lives.
 */
export interface OriginUrls {
  catalog: string;
  manifest(songId: string): string;
  archive(songId: string): string;
  asset(songId: string, assetName: string): string;
}

export function sourceUrls(config: Config, source: 'api' | 'cdn'): OriginUrls {
  const cdn = source === 'cdn';
  const encodeName = (name: string) => name.split('/').map(encodeURIComponent).join('/');
  return {
    catalog: cdn
      ? `${config.cdnBeatmapBase}/_catalog/library.json`
      : `${config.officialOrigin}/api/rhydive/library`,
    manifest: (songId) => {
      const id = encodeURIComponent(songId);
      return cdn
        ? `${config.cdnBeatmapBase}/_catalog/manifests/${id}.json`
        : `${config.officialOrigin}/api/rhydive/library/${id}/download`;
    },
    archive: (songId) => {
      const id = encodeURIComponent(songId);
      return cdn
        ? `${config.cdnBeatmapBase}/${id}.zip`
        : `${config.officialOrigin}/api/rhydive/library/${id}/archive`;
    },
    asset: (songId, assetName) => {
      const id = encodeURIComponent(songId);
      return cdn
        ? `${config.cdnBeatmapBase}/${id}/${encodeName(assetName)}`
        : `${config.officialOrigin}/api/rhydive/assets/${id}/${encodeName(assetName)}`;
    },
  };
}

export function originUrls(config: Config): OriginUrls {
  return sourceUrls(config, config.syncSource);
}

export class OfficialClient {
  constructor(private readonly config: Config, private readonly fetchImpl: FetchLike = globalFetch) {}

  private url(path: string): string {
    return new URL(path, `${this.config.officialOrigin}/`).toString();
  }

  get urls(): OriginUrls {
    return originUrls(this.config);
  }

  private async request(target: string, label: string, init: RequestInit = {}, timeoutMs = 120_000): Promise<Response> {
    const signal = init.signal ?? AbortSignal.timeout(timeoutMs);
    const response = await this.fetchImpl(target, {
      ...init,
      signal,
      // `redirect: 'error'` is not implemented by workerd; refuse redirects
      // explicitly instead of following them silently.
      redirect: 'manual',
      headers: { accept: 'application/json', ...(init.headers as Record<string, string> | undefined) },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      throw new OfficialError(`${label} redirected (${response.status}${location ? ` → ${location}` : ''})`);
    }
    return response;
  }

  private async fetchWithFallback(
    getUrl: (urls: OriginUrls) => string,
    label: string,
    init: RequestInit = {},
    timeoutMs = 120_000,
  ): Promise<Response> {
    const primaryUrls = sourceUrls(this.config, this.config.syncSource);
    const fallbackSource = this.config.syncSource === 'cdn' ? 'api' : 'cdn';
    const fallbackUrls = sourceUrls(this.config, fallbackSource);
    const primaryTarget = getUrl(primaryUrls);
    const fallbackTarget = getUrl(fallbackUrls);

    let lastError: unknown;
    try {
      const res = await this.request(primaryTarget, `${label} (${this.config.syncSource})`, init, timeoutMs);
      if (res.ok) return res;
      // 5xx errors (e.g. Cloudflare 520, 522, 526) mean the source has TLS or connectivity issues.
      // Automatically fallback to the alternative source so sync never stalls!
      if (res.status >= 500) {
        await res.body?.cancel();
      } else {
        await res.body?.cancel();
        throw new OfficialError(`${label} responded ${res.status}`, res.status);
      }
    } catch (err: unknown) {
      if (err instanceof OfficialError && err.status && err.status < 500) {
        throw err;
      }
      lastError = err;
    }

    try {
      const fallbackRes = await this.request(fallbackTarget, `${label} (${fallbackSource} fallback)`, init, timeoutMs);
      if (fallbackRes.ok) return fallbackRes;
      await fallbackRes.body?.cancel();
      throw new OfficialError(`${label} failed on primary and fallback (${fallbackRes.status})`, fallbackRes.status);
    } catch (fallbackErr) {
      if (lastError) throw lastError;
      throw fallbackErr;
    }
  }

  async fetchCatalog(): Promise<OfficialCatalog> {
    const response = await this.fetchWithFallback((urls) => urls.catalog, 'catalog', {}, TIMEOUTS.catalog);
    const payload = (await response.json()) as OfficialCatalog;
    if (!payload || payload.success !== true || !Array.isArray(payload.songs)) {
      throw new OfficialError('official catalog payload is not a valid song list');
    }
    for (const song of payload.songs) {
      if (
        !song ||
        typeof song.id !== 'string' ||
        typeof song.archiveHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(song.archiveHash)
      ) {
        throw new OfficialError('official catalog contains a song without a usable id/archiveHash');
      }
    }
    return payload;
  }

  async fetchManifest(songId: string): Promise<OfficialManifest> {
    const response = await this.fetchWithFallback(
      (urls) => urls.manifest(songId),
      `manifest ${songId}`,
      {},
      TIMEOUTS.manifest,
    );
    const manifest = (await response.json()) as OfficialManifest;
    if (
      !manifest ||
      manifest.success !== true ||
      manifest.song?.id !== songId ||
      !Array.isArray(manifest.files) ||
      manifest.files.length === 0
    ) {
      throw new OfficialError(`manifest for ${songId} is invalid`);
    }
    for (const file of manifest.files) {
      const expected = `/api/rhydive/assets/${songId}/${file.name
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`;
      if (file.url !== expected) throw new OfficialError(`manifest for ${songId} has an unexpected file url: ${file.url}`);
      if (!Number.isSafeInteger(file.size) || file.size < 0) throw new OfficialError(`bad size for ${file.name}`);
      if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw new OfficialError(`bad sha256 for ${file.name}`);
    }
    const archive = manifest.archive;
    if (!archive || archive.url !== `/api/rhydive/library/${songId}/archive`) {
      throw new OfficialError(`manifest for ${songId} has an unexpected archive url`);
    }
    if (!Number.isSafeInteger(archive.size) || archive.size <= 0 || !/^[a-f0-9]{64}$/.test(archive.sha256)) {
      throw new OfficialError(`manifest for ${songId} has an invalid archive descriptor`);
    }
    return manifest;
  }

  /**
   * Download one asset straight from the configured source. Used when the mirror
   * does not keep a local archive to extract from; every byte is still verified
   * against the manifest's sha256 before it is published.
   */
  async fetchAsset(songId: string, assetName: string, expectedSize: number, timeoutMs = TIMEOUTS.asset): Promise<ArrayBuffer> {
    const response = await this.fetchWithFallback(
      (urls) => urls.asset(songId, assetName),
      `asset ${songId}/${assetName}`,
      { headers: { accept: '*/*' } },
      timeoutMs,
    );
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== expectedSize) {
      throw new OfficialError(
        `asset ${songId}/${assetName} is ${buffer.byteLength} bytes, manifest says ${expectedSize}`,
      );
    }
    return buffer;
  }

  /** Download the official archive exactly as published (byte-for-byte). */
  async fetchArchive(songId: string, expectedSize: number): Promise<ArrayBuffer> {
    const response = await this.fetchWithFallback(
      (urls) => urls.archive(songId),
      `archive ${songId}`,
      { headers: { accept: 'application/zip' } },
      TIMEOUTS.archive,
    );
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared && declared !== expectedSize) {
      await response.body?.cancel();
      throw new OfficialError(`archive for ${songId} declares ${declared} bytes, manifest says ${expectedSize}`);
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== expectedSize) {
      throw new OfficialError(
        `archive for ${songId} is ${buffer.byteLength} bytes, manifest says ${expectedSize}`,
      );
    }
    return buffer;
  }
}
