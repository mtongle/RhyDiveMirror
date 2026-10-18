import { describe, expect, it } from 'vitest';
import { resolveConfig, type Env } from '../src/config';
import { runSync, syncSong } from '../src/sync';
import { OfficialClient } from '../src/official';
import { loadState, loadStateWithVersion, SyncBusyError, saveState } from '../src/state';
import { acquireSyncLease, readSyncLease, releaseSyncLease } from '../src/sync';
import { FakeR2, asR2Bucket } from './helpers/fake-r2';
import { FakeOfficial, type FixtureSong } from './helpers/official';

const songs: FixtureSong[] = [
  {
    id: 'alpha-1',
    title: 'Alpha',
    entries: [
      { name: 'bg.png', data: 'alpha-cover' },
      { name: 'audio.mp3', data: 'alpha-audio'.repeat(50) },
      { name: 'chart.osu', data: 'osu file format v14' },
    ],
  },
  {
    id: 'beta-2',
    title: 'Beta',
    entries: [
      { name: 'bg.jpg', data: 'beta-cover' },
      { name: 'SB/D1.png', data: 'beta-storyboard', store: true },
    ],
  },
];

function harness(overrides: Partial<Env> = {}) {
  const bucket = new FakeR2();
  const official = new FakeOfficial({ songs: songs.map((song) => ({ ...song, entries: [...song.entries] })) });
  const env: Env = {
    MIRROR: asR2Bucket(bucket),
    OFFICIAL_ORIGIN: official.origin,
    OFFICIAL_CDN_ORIGIN: official.cdnOrigin,
    ...overrides,
  };
  const config = resolveConfig(env);
  const fetchImpl = official.fetch as unknown as typeof fetch;
  return { bucket, official, env, config, fetchImpl };
}

