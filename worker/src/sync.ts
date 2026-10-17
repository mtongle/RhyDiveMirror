/**
 * The sync engine.
 *
 * One "tick" is deliberately small and resumable: it refreshes the catalog,
 * then materialises as many pending songs as the budget allows, then rewrites
 * the mirror catalog. State lives in R2, so a truncated or failed tick only
 * costs the songs it did not finish.
 */
import { KEYS, type Config, type Env } from './config';
import { contentTypeFor, isHotAsset } from './assets';
import { globalFetch, type FetchLike } from './fetch';
import { sha256Hex } from './http';
import { SONG_ID_PATTERN, safeEntryName } from './layout';
import { OfficialClient, OfficialError, type OfficialCatalog, type OfficialManifest } from './official';
import { createBulkStore, type BulkStore } from './storage';
import { extractEntry, readCentralDirectory, type ZipEntry } from './zip';
import {
  loadState,
  planPending,
  pruneSongs,
  saveState,
  type SongFailure,
  type SongRecord,
  type SyncError,
  type SyncRun,
  type SyncState,
} from './state';

export interface SyncOptions {
  /** Bulk store to write to; defaults to one built from the configuration. */
  store?: BulkStore;
  /** Skip the catalog refresh and only drain the existing queue. */
  skipCatalog?: boolean;
  /** Override the per-tick song budget. */
  maxSongs?: number;
  /** Override the per-tick wall-clock budget. */
  budgetMs?: number;
  /** Existing state, to avoid a redundant read. */
  state?: SyncState;
}

export interface SyncResult {
  run: SyncRun;
  state: SyncState;
  catalog: OfficialCatalog | null;
}

export async function runSync(
  env: Env,
  config: Config,
  options: SyncOptions = {},
  fetchImpl: FetchLike = globalFetch,
): Promise<SyncResult> {
  const startedAt = Date.now();
  const state = options.state ?? (await loadState(env.MIRROR));
  const store = options.store ?? createBulkStore(env, config, fetchImpl);
  const client = new OfficialClient(config, fetchImpl);
  const maxSongs = options.maxSongs ?? config.maxSongsPerTick;
  const budgetMs = options.budgetMs ?? config.budgetMs;
  const errors: SyncError[] = [];

  let catalog: OfficialCatalog | null = null;
  let catalogChanged = false;
  const catalogHashes = new Map<string, string>();

  if (!options.skipCatalog) {
    try {
      catalog = await client.fetchCatalog();
      for (const song of catalog.songs) catalogHashes.set(song.id, song.archiveHash);
      const plan = planPending(state, catalog.songs);
      state.catalogFetchedAt = new Date().toISOString();
      state.officialSongCount = catalog.songs.length;
      state.pending = plan.pending;
      state.removed = plan.removed;
      catalogChanged = plan.changed;
    } catch (error) {
      errors.push({ id: '*', message: describe(error), at: new Date().toISOString() });
    }
  } else {
    const cached = await readCachedCatalog(env);
    if (cached) {
      for (const song of cached.songs) catalogHashes.set(song.id, song.archiveHash);
    }
  }

  let processed = 0;
  let failed = 0;
  let deferred = 0;
  const remaining: string[] = [];
  const failures = state.failures ?? (state.failures = {});

  for (const songId of state.pending) {
    if (processed >= maxSongs || Date.now() - startedAt > budgetMs) {
      remaining.push(songId);
      continue;
    }
    // A song that keeps failing upstream is retried with exponential backoff so
    // it cannot starve the budget of healthy songs.
    const failure = failures[songId];
    if (failure && Date.now() - Date.parse(failure.lastAt) < backoffMs(failure.count)) {
      deferred += 1;
      remaining.push(songId);
      continue;
    }
    try {
      const record = await syncSong(env, config, client, songId, catalogHashes.get(songId), store);
      state.songs[songId] = record;
      delete failures[songId];
      processed += 1;
    } catch (error) {
      failed += 1;
      const message = describe(error);
      const now = new Date().toISOString();
      failures[songId] = {
        count: (failure?.count ?? 0) + 1,
        lastError: message,
        lastAt: now,
        catalogHash: catalogHashes.get(songId) ?? failure?.catalogHash ?? '',
      };
      errors.push({ id: songId, message, at: now });
      remaining.push(songId);
    }
  }
  state.pending = remaining;

  // Reclaim songs that vanished upstream.
  if (state.removed.length > 0) {
    await cleanupRemoved(env, store, state, maxSongs * 2);
  }

  let repaired = 0;
  if (catalog) {
    ({ repaired } = await writeMirrorCatalog(env, catalog, state, config.hashMode));
  } else if (catalogChanged || Object.keys(state.songs).length !== state.officialSongCount) {
    // Catalog fetch failed but we may still have a cached catalog to re-scope.
    const cached = await readCachedCatalog(env);
    if (cached) ({ repaired } = await writeMirrorCatalog(env, cached, state, config.hashMode));
  }

  const run: SyncRun = {
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    processed,
    failed,
    deferred,
    repaired,
    catalogFetched: catalog !== null,
    catalogChanged,
    errors: errors.slice(0, 25),
  };
  state.lastRun = run;
  await saveState(env.MIRROR, state);

  return { run, state, catalog };
}

