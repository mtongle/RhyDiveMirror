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
  loadStateWithVersion,
  planPending,
  pruneSongs,
  saveState,
  SyncBusyError,
  type SongFailure,
  type SongRecord,
  type RetiredGeneration,
  type SyncLease,
  type SyncError,
  type SyncRun,
  type SyncState,
} from './state';

const LEASE_SKEW_MS = 5_000;

export async function readSyncLease(bucket: R2Bucket): Promise<SyncLease | null> {
  const object = await bucket.get(KEYS.syncLock);
  if (!object) return null;
  try {
    const lease = JSON.parse(await object.text()) as SyncLease;
    return lease && typeof lease.owner === 'string' ? lease : null;
  } catch {
    return null;
  }
}

/**
 * Acquire a small R2-backed lease before touching sync state. R2 conditional
 * writes make this atomic even when cron and an operator invoke sync at once.
 */
export async function acquireSyncLease(bucket: R2Bucket, owner: string, ttlMs: number): Promise<SyncLease> {
  const now = Date.now();
  const lease: SyncLease = {
    owner,
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + Math.max(ttlMs, 30_000)).toISOString(),
  };
  const current = await bucket.head(KEYS.syncLock);
  const body = JSON.stringify(lease);
  if (!current) {
    const result = await bucket.put(KEYS.syncLock, body, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' },
    });
    if (result) return lease;
  } else {
    const existing = await readSyncLease(bucket);
    if (existing && Date.parse(existing.expiresAt) > now + LEASE_SKEW_MS) throw new SyncBusyError(existing);
    const result = await bucket.put(KEYS.syncLock, body, {
      onlyIf: { etagMatches: current.etag },
      httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' },
    });
    if (result) return lease;
  }
  throw new SyncBusyError(await readSyncLease(bucket));
}

/** Free-plan Workers have a hard per-invocation subrequest quota. */
export function isSubrequestLimitError(error: unknown): boolean {
  return /too many subrequests/i.test(error instanceof Error ? error.message : String(error));
}

export async function releaseSyncLease(bucket: R2Bucket, owner: string): Promise<void> {
  const current = await readSyncLease(bucket);
  if (current?.owner === owner) await bucket.delete(KEYS.syncLock);
}

const MIN_LEASE_MS = 15 * 60_000 + 60_000;

function leaseTtlMs(config: Config): number {
  // A single archive request can take up to 15 minutes. The lease must not
  // expire while that request is still advancing a song.
  return Math.max(config.budgetMs * 3, MIN_LEASE_MS);
}

export async function renewSyncLease(bucket: R2Bucket, owner: string, ttlMs: number): Promise<void> {
  const current = await readSyncLease(bucket);
  if (current?.owner !== owner) throw new SyncBusyError(current);
  const now = Date.now();
  const next: SyncLease = {
    ...current,
    expiresAt: new Date(now + Math.max(ttlMs, 30_000)).toISOString(),
  };
  const object = await bucket.head(KEYS.syncLock);
  if (!object) throw new SyncBusyError(null);
  const result = await bucket.put(KEYS.syncLock, JSON.stringify(next), {
    onlyIf: { etagMatches: object.etag },
    httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' },
  });
  if (!result) throw new SyncBusyError(await readSyncLease(bucket));
}

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
  /** ETag paired with `state`; omit only when the caller owns the state read. */
  stateEtag?: string | null;
  /** Owner id for the sync lease; normally supplied by acquireSyncLease. */
  owner?: string;
  /** Set false only for tests that call runSync in isolation. */
  lock?: boolean;
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
  if (options.lock === false) return runSyncUnlocked(env, config, options, fetchImpl, null);
  const owner = options.owner ?? crypto.randomUUID();
  await acquireSyncLease(env.MIRROR, owner, leaseTtlMs(config));
  try {
    return await runSyncUnlocked(env, config, { ...options, owner }, fetchImpl, owner);
  } finally {
    await releaseSyncLease(env.MIRROR, owner).catch(() => undefined);
  }
}