describe('runSync', () => {
  it('serialises overlapping runs with a conditional lease', async () => {
    const { bucket, env, config, fetchImpl } = harness();
    await acquireSyncLease(env.MIRROR, 'owner-a', 60_000);
    await expect(runSync(env, config, {}, fetchImpl)).rejects.toBeInstanceOf(SyncBusyError);
    await releaseSyncLease(env.MIRROR, 'owner-a');
    expect((await runSync(env, config, {}, fetchImpl)).run.processed).toBe(2);
    expect(bucket.has('_catalog/sync-lock.json')).toBe(false);
  });

  it('takes over an expired lease', async () => {
    const { bucket, env, config, fetchImpl } = harness();
    await bucket.put(
      '_catalog/sync-lock.json',
      JSON.stringify({ owner: 'stale', acquiredAt: new Date(0).toISOString(), expiresAt: new Date(0).toISOString() }),
    );
    expect((await runSync(env, config, {}, fetchImpl)).run.processed).toBe(2);
    expect(bucket.has('_catalog/sync-lock.json')).toBe(false);
  });

  it('bounds the recovery lease even when the tick budget is large', async () => {
    const { bucket, env, config, fetchImpl } = harness();
    let observed = 0;
    const fetchImplWithProbe = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const lease = await readSyncLease(env.MIRROR);
      if (lease) observed = Math.max(observed, Date.parse(lease.expiresAt) - Date.now());
      return fetchImpl(input, init);
    }) as typeof fetch;
    await runSync(env, { ...config, budgetMs: 600_000 }, {}, fetchImplWithProbe);
    expect(observed).toBeGreaterThan(30_000);
    expect(observed).toBeLessThanOrEqual(125_000);
    expect(bucket.has('_catalog/sync-lock.json')).toBe(false);
  });

  it('refuses to overwrite newer state from a stale snapshot', async () => {
    const { bucket, env } = harness();
    const initial = await loadStateWithVersion(env.MIRROR);
    const stale = initial.state;
    stale.officialSongCount = 1;
    await saveState(env.MIRROR, stale, initial.etag);
    const staleEtag = bucket.etag('_catalog/sync-state.json');
    const current = await loadStateWithVersion(env.MIRROR);
    current.state.officialSongCount = 3;
    await saveState(env.MIRROR, current.state, current.etag);

    stale.officialSongCount = 2;
    await expect(saveState(env.MIRROR, stale, staleEtag)).rejects.toThrow(
      /changed while this run was active/,
    );
    expect(bucket.json<{ officialSongCount: number }>('_catalog/sync-state.json').officialSongCount).toBe(3);
  });

  it('mirrors the archive, the manifest and every asset, then advertises only complete songs', async () => {
    const { bucket, official, env, config, fetchImpl } = harness();
    const { run, state } = await runSync(env, config, {}, fetchImpl);

    expect(run.catalogFetched).toBe(true);
    expect(run.processed).toBe(2);
    expect(run.failed).toBe(0);
    expect(Object.keys(state.songs).sort()).toEqual(['alpha-1', 'beta-2']);

    // archives, generation manifests and extracted assets are all present
    const alpha = bucket.generation('alpha-1');
    const beta = bucket.generation('beta-2');
    expect(bucket.has(alpha.archiveKey)).toBe(true);
    expect(bucket.has(beta.archiveKey)).toBe(true);
    expect(bucket.has(alpha.manifestKey)).toBe(true);
    expect(bucket.has(alpha.assetKeys!['bg.png']!)).toBe(true);
    expect(bucket.has(alpha.assetKeys!['chart.osu']!)).toBe(true);
    expect(bucket.has(beta.assetKeys!['SB/D1.png']!)).toBe(true);

    // stored bytes are byte-identical to the official archive
    expect(bucket.bytes(alpha.archiveKey)).toEqual(official.zipOf('alpha-1'));

    const catalog = bucket.json<{ songs: { id: string }[] }>('_catalog/library.json');
    expect(catalog.songs.map((song) => song.id)).toEqual(['alpha-1', 'beta-2']);

    const manifest = bucket.json<{ success: boolean; archive: { sha256: string } }>(beta.manifestKey);
    expect(manifest.success).toBe(true);
    expect(manifest.archive.sha256).toBe(official.manifestOf('beta-2').archive.sha256);
  });

  it('is idempotent: a second tick downloads nothing and keeps the catalog stable', async () => {
    const { bucket, official, env, config, fetchImpl } = harness();
    await runSync(env, config, {}, fetchImpl);
    const fetchesAfterFirst = official.archiveFetches;
    const putsAfterFirst = bucket.puts;

    const second = await runSync(env, config, {}, fetchImpl);
    expect(second.run.processed).toBe(0);
    expect(second.run.catalogChanged).toBe(false);
    expect(official.archiveFetches).toBe(fetchesAfterFirst);
    // Two lock operations plus catalog/state may be rewritten; no song object
    // is re-uploaded when the generation is already current.
    const contentPuts = bucket
      .keys()
      .filter((key) => key !== '_catalog/sync-lock.json')
      .filter((key) => !key.startsWith('_catalog/library.json') && key !== '_catalog/sync-state.json');
    expect(contentPuts.length).toBeGreaterThan(0);
    expect(bucket.puts - putsAfterFirst).toBeLessThanOrEqual(5);
  });

  it('checks only the content-addressed archive in store mode', async () => {
    const { bucket, env, config, fetchImpl } = harness();
    const alphaHash = (await new OfficialClient(config, fetchImpl).fetchManifest('alpha-1')).archive.sha256;
    const putsBefore = bucket.puts;
    await runSync(env, { ...config, maxSongsPerTick: 1 }, {}, fetchImpl);
    expect(bucket.has(`_objects/archives/alpha-1/${alphaHash}.zip`)).toBe(true);
    expect(bucket.puts).toBeGreaterThan(putsBefore);
  });

  it('reuses an orphaned archive generation from a failed commit', async () => {
    const { bucket, official, env, config, fetchImpl } = harness({ SYNC_MAX_SONGS_PER_TICK: '1' });
    await runSync(env, config, {}, fetchImpl);
    const fetches = official.archiveFetches;
    official.updateSong('alpha-1', [{ name: 'bg.png', data: 'replacement' }]);
    const replacementHash = official.manifestOf('alpha-1').archive.sha256;
    const replacementKey = `_objects/archives/alpha-1/${replacementHash}.zip`;
    bucket.failPutKey = '_catalog/songs/alpha-1.json';
    bucket.failDeleteKey = replacementKey;
    const failed = await runSync(env, config, {}, fetchImpl);
    expect(failed.run.failed).toBe(1);
    expect(bucket.has(replacementKey)).toBe(true);
    bucket.failPutKey = null;
    bucket.failDeleteKey = null;
    const client = new OfficialClient(config, fetchImpl);
    const beforeRetry = official.archiveFetches;
    const record = await syncSong(env, config, client, 'alpha-1', replacementHash);
    expect(record.archiveHash).toBe(replacementHash);
    expect(official.archiveFetches).toBe(beforeRetry);
  });

  it('re-syncs a song whose archiveHash changed upstream', async () => {
    const { bucket, official, env, config, fetchImpl } = harness();
    await runSync(env, config, {}, fetchImpl);
    const old = bucket.generation('alpha-1');

    official.updateSong('alpha-1', [
      { name: 'bg.png', data: 'alpha-cover-v2' },
      { name: 'chart.osu', data: 'osu file format v14 // v2' },
    ]);
    const { run, state } = await runSync(env, config, {}, fetchImpl);

    expect(run.catalogChanged).toBe(true);
    expect(run.processed).toBe(1);
    expect(state.songs['alpha-1']!.archiveHash).toBe(official.manifestOf('alpha-1').archive.sha256);
    expect(new TextDecoder().decode(bucket.bytes(bucket.generation('alpha-1').assetKeys!['bg.png']!))).toBe('alpha-cover-v2');
    // The superseded generation remains readable for an in-flight request and
    // is reclaimed on the next tick, not during the switch itself.
    expect(bucket.has(old.archiveKey)).toBe(true);
    expect(state.retired).toHaveLength(1);
    await runSync(env, config, {}, fetchImpl);
    expect(bucket.has(old.archiveKey)).toBe(false);
    expect(bucket.has(old.manifestKey)).toBe(false);
    for (const key of Object.values(old.assetKeys ?? {})) expect(bucket.has(key)).toBe(false);
  });

  it('keeps the previous state when publishing the catalog fails', async () => {
    const { bucket, official, env, config, fetchImpl } = harness();
    await runSync(env, config, {}, fetchImpl);
    const before = await loadState(env.MIRROR);
    official.updateSong('alpha-1', [{ name: 'bg.png', data: 'v2' }]);
    bucket.failPutKey = '_catalog/library.json';
    await expect(runSync(env, config, {}, fetchImpl)).rejects.toThrow(/injected R2 put failure/);
    bucket.failPutKey = null;
    const after = await loadState(env.MIRROR);
    expect(after.songs['alpha-1']!.archiveHash).toBe(before.songs['alpha-1']!.archiveHash);
    const retry = await runSync(env, config, {}, fetchImpl);
    expect(retry.run.processed).toBe(1);
    expect(bucket.json<{ songs: { id: string }[] }>('_catalog/library.json').songs[0]!.id).toBe('alpha-1');
  });

  it('removes newly written objects when committing the pointer fails', async () => {
    const { bucket, official, env, config, fetchImpl } = harness();
    await runSync(env, config, {}, fetchImpl);
    const old = bucket.generation('alpha-1');
    official.updateSong('alpha-1', [{ name: 'bg.png', data: 'new-failed-generation' }]);
    const newHash = official.manifestOf('alpha-1').archive.sha256;
    bucket.failPutKey = `_catalog/songs/alpha-1.json`;
    const failed = await runSync(env, config, {}, fetchImpl);
    expect(failed.run.failed).toBe(1);
    bucket.failPutKey = null;
    expect(bucket.json<{ archiveHash: string }>('_catalog/songs/alpha-1.json').archiveHash).toBe(old.archiveHash);
    expect(bucket.has(`_objects/archives/alpha-1/${newHash}.zip`)).toBe(false);
    expect(bucket.has(`_catalog/manifests/alpha-1/${newHash}.json`)).toBe(false);
    expect(bucket.has(old.archiveKey)).toBe(true);
  });

  it('honours the per-tick song budget and never advertises a partially synced song', async () => {
    const { bucket, official, env, config, fetchImpl } = harness({ SYNC_MAX_SONGS_PER_TICK: '1' });
    const first = await runSync(env, config, {}, fetchImpl);
    expect(first.run.processed).toBe(1);
    expect(first.state.pending).toHaveLength(1);

    const catalog = bucket.json<{ songs: { id: string }[] }>('_catalog/library.json');
    expect(catalog.songs.map((song) => song.id)).toEqual(['alpha-1']);

    const second = await runSync(env, config, {}, fetchImpl);
    expect(second.run.processed).toBe(1);
    expect(second.state.pending).toHaveLength(0);
    expect(
      bucket.json<{ songs: unknown[] }>('_catalog/library.json').songs,
    ).toHaveLength(2);
    expect(official.catalogFetches).toBe(2);
  });

  it('uses the cached official catalog without omitting newly mirrored songs', async () => {
    const { bucket, official, env, config, fetchImpl } = harness({ SYNC_MAX_SONGS_PER_TICK: '1' });
    await runSync(env, config, {}, fetchImpl);
    const fetches = official.catalogFetches;

    const second = await runSync(env, config, { skipCatalog: true }, fetchImpl);
    expect(second.run.processed).toBe(1);
    expect(second.run.catalogFetched).toBe(false);
    expect(official.catalogFetches).toBe(fetches);
    expect(bucket.json<{ songs: { id: string }[] }>('_catalog/library.json').songs.map((song) => song.id))
      .toEqual(['alpha-1', 'beta-2']);
    expect(bucket.has('_catalog/official-library.json')).toBe(true);
  });

  it('uses a cached official catalog to publish songs when refresh fails', async () => {
    const { bucket, official, env, config, fetchImpl } = harness({ SYNC_MAX_SONGS_PER_TICK: '1' });
    await runSync(env, config, {}, fetchImpl);
    official.failCatalog = true;

    const second = await runSync(env, config, {}, fetchImpl);
    expect(second.run.catalogFetched).toBe(false);
    expect(second.run.processed).toBe(1);
    expect(second.run.errors[0]?.id).toBe('*');
    const cached = bucket.json<{ songs: { id: string }[] }>('_catalog/official-library.json');
    expect(cached.songs.map((song) => song.id)).toEqual(['alpha-1', 'beta-2']);
    expect(bucket.json<{ songs: { id: string }[] }>('_catalog/library.json').songs.map((song) => song.id))
      .toEqual(['alpha-1', 'beta-2']);
  });

  it('drops songs that disappeared upstream and reclaims their objects', async () => {
    const { bucket, official, env, config, fetchImpl } = harness();
    await runSync(env, config, {}, fetchImpl);
    const beta = bucket.generation('beta-2');
    expect(bucket.has(beta.archiveKey)).toBe(true);

    official.removeSong('beta-2');
    const { state } = await runSync(env, config, {}, fetchImpl);

    expect(Object.keys(state.songs)).toEqual(['alpha-1']);
    expect(bucket.has(beta.archiveKey)).toBe(false);
    expect(bucket.has(beta.assetKeys!['SB/D1.png']!)).toBe(false);
    expect(bucket.has('_catalog/manifests/beta-2.json')).toBe(false);
  });

  it('keeps removal metadata until bulk cleanup succeeds', async () => {
    const { bucket, official, env, config, fetchImpl } = harness();
    await runSync(env, config, {}, fetchImpl);
    const beta = bucket.generation('beta-2');
    official.removeSong('beta-2');
    bucket.failDeleteKey = beta.archiveKey;
    const first = await runSync(env, config, {}, fetchImpl);
    expect(first.state.removed).toContain('beta-2');
    expect(bucket.has('_catalog/manifests/beta-2.json')).toBe(true);
    expect(bucket.has('_catalog/songs/beta-2.json')).toBe(true);

    bucket.failDeleteKey = null;
    const second = await runSync(env, config, {}, fetchImpl);
    expect(second.state.removed).not.toContain('beta-2');
    expect(bucket.has(beta.archiveKey)).toBe(false);
    expect(bucket.has('_catalog/manifests/beta-2.json')).toBe(false);
    expect(bucket.has('_catalog/songs/beta-2.json')).toBe(false);
  });

  it('keeps a failed song queued and records the error', async () => {
    const { env, config, fetchImpl, official } = harness();
    const broken = new FakeOfficial({ songs: [] });
    const client = new OfficialClient(config, (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/download')) {
        return new Response(JSON.stringify({ success: true, song: { id: 'alpha-1', title: 'Alpha' }, files: [], archive: { url: 'x', size: 1, sha256: 'y' } }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return official.fetch(input, init);
    }) as unknown as typeof fetch);

    await expect(syncSong(env, config, client, 'alpha-1')).rejects.toThrow();
    void broken;
    const state = await loadState(env.MIRROR);
    expect(Object.keys(state.songs)).toHaveLength(0);
  });

  it('stops on subrequest exhaustion without failing unattempted songs', async () => {
    const { env, config, official } = harness();
    let manifestCalls = 0;
    const limitedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.includes('/library/alpha-1/download')) {
        manifestCalls += 1;
        if (manifestCalls > 0) throw new Error('Too many subrequests by single Worker invocation');
      }
      return official.fetch(input, init);
    }) as typeof fetch;
    const result = await runSync(env, { ...config, maxSongsPerTick: 2 }, {}, limitedFetch);
    expect(result.run.failed).toBe(0);
    expect(result.run.processed).toBe(0);
    expect(result.state.pending).toEqual(['alpha-1', 'beta-2']);
    expect(result.state.failures).toEqual({});
    expect(result.run.errors[0]?.message).toMatch(/subrequest budget exhausted/);
  });

  it('clears historical per-song subrequest backoff during replanning', async () => {
    const { env, config, official } = harness();
    await runSync(env, config, {}, official.fetch as typeof fetch);
    const state = await loadState(env.MIRROR);
    state.pending = ['alpha-1'];
    delete state.songs['alpha-1'];
    state.failures = {
      'alpha-1': {
        count: 8,
        lastError: 'Too many subrequests by single Worker invocation.',
        lastAt: new Date().toISOString(),
        catalogHash: 'old',
      },
    };
    await saveState(env.MIRROR, state, undefined);
    const next = await runSync(env, config, {}, official.fetch as typeof fetch);
    expect(next.state.failures?.['alpha-1']).toBeUndefined();
  });

  it('does not materialise assets in lazy mode but still stores the archive', async () => {
    const { bucket, env, fetchImpl } = harness({ SYNC_ASSET_MODE: 'lazy' });
    const config = resolveConfig(env);
    await runSync(env, config, {}, fetchImpl);
    expect(bucket.has(bucket.generation('alpha-1').archiveKey)).toBe(true);
    expect(bucket.has(bucket.generation('alpha-1').assetKeys?.['bg.png'] ?? 'alpha-1/bg.png')).toBe(false);
  });

  it('materialises only hot files in hot mode', async () => {
    const { bucket, env, fetchImpl } = harness({ SYNC_ASSET_MODE: 'hot' });
    const config = resolveConfig(env);
    await runSync(env, config, {}, fetchImpl);
    const alpha = bucket.generation('alpha-1');
    expect(bucket.has(alpha.assetKeys!['bg.png']!)).toBe(true);
    expect(bucket.has(alpha.assetKeys!['audio.mp3']!)).toBe(true);
    expect(bucket.has(alpha.assetKeys!['chart.osu']!)).toBe(true);
    expect(bucket.has(bucket.generation('beta-2').assetKeys?.['SB/D1.png'] ?? 'beta-2/SB/D1.png')).toBe(false);
  });

  it('reads from the API surface by default', async () => {
    const { official, env, config, fetchImpl } = harness();
    await runSync(env, config, {}, fetchImpl);
    expect(config.syncSource).toBe('api');
    expect(official.catalogFetches).toBe(1);
    expect(official.cdnCatalogFetches).toBe(0);
    expect(official.cdnArchiveFetches).toBe(0);
    expect(official.requestedPaths()).toContain('/api/rhydive/library');
  });

  it('reads from the official download site when SYNC_SOURCE=cdn', async () => {
    const { bucket, official, env, fetchImpl } = harness({ SYNC_SOURCE: 'cdn' });
    const config = resolveConfig(env);
    expect(config.syncSource).toBe('cdn');
    expect(config.cdnBeatmapBase).toBe(`${official.cdnOrigin}/rhydive/beatmap`);

    const { run, state } = await runSync(env, config, {}, fetchImpl);

    expect(run.processed).toBe(2);
    expect(run.failed).toBe(0);
    expect(Object.keys(state.songs).sort()).toEqual(['alpha-1', 'beta-2']);

    // every official read went to the download site, none to the API surface
    expect(official.cdnCatalogFetches).toBe(1);
    expect(official.cdnArchiveFetches).toBe(2);
    expect(official.catalogFetches).toBe(0);
    expect(official.requestedOrigins().every((origin) => origin === official.cdnOrigin)).toBe(true);
    expect(official.requestedPaths()).toContain('/rhydive/beatmap/_catalog/library.json');
    expect(official.requestedPaths()).toContain('/rhydive/beatmap/_catalog/manifests/alpha-1.json');
    expect(official.requestedPaths()).toContain('/rhydive/beatmap/alpha-1.zip');

    // and the mirrored result is identical to an API-sourced sync
    expect(bucket.bytes(bucket.generation('alpha-1').archiveKey)).toEqual(official.zipOf('alpha-1'));
    expect(bucket.json<{ success: boolean }>('_catalog/manifests/alpha-1.json').success).toBe(true);
    expect(bucket.has(bucket.generation('alpha-1').assetKeys!['chart.osu']!)).toBe(true);
    expect(bucket.json<{ songs: { id: string }[] }>('_catalog/library.json').songs.map((s) => s.id)).toEqual([
      'alpha-1',
      'beta-2',
    ]);
  });

  it('falls back to the configured source only: a CDN miss is retried, not silently switched', async () => {
    const { env, fetchImpl, official } = harness({ SYNC_SOURCE: 'cdn' });
    const config = resolveConfig(env);
    // Remove one song from the download site; the sync must fail for it, not
    // quietly fall back to the API surface.
    official.removeCdnArchive('beta-2');
    const { run, state } = await runSync(env, config, { budgetMs: 600_000 }, fetchImpl);
    expect(run.processed).toBe(1);
    expect(run.failed).toBe(1);
    expect(state.pending).toEqual(['beta-2']);
    expect(official.catalogFetches).toBe(0);
  });

  it('publishes a re-uploaded song with the real hash when the catalog is stale', async () => {
    const { bucket, official, env, fetchImpl } = harness();
    const config = resolveConfig(env);
    // Upstream re-uploaded alpha-1 but the catalog still advertises the old hash.
    official.markCatalogHashStale('alpha-1', 'f'.repeat(64));

    const { run } = await runSync(env, config, {}, fetchImpl);

    expect(run.processed).toBe(2);
    expect(run.repaired).toBe(1);
    const catalog = bucket.json<{ songs: { id: string; archiveHash: string }[] }>('_catalog/library.json');
    const alpha = catalog.songs.find((song) => song.id === 'alpha-1')!;
    // the published hash is the hash of the bytes the mirror actually serves
    expect(alpha.archiveHash).toBe(official.manifestOf('alpha-1').archive.sha256);
    expect(alpha.archiveHash).not.toBe('f'.repeat(64));
    expect(catalog.songs.map((song) => song.id)).toEqual(['alpha-1', 'beta-2']);
  });

  it('withholds a stale-catalog song in strict mode without churning the queue', async () => {
    const { bucket, official, env, fetchImpl } = harness({ SYNC_HASH_MODE: 'strict' });
    const config = resolveConfig(env);
    expect(config.hashMode).toBe('strict');
    official.markCatalogHashStale('alpha-1', 'f'.repeat(64));

    const { run, state } = await runSync(env, config, {}, fetchImpl);

    expect(run.processed).toBe(2);
    expect(run.repaired).toBe(0);
    const catalog = bucket.json<{ songs: { id: string }[] }>('_catalog/library.json');
    expect(catalog.songs.map((song) => song.id)).toEqual(['beta-2']);
    // the bytes are mirrored (and kept) but not advertised while the official
    // catalog disagrees; the queue is empty because there is nothing to redo.
    expect(Object.keys(state.songs).sort()).toEqual(['alpha-1', 'beta-2']);
    expect(state.pending).toEqual([]);
    // once upstream refreshes the catalog, the song becomes visible again
    official.markCatalogHashStale('alpha-1', official.manifestOf('alpha-1').archive.sha256);
    const after = await runSync(env, config, {}, fetchImpl);
    // the bytes were already correct, so nothing is re-downloaded: the song is
    // simply advertised again
    expect(after.run.processed).toBe(0);
    expect(
      bucket.json<{ songs: { id: string }[] }>('_catalog/library.json').songs.map((song) => song.id),
    ).toEqual(['alpha-1', 'beta-2']);
  });

  it('backs off a persistently failing song instead of spending the budget every tick', async () => {
    const { env, fetchImpl, official } = harness({ SYNC_SOURCE: 'cdn' });
    const config = resolveConfig(env);
    official.removeCdnArchive('alpha-1'); // never becomes available again

    const first = await runSync(env, config, { budgetMs: 600_000 }, fetchImpl);
    expect(first.run.failed).toBeGreaterThanOrEqual(1);
    const failure = first.state.failures!['alpha-1']!;
    expect(failure.count).toBe(1);

    // Immediately after, the song is in backoff: no origin request is made for it.
    const archivesBefore = official.cdnArchiveFetches;
    const second = await runSync(env, config, { budgetMs: 600_000 }, fetchImpl);
    expect(second.run.deferred).toBeGreaterThanOrEqual(1);
    expect(official.cdnArchiveFetches).toBe(archivesBefore);
    expect(second.state.failures!['alpha-1']!.count).toBe(1);

    // Once upstream makes the song available and changes it, the backoff is
    // cleared and the song is retried immediately.
    official.restoreCdnArchive('alpha-1');
    official.updateSong('alpha-1', [{ name: 'bg.png', data: 'alpha-cover-v3' }]);
    const third = await runSync(env, config, { budgetMs: 600_000 }, fetchImpl);
    expect(third.run.failed).toBe(0);
    expect(third.state.failures!['alpha-1']).toBeUndefined();
    expect(third.state.songs['alpha-1']).toBeDefined();
  });
});