/** Materialise one song: archive + manifest + assets. */
export async function syncSong(
  env: Env,
  config: Config,
  client: OfficialClient,
  songId: string,
  catalogHash?: string,
  store: BulkStore = createBulkStore(env, config),
): Promise<SongRecord> {
  if (!SONG_ID_PATTERN.test(songId)) throw new Error(`refusing to sync invalid song id: ${songId}`);

  const manifest = await client.fetchManifest(songId);
  const storeArchive = config.archiveMode === 'store';
  const wanted = manifest.files.filter((file) => shouldStoreAsset(config, file.name));

  // An archive is fetched when it must be stored, or when the assets are to be
  // extracted from it; `origin` asset sourcing avoids the download entirely.
  const needArchive = storeArchive || config.assetSource === 'archive';
  let archiveBytes: ArrayBuffer | null = null;
  let archiveHash = manifest.archive.sha256;
  let byName: Map<string, ZipEntry> | null = null;
  if (needArchive) {
    archiveBytes = await ensureArchive(store, config, client, songId, manifest);
    archiveHash = await sha256Hex(archiveBytes);
    if (archiveHash !== manifest.archive.sha256) {
      throw new Error(`archive sha256 mismatch for ${songId}: ${archiveHash} != ${manifest.archive.sha256}`);
    }
    const entries = readCentralDirectory(new Uint8Array(archiveBytes));
    byName = new Map(entries.map((entry) => [entry.name, entry]));
    // Check entry name security and entry presence before publishing
    for (const file of manifest.files) {
      if (!safeEntryName(file.name)) throw new Error(`manifest contains unsafe file name: ${file.name}`);
      if (!byName.has(file.name)) throw new Error(`archive for ${songId} is missing manifest entry ${file.name}`);
    }
  }

  let extracted: { name: string; bytes: Uint8Array }[] = [];
  if (config.assetMode !== 'lazy' && wanted.length > 0) {
    if (config.assetSource === 'origin') {
      extracted = await fetchWantedFromOrigin(client, songId, wanted);
    } else {
      extracted = await extractWanted(archiveBytes!, wanted, byName!);
    }
  }

  // Publish: manifest first (it describes the archive), then the archive, then assets.
  await env.MIRROR.put(KEYS.manifest(songId), JSON.stringify(manifest), {
    httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'public, max-age=60' },
  });
  if (storeArchive) await putArchive(store, songId, archiveBytes!, archiveHash);

  let storedAssetBytes = 0;
  await mapLimit(extracted, 8, async (item) => {
    await store.put(KEYS.asset(songId, item.name), item.bytes, {
      contentType: contentTypeFor(item.name),
      cacheControl: 'public, max-age=31536000, immutable',
    });
    storedAssetBytes += item.bytes.byteLength;
  });
  let assetBytes = 0;
  for (const file of manifest.files) assetBytes += file.size;

  return {
    archiveHash,
    catalogHash: catalogHash ?? archiveHash,
    zipBytes: archiveBytes?.byteLength ?? manifest.archive.size,
    files: manifest.files.length,
    assetBytes,
    storedAssetBytes,
    materialized: config.assetMode,
    syncedAt: new Date().toISOString(),
    title: manifest.song.title ?? songId,
  };
}

function shouldStoreAsset(config: Config, name: string): boolean {
  if (config.assetMode === 'all') return true;
  if (config.assetMode === 'hot') return isHotAsset(name);
  return false;
}

/** Fetch each wanted asset from the origin and verify it against the manifest. */
async function fetchWantedFromOrigin(
  client: OfficialClient,
  songId: string,
  wanted: { name: string; sha256: string; size: number }[],
): Promise<{ name: string; bytes: Uint8Array }[]> {
  const out: { name: string; bytes: Uint8Array }[] = [];
  for (const file of wanted) {
    const buffer = await client.fetchAsset(songId, file.name, file.size);
    const bytes = new Uint8Array(buffer);
    const digest = await sha256Hex(bytes);
    if (digest !== file.sha256) throw new Error(`asset ${songId}/${file.name} sha256 mismatch`);
    out.push({ name: file.name, bytes });
  }
  return out;
}