async function runSyncUnlocked(
  env: Env,
  config: Config,
  options: SyncOptions,
  fetchImpl: FetchLike,
  lockOwner: string | null,
): Promise<SyncResult> {
  const startedAt = Date.now();
  const loaded = options.state
    ? { state: options.state, etag: options.stateEtag ?? (await currentStateEtag(env.MIRROR)) }
    : await loadStateWithVersion(env.MIRROR);
  const state = loaded.state;
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
      const previous = state.songs[songId];
      const record = await syncSong(env, config, client, songId, catalogHashes.get(songId), store);
      if (previous && previous.archiveHash !== record.archiveHash) {
        state.retired.push(toRetired(songId, previous));
      }
      state.songs[songId] = record;
      delete failures[songId];
      processed += 1;
    } catch (error) {
      if (isSubrequestLimitError(error)) {
        // The remaining songs were not attempted. Stop this invocation without
        // putting them into failure backoff; the next drain can continue them.
        remaining.push(songId);
        errors.push({
          id: '*',
          message: 'subrequest budget exhausted; stopped this tick before the remaining songs',
          at: new Date().toISOString(),
        });
        const at = state.pending.indexOf(songId);
        if (at >= 0) {
          for (const rest of state.pending.slice(at + 1)) remaining.push(rest);
        }
        break;
      }
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
  // A generation retired by this tick may still be referenced by a reader that
  // fetched the previous pointer moments ago. Reclaim it on a later tick.
  await cleanupRetired(env, store, state, maxSongs * 4, errors, startedAt);

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
  if (lockOwner) {
    await renewSyncLease(env.MIRROR, lockOwner, leaseTtlMs(config));
  }
  await saveState(env.MIRROR, state, loaded.etag);

  return { run, state, catalog };
}

function toRetired(songId: string, record: SongRecord): RetiredGeneration {
  return {
    songId,
    archiveHash: record.archiveHash,
    archiveKey: record.archiveKey ?? KEYS.archive(songId),
    manifestKey: KEYS.manifestVersion(songId, record.archiveHash),
    assetKeys: Object.values(record.assetKeys ?? {}),
    storageKind: record.storageKind,
    retiredAt: new Date().toISOString(),
  };
}

