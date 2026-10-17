/**
 * Runtime configuration for the RhyDive mirror worker.
 *
 * Everything that can change between deployments lives here so the rest of the
 * code only ever sees a resolved, typed `Config` object.
 */

/** Which assets are materialised into R2 while a song is synced. */
export type AssetMode =
  /** Extract and store every archive entry. Fastest to serve, ~2x storage. */
  | 'all'
  /** Store only the hand-picked hot files (cover/audio/beatmap); others lazily. */
  | 'hot'
  /** Store the archive only; every asset is extracted on first request. */
  | 'lazy';

/**
 * Where the sync engine reads official artifacts from.
 *
 *  - `api` — the canonical server (`sta.lunprin.com`). Always current, but slow
 *    (~70 KB/s for the catalog from the author's network).
 *  - `cdn` — the official download site (`dl.lunprin.com/rhydive/beatmap`).
 *    Measured ~5 MB/s with byte-identical catalog/manifest/archive content.
 */
export type SyncSource = 'api' | 'cdn';

/**
 * How to reconcile the catalog's `archiveHash` with the archive the manifest
 * and the origin actually serve.
 *
 * The two disagree whenever a song is re-uploaded: both official catalogs keep
 * advertising the hash the song was *first* published with (it is embedded in
 * the song id) while `/download` and `/archive` serve the new bytes. Measured
 * on 2026-10-17: 1 of 792 songs, still stale 9 h after the re-upload.
 *
 *  - `manifest` (default) — the manifest is authoritative, because it is what a
 *    client verifies against the bytes it downloads. The mirror publishes the
 *    song with its real hash so its own catalog, manifest and archive agree.
 *  - `strict` — only publish songs whose archive hash equals the catalog's
 *    `archiveHash`; upstream-inconsistent songs are withheld (and reported).
 */
export type HashMode = 'manifest' | 'strict';

/**
 * Where bulk objects (archives and extracted assets) are stored.
 *
 * The catalog, per-song manifests and sync state always live in R2 — they are a
 * few megabytes, are read on every request, and are the source of truth.
 *
 *  - `r2`     — everything in the R2 bucket (default).
 *  - `gdrive` — archives and assets in Google Drive; R2 keeps only metadata.
 *  - `hybrid` — archives and cold assets in Drive, hot assets in R2, so the
 *               interactive paths (cover/audio/beatmap) never touch Drive.
 */
export type StorageLayout = 'r2' | 'gdrive' | 'hybrid';

/**
 * What to do with the per-song archive (the single biggest object).
 *
 *  - `store` (default) — keep the official ZIP in the bulk tier. Required for
 *    the desktop client's "download this song" flow to be served locally.
 *  - `proxy` — never store it; stream it from the configured official source on
 *    demand. Saves ~10 GB of storage at the cost of an origin fetch per
 *    download, which is what makes a 10 GB-free-tier deployment possible.
 */
export type ArchiveMode = 'store' | 'proxy';

/**
 * Where the sync gets the assets it materialises.
 *
 *  - `archive` (default) — download the ZIP once and extract from it. Fewest
 *    origin requests, guarantees assets match the archive.
 *  - `origin` — fetch each wanted asset individually and verify it against the
 *    manifest's sha256. Much less traffic when only a few assets are stored
 *    (`SYNC_ASSET_MODE=hot`), and no decompression CPU.
 */
export type AssetSource = 'archive' | 'origin';

