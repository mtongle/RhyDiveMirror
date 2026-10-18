/**
 * Storage layout integration: hybrid R2 + Google Drive, archive proxying, and
 * per-asset sourcing. Everything runs through the real request pipeline with a
 * fake official origin and a fake Drive.
 */
import { describe, expect, it } from 'vitest';
import { resolveConfig, type Env } from '../src/config';
import { handleRequest } from '../src/index';
import { runSync } from '../src/sync';
import { createBulkStore } from '../src/storage';
import { FakeR2, asR2Bucket } from './helpers/fake-r2';
import { FakeDrive } from './helpers/fake-drive';
import { FakeOfficial, type FixtureSong } from './helpers/official';

const songs: FixtureSong[] = [
  {
    id: 'alpha-1',
    title: 'Alpha',
    entries: [
      { name: 'bg.png', data: 'alpha-cover' },
      { name: 'audio.mp3', data: 'alpha-audio'.repeat(80), store: true },
      { name: 'chart.osu', data: 'osu file format v14' },
    ],
  },
  {
    id: 'beta-2',
    title: 'Beta',
    entries: [
      { name: 'bg.jpg', data: 'beta-cover' },
      { name: 'SB/D1.png', data: 'beta-storyboard' },
      { name: 'video.mp4', data: 'beta-video'.repeat(200) },
    ],
  },
];

async function harness(overrides: Partial<Env> = {}, driveOptions: ConstructorParameters<typeof FakeDrive>[0] = {}) {
  const bucket = new FakeR2();
  const official = new FakeOfficial({ songs: songs.map((song) => ({ ...song, entries: [...song.entries] })) });
  const drive = new FakeDrive(driveOptions);
  const env: Env = {
    MIRROR: asR2Bucket(bucket),
    OFFICIAL_ORIGIN: official.origin,
    OFFICIAL_CDN_ORIGIN: official.cdnOrigin,
    GDRIVE_CLIENT_ID: 'client-id',
    GDRIVE_CLIENT_SECRET: 'client-secret',
    GDRIVE_REFRESH_TOKEN: 'refresh-token',
    ...overrides,
  };
  // Route Google API traffic to the fake Drive, everything else to the origin.
  const routed = ((input: RequestInfo | URL, init?: RequestInit) =>
    String(input).includes('googleapis.com')
      ? drive.fetch(input, init)
      : official.fetch(input, init)) as typeof fetch;
  const config = resolveConfig(env);
  await runSync(env, config, {}, routed);
  const syncPaths = official.requestedPaths();
  official.requests.length = 0;
  return {
    syncPaths,
    bucket,
    official,
    drive,
    env,
    config,
    routed,
    store: () => config,
    call: (path: string, init?: RequestInit) => handleRequest(new Request(`https://mirror.test${path}`, init), env, routed),
  };
}

/** Drive file names are the encoded keys. */
function driveKeys(drive: FakeDrive): string[] {
  return [...drive.files.values()]
    .filter((file) => file.mimeType !== 'application/vnd.google-apps.folder')
    .map((file) => decodeURIComponent(file.name))
    .sort();
}