async function cleanupRetired(
  env: Env,
  store: BulkStore,
  state: SyncState,
  budget: number,
  errors: SyncError[],
  notBefore: number,
): Promise<void> {
  const kept: RetiredGeneration[] = [];
  let removed = 0;
  for (const item of state.retired) {
    if (Date.parse(item.retiredAt) >= notBefore) {
      kept.push(item);
      continue;
    }
    if (removed >= budget) {
      kept.push(item);
      continue;
    }
    try {
      const keys = [item.archiveKey, ...item.assetKeys];
      if (store.deleteEverywhere) await store.deleteEverywhere(keys);
      else await store.delete(keys);
      await env.MIRROR.delete(item.manifestKey);
      removed += 1;
    } catch (error) {
      kept.push(item);
      errors.push({ id: item.songId, message: `retired generation cleanup failed: ${describe(error)}`, at: new Date().toISOString() });
    }
  }
  state.retired = kept;
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
    const manifestNames = new Set(manifest.files.map((file) => file.name.toLowerCase()));
    const archiveNames = new Set(entries.filter((entry) => !entry.name.endsWith('/')).map((entry) => entry.name.toLowerCase()));
    if (entries.length !== manifest.files.length || archiveNames.size !== manifestNames.size) {
      throw new Error(
        `archive entry set mismatch for ${songId}: archive=${entries.length} manifest=${manifest.files.length}`,
      );
    }
    // Check entry name security and exact entry set before publishing.
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

  let storedAssetBytes = 0;
  const assetKeys: Record<string, string> = {};
  const assetPaths: Record<string, string> = {};
  const archiveKey = storeArchive ? KEYS.archiveVersion(songId, archiveHash) : KEYS.archive(songId);
  const manifestKey = KEYS.manifestVersion(songId, archiveHash);
  const manifestPath = `/api/rhydive/library/${encodeURIComponent(songId)}/download`;
  const archivePath = `/api/rhydive/library/${encodeURIComponent(songId)}/archive`;
  const newlyWritten: string[] = [];
  let committed = false;
  try {
    await mapLimit(extracted, 8, async (item) => {
      const key = KEYS.assetVersion(songId, archiveHash, item.name);
      const options = {
        contentType: contentTypeFor(item.name),
        cacheControl: 'public, max-age=31536000, immutable' as const,
      };
      await store.put(key, item.bytes, options);
      newlyWritten.push(key);
      assetKeys[item.name] = key;
      assetPaths[item.name] = `/api/rhydive/assets/${encodeURIComponent(songId)}/${item.name
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`;
      storedAssetBytes += item.bytes.byteLength;
    });
    if (storeArchive) {
      await putArchive(store, songId, archiveBytes!, archiveHash, archiveKey);
      newlyWritten.push(archiveKey);
    }

  // The immutable objects are complete before anything becomes reachable.
  // The generation pointer is the commit record: write it before the mutable
  // legacy paths so a crash at any point leaves either the previous generation
  // or a fully prepared new one.
  const current = {
    archiveHash,
    archiveKey,
    manifestKey,
    archivePath,
    manifestPath,
    assetPaths,
    assetKeys,
    publishedAt: new Date().toISOString(),
  };
    await env.MIRROR.put(manifestKey, JSON.stringify(manifest), {
      httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'public, max-age=31536000, immutable' },
    });
    newlyWritten.push(manifestKey);
    await env.MIRROR.put(KEYS.current(songId), JSON.stringify(current), {
      httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' },
    });
    committed = true;
  } finally {
    if (!committed && newlyWritten.length > 0) {
      const cleanup = store.deleteEverywhere ? store.deleteEverywhere(newlyWritten) : store.delete(newlyWritten);
      await cleanup.catch(() => undefined);
      await env.MIRROR.delete(newlyWritten.filter((key) => key.startsWith('_catalog/'))).catch(() => undefined);
    }
  }
  // Compatibility mirror for older readers/tools. Failures here cannot
  // invalidate the committed generation.
  await env.MIRROR.put(KEYS.manifest(songId), JSON.stringify(manifest), {
    httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'public, max-age=60' },
  }).catch(() => undefined);
  let assetBytes = 0;
  for (const file of manifest.files) assetBytes += file.size;
  const storedByTier: Record<string, number> = {};
  const addBytes = (tier: string, bytes: number) => {
    storedByTier[tier] = (storedByTier[tier] ?? 0) + bytes;
  };
  for (const [name, key] of Object.entries(assetKeys)) {
    const file = manifest.files.find((candidate) => candidate.name === name);
    if (file) addBytes(store.tierOf?.(key) ?? store.kind, file.size);
  }
  if (storeArchive) addBytes(store.tierOf?.(archiveKey) ?? store.kind, archiveBytes?.byteLength ?? manifest.archive.size);

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
    storedBytes: Object.values(storedByTier).reduce((total, bytes) => total + bytes, 0),
    storedByTier,
    storageKind: store.kind,
    manifestPath,
    archivePath,
    assetPaths,
    archiveKey,
    assetKeys,
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

async function putArchive(
  store: BulkStore,
  songId: string,
  bytes: ArrayBuffer,
  sha256: string,
  key: string = KEYS.archive(songId),
): Promise<void> {
  await store.put(key, bytes, {
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
      const record = state.songs[songId];
      const manifestObject = await env.MIRROR.get(KEYS.manifest(songId));
      if (manifestObject) {
        const manifest = (await manifestObject.json()) as OfficialManifest;
        for (const file of manifest.files ?? []) names.push(KEYS.asset(songId, file.name));
      }
      if (record?.assetKeys) names.push(...Object.values(record.assetKeys));
      const manifests = [KEYS.manifest(songId)];
      if (record?.archiveHash) manifests.push(KEYS.manifestVersion(songId, record.archiveHash));
      // Delete bulk objects first. If any operation fails, retain the stable
      // manifest and pointer so the next tick can reconstruct this cleanup.
      const keys = names.concat(record?.archiveKey ? [KEYS.archive(songId), record.archiveKey] : [KEYS.archive(songId)]);
      if (store.deleteEverywhere) await store.deleteEverywhere(keys);
      else await store.delete(keys);
      await env.MIRROR.delete(manifests);
      await env.MIRROR.delete([KEYS.current(songId)]);
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

async function currentStateEtag(bucket: R2Bucket): Promise<string | null> {
  const object = await bucket.head(KEYS.state);
  return object?.etag ?? null;
}