export interface Env {
  /** R2 bucket holding the mirrored chart surface. */
  MIRROR: R2Bucket;
  /** Official API origin. Defaults to https://sta.lunprin.com */
  OFFICIAL_ORIGIN?: string;
  /** Official download-site origin, used for the /rhydive/* mirror surface. */
  OFFICIAL_CDN_ORIGIN?: string;
  /** Shared secret required by /__admin/*. When unset the admin surface is closed. */
  SYNC_TOKEN?: string;
  /** Max songs processed per sync tick. */
  SYNC_MAX_SONGS_PER_TICK?: string;
  /** Max wall-clock milliseconds spent syncing per tick. */
  SYNC_BUDGET_MS?: string;
  /** Asset materialisation policy. */
  SYNC_ASSET_MODE?: string;
  /** Where the sync reads official artifacts: "api" (default) or "cdn". */
  SYNC_SOURCE?: string;
  /** Catalog/archive hash reconciliation: "manifest" (default) or "strict". */
  SYNC_HASH_MODE?: string;
  /** Bulk storage backend: "r2" (default), "gdrive" or "hybrid". */
  STORAGE_LAYOUT?: string;
  /** Archive handling: "store" (default) or "proxy". */
  ARCHIVE_MODE?: string;
  /** Where materialised assets come from: "archive" (default) or "origin". */
  SYNC_ASSET_SOURCE?: string;
  /** Google Drive OAuth client id. */
  GDRIVE_CLIENT_ID?: string;
  /** Google Drive OAuth client secret. */
  GDRIVE_CLIENT_SECRET?: string;
  /** Google Drive OAuth refresh token for the account that owns the storage. */
  GDRIVE_REFRESH_TOKEN?: string;
  /** Drive folder that holds the mirror (created ahead of time, shared with the account). */
  GDRIVE_FOLDER_ID?: string;
  /** Set for shared drives; sent as supportsAllDrives on every call. */
  GDRIVE_TEAM_DRIVE_ID?: string;
  /** Override the Google API base (localhost emulators, tests). */
  GDRIVE_API_BASE?: string;
  /** Override the OAuth token endpoint. */
  GDRIVE_TOKEN_URL?: string;
  /** Resumable upload chunk size in MB (e.g. 5, matching OpenList). Default 8 MB. */
  GDRIVE_CHUNK_SIZE_MB?: string;
  /** When "false", /rhydive/* misses are answered with 404 instead of proxied. */
  MIRROR_FALLBACK_PROXY?: string;
  /** When "true", lazy asset extraction also writes the asset back to R2. */
  ASSET_WRITE_THROUGH?: string;
  /** Path prefix that the mirror API is served under. Default: /api/rhydive */
  MIRROR_API_PREFIX?: string;
}

export interface Config {
  officialOrigin: string;
  officialCdnOrigin: string;
  syncToken: string | null;
  maxSongsPerTick: number;
  budgetMs: number;
  assetMode: AssetMode;
  syncSource: SyncSource;
  hashMode: HashMode;
  /** `${officialCdnOrigin}/rhydive/beatmap` — the official download-site root. */
  cdnBeatmapBase: string;
  storageLayout: StorageLayout;
  archiveMode: ArchiveMode;
  assetSource: AssetSource;
  gdrive: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    folderId: string;
    teamDriveId: string | null;
    apiBase: string;
    tokenUrl: string;
    chunkSizeBytes: number;
  } | null;
  mirrorFallbackProxy: boolean;
  assetWriteThrough: boolean;
  apiPrefix: string;
}

export const DEFAULTS = {
  officialOrigin: 'https://sta.lunprin.com',
  officialCdnOrigin: 'https://dl.lunprin.com',
  maxSongsPerTick: 6,
  budgetMs: 20_000,
  assetMode: 'all' as AssetMode,
  syncSource: 'api' as SyncSource,
  hashMode: 'manifest' as HashMode,
  storageLayout: 'r2' as StorageLayout,
  archiveMode: 'store' as ArchiveMode,
  assetSource: 'archive' as AssetSource,
};

/** R2 prefixes. Kept here so the sync writer and the request reader never drift. */
export const KEYS = {
  /** Mirror-scoped catalog served as `/api/rhydive/library`. */
  library: '_catalog/library.json',
  /** Per-song download manifest served as `/api/rhydive/library/<id>/download`. */
  manifest: (id: string) => `_catalog/manifests/${id}.json`,
  /** Sync bookkeeping (not part of the public surface). */
  state: '_catalog/sync-state.json',
  /** Official `archive` object, byte-identical to the official ZIP. */
  archive: (id: string) => `${id}.zip`,
  /** A single extracted archive entry. */
  asset: (id: string, name: string) => `${id}/${name}`,
} as const;

