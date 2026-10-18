import { describe, expect, it } from 'vitest';
import { GDriveBulkStore, type GDriveConfig } from '../src/gdrive';
import { FakeR2, asR2Bucket } from './helpers/fake-r2';
import { FakeDrive } from './helpers/fake-drive';

function harness(options: ConstructorParameters<typeof FakeDrive>[0] = {}) {
  const meta = new FakeR2();
  const drive = new FakeDrive(options);
  const config: GDriveConfig = {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: 'refresh-token',
    folderId: '',
    teamDriveId: null,
    apiBase: drive.origin,
    tokenUrl: 'https://oauth2.googleapis.com/token',
    chunkSizeBytes: 8 * 1024 * 1024,
  };
  const store = new GDriveBulkStore(asR2Bucket(meta) as unknown as R2Bucket, config, drive.fetch);
  return { meta, drive, store };
}

function sharedHarness(
  options: ConstructorParameters<typeof FakeDrive>[0] = {},
  folderId = 'shared-folder',
) {
  const meta = new FakeR2();
  const drive = new FakeDrive(options);
  const urls: string[] = [];
  const recordedFetch = (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    return drive.fetch(input, init);
  };
  const config: GDriveConfig = {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: 'refresh-token',
    folderId,
    teamDriveId: 'shared-drive',
    apiBase: drive.origin,
    tokenUrl: 'https://oauth2.googleapis.com/token',
    chunkSizeBytes: 8 * 1024 * 1024,
  };
  const store = new GDriveBulkStore(asR2Bucket(meta) as unknown as R2Bucket, config, recordedFetch);
  return { meta, drive, store, urls };
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe('GDriveBulkStore', () => {
  it('round-trips an object through a multipart upload', async () => {
    const { store, drive } = harness();
    await store.put('alpha-1/chart.osu', bytes('osu file format v14'), { contentType: 'text/plain' });

    const head = await store.head('alpha-1/chart.osu');
    expect(head?.size).toBe('osu file format v14'.length);
    const body = await store.get('alpha-1/chart.osu');
    expect(await body!.text()).toBe('osu file format v14');
    expect(body!.contentType).toContain('text/plain');
    expect(drive.uploads).toBe(1);
  });

  it('keeps keys unique by encoding the whole key into the Drive file name', async () => {
    const { store, drive } = harness();
    await store.put('song-a/bg.png', bytes('aaa'), { contentType: 'image/png' });
    await store.put('song-b/bg.png', bytes('bbb'), { contentType: 'image/png' });
    await store.put('song-a/SB/D1.png', bytes('ccc'), { contentType: 'image/png' });

    expect(await (await store.get('song-a/bg.png'))!.text()).toBe('aaa');
    expect(new TextDecoder().decode(await (await store.get('song-b/bg.png'))!.arrayBuffer())).toBe('bbb');
    expect(new TextDecoder().decode(await (await store.get('song-a/SB/D1.png'))!.arrayBuffer())).toBe('ccc');
    expect(drive.files.size).toBe(4); // three objects + the mirror folder
  });

  it('serves ranged reads straight from Drive', async () => {
    const { store } = harness();
    const payload = bytes('0123456789abcdef');
    await store.put('alpha-1/audio.mp3', payload, { contentType: 'audio/mpeg' });

    const ranged = await store.get('alpha-1/audio.mp3', { offset: 4, length: 6 });
    expect(new TextDecoder().decode(await ranged!.arrayBuffer())).toBe('456789');
  });

  it('uses a resumable upload with 256 KiB-aligned chunks for large objects', async () => {
    const { store, drive } = harness();
    const big = new Uint8Array(9 * 1024 * 1024 + 1234);
    for (let i = 0; i < big.length; i += 4096) big[i] = i % 251;
    await store.put('alpha-1.zip', big, { contentType: 'application/zip' });

    expect(drive.uploads).toBe(1);
    const head = await store.head('alpha-1.zip');
    expect(head?.size).toBe(big.byteLength);
    const first = await store.get('alpha-1.zip', { offset: 0, length: 16 });
    expect(first!.size).toBe(16);
  });

  it('replaces content instead of creating duplicates', async () => {
    const { store, drive } = harness();
    await store.put('alpha-1/bg.png', bytes('v1'), { contentType: 'image/png' });
    await store.put('alpha-1/bg.png', bytes('v2'), { contentType: 'image/png' });

    expect(drive.files.size).toBe(2); // folder + one object
    expect(new TextDecoder().decode(await (await store.get('alpha-1/bg.png'))!.arrayBuffer())).toBe('v2');
  });

  it('deletes by key and tolerates missing keys', async () => {
    const { store, drive } = harness();
    await store.put('alpha-1/bg.png', bytes('x'), { contentType: 'image/png' });
    await store.delete(['alpha-1/bg.png', 'alpha-1/never-existed.png']);
    expect(await store.head('alpha-1/bg.png')).toBeNull();
    expect(drive.deletes).toBe(1);
  });

  it('caches the OAuth access token and refreshes it when rejected', async () => {
    const { store, drive } = harness();
    await store.put('alpha-1/bg.png', bytes('x'), { contentType: 'image/png' });
    await store.head('alpha-1/bg.png');
    await store.head('alpha-1/bg.png');
    expect(drive.tokenRequests).toBe(1);

    // Simulate the cached token being revoked: the driver must refresh once.
    drive.expireTokens();
    const recovered = await store.head('alpha-1/bg.png');
    expect(recovered?.size).toBe(1);
    expect(drive.tokenRequests).toBe(2);
  });

  it('reports the account quota', async () => {
    const { store } = harness({ quotaLimit: 5_000_000_000_000, quotaUsage: 21_400_000_000 });
    const status = await store.status();
    expect(status.driver).toBe('gdrive');
    expect(status.limitBytes).toBe(5_000_000_000_000);
    expect(status.freeBytes).toBe(5_000_000_000_000 - 21_400_000_000);
    expect(status.account).toBe('m***r@example.com');
  });

  it('surfaces Drive throttling instead of pretending the object is absent', async () => {
    const { store } = harness({ throttleReads: 1 });
    await store.put('alpha-1/bg.png', bytes('x'), { contentType: 'image/png' });
    await expect(store.get('alpha-1/bg.png')).rejects.toThrow(/403/);
    // The next call succeeds; the failure was not cached.
    expect(await store.head('alpha-1/bg.png')).not.toBeNull();
  });

  it('surfaces lookup failures during delete instead of silently skipping', async () => {
    const { store } = harness({ failLookups: 1 });
    await expect(store.delete(['alpha-1/bg.png'])).rejects.toThrow(/lookup.*500/);
  });

  it('sends shared-drive corpus parameters and parents', async () => {
    const { store, urls } = sharedHarness();
    await store.put('alpha-1/bg.png', bytes('x'), { contentType: 'image/png' });
    const lookup = urls.find((url) => url.includes('/files?') && url.includes('name'));
    expect(lookup).toBeDefined();
    expect(lookup).toContain('corpora=drive');
    expect(lookup).toContain('driveId=shared-drive');
  });

  it('creates the default folder inside the configured shared drive', async () => {
    const { store, drive, urls } = sharedHarness({}, '');
    await store.put('alpha-1/bg.png', bytes('x'), { contentType: 'image/png' });
    const folder = [...drive.files.values()].find((file) => file.name === 'RhyDiveMirror');
    expect(folder).toBeDefined();
    expect(folder?.parents).toContain('shared-drive');
    expect(urls.some((url) => url.includes('corpora=drive') && url.includes('driveId=shared-drive'))).toBe(true);
  });
});
