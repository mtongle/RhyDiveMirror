/**
 * Operator surface (`/__admin/*`).
 *
 * Closed unless `SYNC_TOKEN` is configured. Used by the scheduled handler's
 * manual equivalent, by the bulk-seeding script in `tools/`, and for health
 * inspection of the mirrored set.
 */
import type { Config, Env } from './config';
import { globalFetch, type FetchLike } from './fetch';
import { constantTimeEqual, json } from './http';
import { loadState, loadStateWithVersion, replanState, saveState, SyncBusyError } from './state';
import { acquireSyncLease, backoffMs, releaseSyncLease, runSync, writeMirrorCatalog } from './sync';
import { OfficialClient } from './official';
import { createBulkStore } from './storage';

export async function handleAdmin(
  request: Request,
  env: Env,
  config: Config,
  fetchImpl: FetchLike = globalFetch,
): Promise<Response> {
  if (!config.syncToken) return json({ success: false, message: 'admin surface disabled' }, { status: 404 });
  if (!authorized(request, config.syncToken)) {
    return json({ success: false, message: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const action = url.pathname.slice('/__admin/'.length);

  switch (`${request.method} ${action}`) {
    case 'GET status':
      return status(env, config, fetchImpl);
    case 'POST sync':
      return sync(request, env, config, fetchImpl);
    case 'POST catalog':
      return rebuildCatalog(env, config, fetchImpl);
    default:
      return json({ success: false, message: `unknown admin action: ${request.method} ${action}` }, { status: 404 });
  }
}

function authorized(request: Request, token: string): boolean {
  const header = request.headers.get('authorization');
  const bearer = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;
  const candidate = bearer ?? request.headers.get('x-sync-token');
  return candidate != null && constantTimeEqual(candidate, token);
}

async function status(env: Env, config: Config, fetchImpl: FetchLike): Promise<Response> {
  const state = await loadState(env.MIRROR);
  const songs = Object.values(state.songs);
  const assetBytesOf = (song: (typeof songs)[number]) =>
    song.storedAssetBytes ?? (song.materialized === 'lazy' ? 0 : song.assetBytes);
  const storedAssetBytes = songs.reduce((total, song) => total + assetBytesOf(song), 0);
  const storedByTier = songs.reduce<Record<string, number>>((totals, song) => {
    if (song.storedByTier) {
      for (const [tier, bytes] of Object.entries(song.storedByTier)) totals[tier] = (totals[tier] ?? 0) + bytes;
    } else {
      const kind = song.storageKind ?? config.storageLayout;
      totals[kind] = (totals[kind] ?? 0) + (song.storedBytes ?? song.zipBytes + assetBytesOf(song));
    }
    return totals;
  }, {});
  const storage = {
    mirroredSongs: songs.length,
    archiveBytes: songs.reduce((total, song) => total + song.zipBytes, 0),
    storedAssetBytes,
    /** Bytes materialised by sync, split by the backend that actually holds them. */
    storedBytes: Object.values(storedByTier).reduce((total, bytes) => total + bytes, 0),
    storedByTier,
    /** Bytes a client would download for the mirrored set. */
    logicalBytes: songs.reduce((total, song) => total + song.zipBytes + song.assetBytes, 0),
  };
  return json({
    success: true,
    config: {
      officialOrigin: config.officialOrigin,
      officialCdnOrigin: config.officialCdnOrigin,
      cdnBeatmapBase: config.cdnBeatmapBase,
      assetMode: config.assetMode,
      syncSource: config.syncSource,
      hashMode: config.hashMode,
      storageLayout: config.storageLayout,
      archiveMode: config.archiveMode,
      assetSource: config.assetSource,
      maxSongsPerTick: config.maxSongsPerTick,
      budgetMs: config.budgetMs,
      assetWriteThrough: config.assetWriteThrough,
      mirrorFallbackProxy: config.mirrorFallbackProxy,
    },
    catalog: {
      fetchedAt: state.catalogFetchedAt,
      officialSongs: state.officialSongCount,
      mirroredSongs: songs.length,
    },
    queue: { pending: state.pending.length, removed: state.removed.length },
    storage,
    /** Backend-level view: Drive quota, layout, driver identity. */
    tiers: await tierStatus(env, config, fetchImpl),
    lastRun: state.lastRun,
    pendingSample: state.pending.slice(0, 20),
    /** Songs the mirror serves with a corrected hash because the official
     *  catalog still advertises the hash they were first published with. */
    hashRepairs: songs.filter((song) => song.catalogHash && song.catalogHash !== song.archiveHash).length,
    /** Songs in retry backoff, with the reason and attempt count. */
    failures: Object.entries(state.failures ?? {})
      .map(([id, failure]) => ({
        id,
        attempts: failure.count,
        lastError: failure.lastError,
        lastAt: failure.lastAt,
        nextRetryInMs: Math.max(0, backoffMs(failure.count) - (Date.now() - Date.parse(failure.lastAt))),
      }))
      .sort((a, b) => b.attempts - a.attempts)
      .slice(0, 20),
  });
}

async function sync(
  request: Request,
  env: Env,
  config: Config,
  fetchImpl: FetchLike,
): Promise<Response> {
  const url = new URL(request.url);
  const maxSongs = intParam(url, 'songs', config.maxSongsPerTick);
  const budgetMs = intParam(url, 'budgetMs', config.budgetMs);
  const skipCatalog = url.searchParams.get('skipCatalog') === 'true';
  let store;
  try {
    store = createBulkStore(env, config, fetchImpl);
  } catch (error) {
    return json({ success: false, message: describeError(error) }, { status: 500 });
  }
  try {
    const result = await runSync(
      env,
      config,
      { skipCatalog, maxSongs, budgetMs, store },
      fetchImpl,
    );
    return json({ success: true, run: result.run, pending: result.state.pending.length });
  } catch (error) {
    if (error instanceof SyncBusyError) {
      return json(
        {
          success: false,
          code: 'sync_busy',
          message: error.message,
          retryAfterMs: Math.max(1_000, (error.lease ? Date.parse(error.lease.expiresAt) - Date.now() : 5_000)),
        },
        { status: 409, headers: { 'retry-after': '5' } },
      );
    }
    throw error;
  }
}

/** Storage-backend diagnostics; a broken tier must not fail the whole status. */
async function tierStatus(env: Env, config: Config, fetchImpl: FetchLike): Promise<unknown> {
  try {
    return await createBulkStore(env, config, fetchImpl).status?.();
  } catch (error) {
    return { error: describeError(error) };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function rebuildCatalog(env: Env, config: Config, fetchImpl: FetchLike): Promise<Response> {
  const owner = crypto.randomUUID();
  try {
    await acquireSyncLease(env.MIRROR, owner, 120_000);
  } catch (error) {
    if (error instanceof SyncBusyError) {
      return json(
        { success: false, code: 'sync_busy', message: error.message },
        { status: 409, headers: { 'retry-after': '5' } },
      );
    }
    throw error;
  }
  try {
    const loaded = await loadStateWithVersion(env.MIRROR);
    const state = loaded.state;
    const client = new OfficialClient(config, fetchImpl);
    const catalog = await client.fetchCatalog();
    replanState(state, catalog.songs);
    const { mirrored, repaired } = await writeMirrorCatalog(env, catalog, state, config.hashMode);
    await saveState(env.MIRROR, state, loaded.etag);
    return json({ success: true, officialSongs: catalog.songs.length, mirroredSongs: mirrored, repaired });
  } finally {
    await releaseSyncLease(env.MIRROR, owner).catch(() => undefined);
  }
}

function intParam(url: URL, name: string, fallback: number): number {
  const value = Number.parseInt(url.searchParams.get(name) ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