export function resolveConfig(env: Env): Config {
  const mode = (env.SYNC_ASSET_MODE ?? DEFAULTS.assetMode).toLowerCase();
  const source = (env.SYNC_SOURCE ?? DEFAULTS.syncSource).toLowerCase();
  const hashMode = (env.SYNC_HASH_MODE ?? DEFAULTS.hashMode).toLowerCase();
  const layout = (env.STORAGE_LAYOUT ?? DEFAULTS.storageLayout).toLowerCase();
  const archiveMode = (env.ARCHIVE_MODE ?? DEFAULTS.archiveMode).toLowerCase();
  const assetSource = (env.SYNC_ASSET_SOURCE ?? DEFAULTS.assetSource).toLowerCase();
  const officialCdnOrigin = stripTrailingSlash(env.OFFICIAL_CDN_ORIGIN ?? DEFAULTS.officialCdnOrigin);
  return {
    officialOrigin: stripTrailingSlash(env.OFFICIAL_ORIGIN ?? DEFAULTS.officialOrigin),
    officialCdnOrigin,
    cdnBeatmapBase: `${officialCdnOrigin}/rhydive/beatmap`,
    syncToken: env.SYNC_TOKEN && env.SYNC_TOKEN.length > 0 ? env.SYNC_TOKEN : null,
    maxSongsPerTick: clampInt(env.SYNC_MAX_SONGS_PER_TICK, 1, 500, DEFAULTS.maxSongsPerTick),
    budgetMs: clampInt(env.SYNC_BUDGET_MS, 1_000, 600_000, DEFAULTS.budgetMs),
    assetMode: mode === 'hot' || mode === 'lazy' || mode === 'all' ? mode : DEFAULTS.assetMode,
    syncSource: source === 'cdn' ? 'cdn' : DEFAULTS.syncSource,
    hashMode: hashMode === 'strict' ? 'strict' : DEFAULTS.hashMode,
    storageLayout:
      layout === 'gdrive' || layout === 'hybrid' ? layout : DEFAULTS.storageLayout,
    archiveMode: archiveMode === 'proxy' ? 'proxy' : DEFAULTS.archiveMode,
    assetSource: assetSource === 'origin' ? 'origin' : DEFAULTS.assetSource,
    gdrive: resolveGDrive(env),
    mirrorFallbackProxy: env.MIRROR_FALLBACK_PROXY !== 'false',
    assetWriteThrough: env.ASSET_WRITE_THROUGH !== 'false',
    apiPrefix: '/' + (env.MIRROR_API_PREFIX ?? '/api/rhydive').replace(/^\/+|\/+$/g, ''),
  };
}

function resolveGDrive(env: Env): Config['gdrive'] {
  const clientId = env.GDRIVE_CLIENT_ID?.trim();
  const clientSecret = env.GDRIVE_CLIENT_SECRET?.trim();
  const refreshToken = env.GDRIVE_REFRESH_TOKEN?.trim();
  const folderId = env.GDRIVE_FOLDER_ID?.trim();
  if (!clientId && !clientSecret && !refreshToken && !folderId) return null;
  return {
    clientId: clientId ?? '',
    clientSecret: clientSecret ?? '',
    refreshToken: refreshToken ?? '',
    folderId: folderId ?? '',
    teamDriveId: env.GDRIVE_TEAM_DRIVE_ID?.trim() || null,
    apiBase: stripTrailingSlash(env.GDRIVE_API_BASE?.trim() || 'https://www.googleapis.com'),
    tokenUrl: env.GDRIVE_TOKEN_URL?.trim() || 'https://oauth2.googleapis.com/token',
    chunkSizeBytes: clampChunkSize(env.GDRIVE_CHUNK_SIZE_MB),
  };
}

function clampChunkSize(raw: string | undefined): number {
  const mb = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(mb) || mb < 1) return 8 * 1024 * 1024;
  // Google Drive requires chunk size to be a multiple of 256 KiB.
  const units = Math.max(1, Math.min(64, Math.round((mb * 1024) / 256)));
  return units * 256 * 1024;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