async function extractWanted(
  archiveBytes: ArrayBuffer,
  wanted: { name: string; sha256: string; size: number }[],
  byName: Map<string, ZipEntry>,
): Promise<{ name: string; bytes: Uint8Array }[]> {
  const view = new Uint8Array(archiveBytes);
  const out: { name: string; bytes: Uint8Array }[] = [];
  for (const file of wanted) {
    const entry = byName.get(file.name);
    if (!entry) throw new Error(`archive is missing manifest entry ${file.name}`);
    const bytes = await extractEntry(view, entry);
    if (bytes.byteLength !== file.size) {
      throw new Error(`entry ${file.name} is ${bytes.byteLength} bytes, manifest says ${file.size}`);
    }
    const digest = await sha256Hex(bytes);
    if (digest !== file.sha256) throw new Error(`entry ${file.name} sha256 mismatch`);
    out.push({ name: file.name, bytes });
  }
  return out;
}

async function putArchive(store: BulkStore, songId: string, bytes: ArrayBuffer, sha256: string): Promise<void> {
  await store.put(KEYS.archive(songId), bytes, {
    contentType: 'application/zip',
    cacheControl: 'public, max-age=31536000, immutable',
    customMetadata: { sha256 },
  });
}

/**
 * Return the archive bytes, reusing the stored object when its recorded digest
 * matches. This makes a retry after a partial extraction cheap.
 */
async function ensureArchive(
  store: BulkStore,
  _config: Config,
  client: OfficialClient,
  songId: string,
  manifest: OfficialManifest,
): Promise<ArrayBuffer> {
  const head = await store.head(KEYS.archive(songId)).catch(() => null);
  if (head && head.customMetadata?.sha256 === manifest.archive.sha256 && head.size === manifest.archive.size) {
    const object = await store.get(KEYS.archive(songId));
    if (object) return object.arrayBuffer();
  }
  return client.fetchArchive(songId, manifest.archive.size);
}

/**
 * Rewrite the catalog to advertise exactly the songs that are fully mirrored.
 *
 * In `manifest` mode a song whose official `archiveHash` is stale (re-uploaded
 * upstream without the catalog being refreshed) is published with the hash of
 * the bytes the mirror actually serves, so the mirror's catalog, manifest and
 * archive always agree. In `strict` mode such songs are withheld instead.
 */
export async function writeMirrorCatalog(
  env: Env,
  catalog: OfficialCatalog,
  state: SyncState,
  hashMode: Config['hashMode'] = 'manifest',
): Promise<{ mirrored: number; repaired: number }> {
  let repaired = 0;
  const songs: OfficialCatalog['songs'] = [];
  for (const song of catalog.songs) {
    const record = state.songs[song.id];
    if (!record) continue;
    if (record.archiveHash === song.archiveHash) {
      songs.push(song);
      continue;
    }
    if (hashMode === 'strict') continue;
    repaired += 1;
    songs.push({ ...song, archiveHash: record.archiveHash });
  }
  const payload: OfficialCatalog = { success: true, songs };
  await env.MIRROR.put(KEYS.library, JSON.stringify(payload), {
    httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'public, max-age=60' },
    customMetadata: {
      mirrored: String(songs.length),
      official: String(catalog.songs.length),
      repaired: String(repaired),
      writtenAt: new Date().toISOString(),
    },
  });
  return { mirrored: songs.length, repaired };
}

async function readCachedCatalog(env: Env): Promise<OfficialCatalog | null> {
  const object = await env.MIRROR.get(KEYS.library);
  if (!object) return null;
  try {
    const parsed = JSON.parse(await object.text()) as OfficialCatalog;
    return parsed && Array.isArray(parsed.songs) ? parsed : null;
  } catch {
    return null;
  }
}

async function cleanupRemoved(env: Env, store: BulkStore, state: SyncState, budget: number): Promise<void> {
  const done: string[] = [];
  for (const songId of state.removed) {
    if (done.length >= budget) break;
    try {
      // The manifest still lists every object, so no bucket listing is needed
      // (which matters on Drive, where listing means paging the whole folder).
      const names: string[] = [];
      const manifestObject = await env.MIRROR.get(KEYS.manifest(songId));
      if (manifestObject) {
        const manifest = (await manifestObject.json()) as OfficialManifest;
        for (const file of manifest.files ?? []) names.push(KEYS.asset(songId, file.name));
      }
      if (names.length > 0) await store.delete(names);
      await store.delete([KEYS.archive(songId)]);
      await env.MIRROR.delete([KEYS.manifest(songId)]);
      done.push(songId);
    } catch {
      // Leave it queued; the next tick retries.
    }
  }
  if (done.length > 0) {
    pruneSongs(state, done);
    const completed = new Set(done);
    state.removed = state.removed.filter((id) => !completed.has(id));
  }
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 1 min doubling per failure, capped at 6 h. */
export function backoffMs(count: number): number {
  return Math.min(6 * 3_600_000, 60_000 * 2 ** Math.min(Math.max(count - 1, 0), 9));
}

function describe(error: unknown): string {
  if (error instanceof OfficialError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