describe('hybrid layout (R2 metadata + hot assets, Drive bulk)', () => {
  it('splits archives and cold assets to Drive and keeps hot assets in R2', async () => {
    const { bucket, drive } = await harness({ STORAGE_LAYOUT: 'hybrid' });

    expect(bucket.has('_catalog/library.json')).toBe(true);
    expect(bucket.has('_catalog/manifests/alpha-1.json')).toBe(true);

    // hot: cover / audio / beatmap stay in R2
    expect(bucket.has(bucket.generation('alpha-1').assetKeys!['bg.png']!)).toBe(true);
    expect(bucket.has(bucket.generation('alpha-1').assetKeys!['audio.mp3']!)).toBe(true);
    expect(bucket.has(bucket.generation('alpha-1').assetKeys!['chart.osu']!)).toBe(true);
    expect(bucket.has(bucket.generation('beta-2').assetKeys!['bg.jpg']!)).toBe(true);
    // archives never touch R2 in this layout
    expect(bucket.has(bucket.generation('alpha-1').archiveKey)).toBe(false);
    expect(bucket.has(bucket.generation('beta-2').archiveKey)).toBe(false);

    const keys = driveKeys(drive);
    expect(keys).toContain(bucket.generation('alpha-1').archiveKey);
    expect(keys).toContain(bucket.generation('beta-2').archiveKey);
    // cold assets (storyboard frame, background video) go to Drive
    expect(keys).toContain(bucket.generation('beta-2').assetKeys!['SB/D1.png']!);
    expect(keys).toContain(bucket.generation('beta-2').assetKeys!['video.mp4']!);
    expect(keys.filter((key) => key.endsWith('.zip'))).toHaveLength(2);
  });

  it('serves assets and archives from whichever tier holds them', async () => {
    const { bucket, call } = await harness({ STORAGE_LAYOUT: 'hybrid', SYNC_ASSET_MODE: 'all' });
    // hot asset: in R2, so the read never reaches Drive
    expect(bucket.has(bucket.generation('alpha-1').assetKeys!['bg.png']!)).toBe(true);
    // cold asset: in Drive, not R2
    expect(bucket.has(bucket.generation('beta-2').assetKeys!['SB/D1.png']!)).toBe(false);
    expect(bucket.has(bucket.generation('alpha-1').archiveKey)).toBe(false);

    const hot = await call('/api/rhydive/assets/alpha-1/bg.png');
    expect(hot.status).toBe(200);
    expect(await hot.text()).toBe('alpha-cover');

    const cold = await call('/api/rhydive/assets/beta-2/SB/D1.png');
    expect(cold.status).toBe(200);
    expect(await cold.text()).toBe('beta-storyboard');

    const archive = await call('/api/rhydive/library/alpha-1/archive', { headers: { range: 'bytes=0-15' } });
    expect(archive.status).toBe(206);
    expect((await archive.arrayBuffer()).byteLength).toBe(16);

    const rangedCold = await call('/api/rhydive/assets/beta-2/video.mp4', { headers: { range: 'bytes=10-19' } });
    expect(rangedCold.status).toBe(206);
    expect((await rangedCold.arrayBuffer()).byteLength).toBe(10);
  });

  it('reaches objects left in R2 by an earlier layout', async () => {
    const bucket = new FakeR2();
    const official = new FakeOfficial({ songs: songs.map((song) => ({ ...song, entries: [...song.entries] })) });
    const drive = new FakeDrive();
    const routed = ((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes('googleapis.com')
        ? drive.fetch(input, init)
        : official.fetch(input, init)) as typeof fetch;
    const base: Env = {
      MIRROR: asR2Bucket(bucket),
      OFFICIAL_ORIGIN: official.origin,
      OFFICIAL_CDN_ORIGIN: official.cdnOrigin,
    };
    await runSync(base, resolveConfig(base), {}, routed); // layout r2
    expect(bucket.has(bucket.generation('alpha-1').archiveKey)).toBe(true);

    const hybrid: Env = { ...base, STORAGE_LAYOUT: 'hybrid', GDRIVE_CLIENT_ID: 'x', GDRIVE_CLIENT_SECRET: 'y', GDRIVE_REFRESH_TOKEN: 'z' };
    const response = await handleRequest(new Request('https://mirror.test/api/rhydive/library/alpha-1/archive'), hybrid, routed);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(official.zipOf('alpha-1'));
  });

  it('reports the Drive quota and layout in the admin status', async () => {
    const { call } = await harness(
      { STORAGE_LAYOUT: 'hybrid', SYNC_TOKEN: 'token' },
      { quotaLimit: 5_000_000_000_000, quotaUsage: 21_400_000_000 },
    );
    const response = await call('/__admin/status', { headers: { authorization: 'Bearer token' } });
    const payload = (await response.json()) as {
      config: { storageLayout: string; archiveMode: string };
      tiers: { layout: string; gdrive: { limitBytes: number; freeBytes: number; account: string } };
    };
    expect(payload.config.storageLayout).toBe('hybrid');
    expect(payload.tiers.layout).toBe('hybrid');
    expect(payload.tiers.gdrive.limitBytes).toBe(5_000_000_000_000);
    expect(payload.tiers.gdrive.account).toBe('m***r@example.com');
  });
});

describe('archive proxying (no archive stored)', () => {
  it('streams the official ZIP without keeping a copy', async () => {
    const { bucket, official, call } = await harness({ ARCHIVE_MODE: 'proxy' });

    expect(bucket.has('alpha-1.zip')).toBe(false);
    expect(bucket.has('_catalog/manifests/alpha-1.json')).toBe(true);

    const response = await call('/api/rhydive/library/alpha-1/archive');
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(official.zipOf('alpha-1'));
    expect(official.requestedPaths()).toContain('/api/rhydive/library/alpha-1/archive');
    expect(bucket.has('alpha-1.zip')).toBe(false);
  });

  it('forwards a ranged archive request to the origin', async () => {
    const { call } = await harness({ ARCHIVE_MODE: 'proxy' });
    const response = await call('/api/rhydive/library/beta-2/archive', { headers: { range: 'bytes=100-199' } });
    expect(response.status).toBe(206);
    expect((await response.arrayBuffer()).byteLength).toBe(100);
  });
});

describe('asset sourcing', () => {
  it('fetches only the wanted assets from the origin and never the archive', async () => {
    const { bucket, official, syncPaths } = await harness({
      ARCHIVE_MODE: 'proxy',
      SYNC_ASSET_MODE: 'hot',
      SYNC_ASSET_SOURCE: 'origin',
    });

    expect(official.archiveFetches).toBe(0);
    expect(syncPaths).toContain('/api/rhydive/assets/alpha-1/bg.png');
    expect(syncPaths).toContain('/api/rhydive/assets/alpha-1/audio.mp3');
    // cold assets are neither fetched nor stored
    expect(syncPaths).not.toContain('/api/rhydive/assets/beta-2/SB/D1.png');
    expect(bucket.has(bucket.generation('alpha-1').assetKeys!['bg.png']!)).toBe(true);
    expect(bucket.has(bucket.generation('beta-2').assetKeys?.['SB/D1.png'] ?? 'beta-2/SB/D1.png')).toBe(false);
    expect(bucket.has(bucket.generation('alpha-1').archiveKey)).toBe(false);
  });

  it('still stores the archive when the layout asks for it', async () => {
    const { bucket, official } = await harness({ SYNC_ASSET_MODE: 'hot', SYNC_ASSET_SOURCE: 'origin' });
    expect(bucket.has(bucket.generation('alpha-1').archiveKey)).toBe(true);
    expect(official.archiveFetches).toBeGreaterThan(0);
    expect(new Uint8Array(bucket.bytes(bucket.generation('alpha-1').archiveKey))).toEqual(official.zipOf('alpha-1'));
  });
});

describe('cross-layout cleanup', () => {
  it('removes the same retired key from both physical tiers', async () => {
    const { bucket, drive, routed } = await harness({ STORAGE_LAYOUT: 'hybrid' });
    const key = bucket.generation('alpha-1').archiveKey;
    // Emulate a previous layout leaving a second copy in R2.
    await bucket.put(key, 'old-copy');
    expect(bucket.has(key)).toBe(true);
    const driveHasKey = [...drive.files.values()].some((file) => decodeURIComponent(file.name) === key);
    expect(driveHasKey).toBe(true);
    const env: Env = {
      MIRROR: asR2Bucket(bucket),
      STORAGE_LAYOUT: 'hybrid',
      GDRIVE_CLIENT_ID: 'id',
      GDRIVE_CLIENT_SECRET: 'secret',
      GDRIVE_REFRESH_TOKEN: 'token',
      GDRIVE_API_BASE: 'https://www.googleapis.com',
    };
    const store = createBulkStore(env, resolveConfig(env), routed);
    expect(store.deleteEverywhere).toBeDefined();
    await store.deleteEverywhere!([key]);
    expect(bucket.has(key)).toBe(false);
    expect([...drive.files.values()].some((file) => decodeURIComponent(file.name) === key)).toBe(false);
  });
});
