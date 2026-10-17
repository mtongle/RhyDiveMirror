/**
 * Sync bookkeeping.
 *
 * A single small JSON document in R2 tracks which songs are mirrored, which are
 * queued, and what the last tick did. It is internal state, never served to
 * clients.
 */
import { KEYS } from './config';

export const STATE_VERSION = 1;

export interface SongRecord {
  /** sha256 of the stored archive — what the manifest advertises and we serve. */
  archiveHash: string;
  /**
   * `archiveHash` the official catalog advertised when this song was synced.
   * Differs from `archiveHash` for songs that were re-uploaded upstream without
   * the catalog being refreshed.
   */
  catalogHash?: string;
  /** Bytes of the stored archive (always materialised). */
  zipBytes: number;
  files: number;
  /** Logical size of every asset the client may download. */
  assetBytes: number;
  /** Asset bytes actually written to R2 during sync (0 in `lazy` mode). */
  storedAssetBytes: number;
  /** Which extraction policy succeeded for this song. */
  materialized: 'all' | 'hot' | 'lazy';
  syncedAt: string;
  title: string;
}

export interface SyncError {
  id: string;
  message: string;
  at: string;
}

export interface SongFailure {
  count: number;
  lastError: string;
  lastAt: string;
  /** Catalog hash observed at the last attempt, used to detect upstream changes. */
  catalogHash: string;
}

export interface SyncRun {
  startedAt: string;
  finishedAt: string;
  processed: number;
  failed: number;
  /** Songs skipped because they are in retry backoff. */
  deferred?: number;
  /** Songs published with a hash corrected against the stale official catalog. */
  repaired?: number;
  catalogFetched: boolean;
  catalogChanged: boolean;
  errors: SyncError[];
}

export interface SyncState {
  version: number;
  catalogFetchedAt: string | null;
  officialSongCount: number;
  /** Mirrored songs, keyed by song id. */
  songs: Record<string, SongRecord>;
  /** Song ids queued for (re)sync, in official catalog order. */
  pending: string[];
  /** Song ids no longer present upstream and awaiting cleanup. */
  removed: string[];
  /** Per-song failure bookkeeping, keyed by song id (drives retry backoff). */
  failures?: Record<string, SongFailure>;
  lastRun: SyncRun | null;
}

export function emptyState(): SyncState {
  return {
    version: STATE_VERSION,
    catalogFetchedAt: null,
    officialSongCount: 0,
    songs: {},
    pending: [],
    removed: [],
    failures: {},
    lastRun: null,
  };
}

export async function loadState(bucket: R2Bucket): Promise<SyncState> {
  const object = await bucket.get(KEYS.state);
  if (!object) return emptyState();
  try {
    const parsed = JSON.parse(await object.text()) as SyncState;
    if (!parsed || typeof parsed !== 'object' || parsed.version !== STATE_VERSION) return emptyState();
    return {
      ...emptyState(),
      ...parsed,
      songs: parsed.songs ?? {},
      pending: parsed.pending ?? [],
      removed: parsed.removed ?? [],
      failures: parsed.failures ?? {},
    };
  } catch {
    return emptyState();
  }
}

export async function saveState(bucket: R2Bucket, state: SyncState): Promise<void> {
  await bucket.put(KEYS.state, JSON.stringify(state), {
    httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' },
  });
}

/**
 * Reconcile the mirrored index against a freshly fetched official catalog.
 * Returns the ids that still need work, in official order.
 */
export function planPending(
  state: SyncState,
  songs: { id: string; archiveHash: string }[],
): { pending: string[]; removed: string[]; changed: boolean } {
  const upstream = new Map(songs.map((song) => [song.id, song.archiveHash]));
  const pending: string[] = [];
  const failures = state.failures ?? (state.failures = {});
  for (const song of songs) {
    const failure = failures[song.id];
    // A changed catalog hash means upstream touched the song: clear the backoff.
    if (failure && failure.catalogHash !== song.archiveHash) delete failures[song.id];
    const record = state.songs[song.id];
    const known = record && (record.catalogHash === song.archiveHash || record.archiveHash === song.archiveHash);
    if (!known) pending.push(song.id);
  }
  const removed = Object.keys(state.songs).filter((id) => !upstream.has(id));
  const changed =
    pending.length > 0 ||
    removed.length > 0 ||
    songs.length !== state.officialSongCount ||
    Object.keys(state.songs).length !== songs.length - pending.length;
  return { pending, removed, changed };
}

export function pruneSongs(state: SyncState, ids: string[]): void {
  for (const id of ids) delete state.songs[id];
}
