import { describe, expect, it } from 'vitest';
import { resolveConfig, type Env } from '../src/config';
import { runSync, syncSong } from '../src/sync';
import { OfficialClient } from '../src/official';
import { loadState } from '../src/state';
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
  it('mirrors the archive, the manifest and every asset, then advertises only complete songs', async () => {
    const { bucket, official, env, config, fetchImpl } = harness();
    const { run, state } = await runSync(env, config, {}, fetchImpl);

    expect(run.catalogFetched).toBe(true);
    expect(run.processed).toBe(2);
    expect(run.failed).toBe(0);
    expect(Object.keys(state.songs).sort()).toEqual(['alpha-1', 'beta-2']);

    // archives, manifests and extracted assets are all present
    expect(bucket.has('alpha-1.zip')).toBe(true);
    expect(bucket.has('beta-2.zip')).toBe(true);
    expect(bucket.has('_catalog/manifests/alpha-1.json')).toBe(true);
    expect(bucket.has('alpha-1/bg.png')).toBe(true);
    expect(bucket.has('alpha-1/chart.osu')).toBe(true);
    expect(bucket.has('beta-2/SB/D1.png')).toBe(true);

    // stored bytes are byte-identical to the official archive
    expect(bucket.bytes('alpha-1.zip')).toEqual(official.zipOf('alpha-1'));

    const catalog = bucket.json<{ songs: { id: string }[] }>('_catalog/library.json');
    expect(catalog.songs.map((song) => song.id)).toEqual(['alpha-1', 'beta-2']);

    const manifest = bucket.json<{ success: boolean; archive: { sha256: string } }>(
      '_catalog/manifests/beta-2.json',
    );
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
    // only the catalog/state may be rewritten
    expect(bucket.puts - putsAfterFirst).toBeLessThanOrEqual(2);
  });

  it('re-syncs a song whose archiveHash changed upstream', async () => {
    const { bucket, official, env, config, fetchImpl } = harness();
    await runSync(env, config, {}, fetchImpl);

    official.updateSong('alpha-1', [
      { name: 'bg.png', data: 'alpha-cover-v2' },
      { name: 'chart.osu', data: 'osu file format v14 // v2' },
    ]);
    const { run, state } = await runSync(env, config, {}, fetchImpl);

    expect(run.catalogChanged).toBe(true);
    expect(run.processed).toBe(1);
    expect(state.songs['alpha-1']!.archiveHash).toBe(official.manifestOf('alpha-1').archive.sha256);
    expect(new TextDecoder().decode(bucket.bytes('alpha-1/bg.png'))).toBe('alpha-cover-v2');
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

  it('drops songs that disappeared upstream and reclaims their objects', async () => {
    const { bucket, official, env, config, fetchImpl } = harness();
    await runSync(env, config, {}, fetchImpl);
    expect(bucket.has('beta-2.zip')).toBe(true);

    official.removeSong('beta-2');
    const { state } = await runSync(env, config, {}, fetchImpl);

    expect(Object.keys(state.songs)).toEqual(['alpha-1']);
    expect(bucket.has('beta-2.zip')).toBe(false);
    expect(bucket.has('beta-2/SB/D1.png')).toBe(false);
    expect(bucket.has('_catalog/manifests/beta-2.json')).toBe(false);
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

  it('does not materialise assets in lazy mode but still stores the archive', async () => {
    const { bucket, env, fetchImpl } = harness({ SYNC_ASSET_MODE: 'lazy' });
    const config = resolveConfig(env);
    await runSync(env, config, {}, fetchImpl);
    expect(bucket.has('alpha-1.zip')).toBe(true);
    expect(bucket.has('alpha-1/bg.png')).toBe(false);
  });

  it('materialises only hot files in hot mode', async () => {
    const { bucket, env, fetchImpl } = harness({ SYNC_ASSET_MODE: 'hot' });
    const config = resolveConfig(env);
    await runSync(env, config, {}, fetchImpl);
    expect(bucket.has('alpha-1/bg.png')).toBe(true);
    expect(bucket.has('alpha-1/audio.mp3')).toBe(true);
    expect(bucket.has('alpha-1/chart.osu')).toBe(true);
    expect(bucket.has('beta-2/SB/D1.png')).toBe(false);
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
    expect(bucket.bytes('alpha-1.zip')).toEqual(official.zipOf('alpha-1'));
    expect(bucket.json<{ success: boolean }>('_catalog/manifests/alpha-1.json').success).toBe(true);
    expect(bucket.has('alpha-1/chart.osu')).toBe(true);
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
