import { describe, expect, it } from 'vitest';
import { resolveConfig, type Env } from '../src/config';
import { handleRequest } from '../src/index';
import { runSync } from '../src/sync';
import { FakeR2, asR2Bucket } from './helpers/fake-r2';
import { FakeOfficial, type FixtureSong } from './helpers/official';

const songs: FixtureSong[] = [
  {
    id: 'alpha-1',
    title: 'Alpha',
    entries: [
      { name: 'bg.png', data: 'alpha-cover' },
      { name: 'audio.mp3', data: 'alpha-audio'.repeat(100), store: true },
      { name: 'chart.osu', data: 'osu file format v14' },
    ],
  },
  {
    id: 'beta-2',
    title: 'Beta',
    entries: [{ name: 'bg.jpg', data: 'beta-cover' }],
  },
];

async function seeded(overrides: Partial<Env> = {}) {
  const bucket = new FakeR2();
  const official = new FakeOfficial({
    songs: songs.map((song) => ({ ...song, entries: [...song.entries] })),
    passthrough: (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/rhydive/results' && request.method === 'POST') {
        return new Response(JSON.stringify({ success: true, saved: true }), {
          status: 201,
          headers: {
            'content-type': 'application/json',
            'set-cookie': 'sid=abc123; Domain=sta.lunprin.test; Path=/; HttpOnly',
          },
        });
      }
      return undefined;
    },
  });
  const env: Env = {
    MIRROR: asR2Bucket(bucket),
    OFFICIAL_ORIGIN: official.origin,
    OFFICIAL_CDN_ORIGIN: official.cdnOrigin,
    ...overrides,
  };
  const config = resolveConfig(env);
  const fetchImpl = official.fetch as unknown as typeof fetch;
  await runSync(env, config, {}, fetchImpl);
  official.requests.length = 0;
  return { bucket, official, env, config, fetchImpl, call: (path: string, init?: RequestInit) => handleRequest(new Request(`https://mirror.test${path}`, init), env, fetchImpl) };
}

describe('mirror reads', () => {
  it('serves the mirrored catalog as JSON, never HTML', async () => {
    const { call } = await seeded();
    const response = await call('/api/rhydive/library');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const payload = (await response.json()) as { success: boolean; songs: { id: string }[] };
    expect(payload.success).toBe(true);
    expect(payload.songs.map((song) => song.id)).toEqual(['alpha-1', 'beta-2']);
  });

  it('also serves the download-site layout the official client expects', async () => {
    const { call } = await seeded();
    const catalog = await call('/rhydive/beatmap/_catalog/library.json');
    expect(catalog.status).toBe(200);
    expect((await catalog.json()) as { songs: unknown[] }).toMatchObject({ success: true });

    const manifest = await call('/rhydive/beatmap/_catalog/manifests/alpha-1.json');
    expect(manifest.status).toBe(200);
    expect(((await manifest.json()) as { archive: { size: number } }).archive.size).toBeGreaterThan(0);
  });

  it('serves assets with an immutable cache policy and a concrete content type', async () => {
    const { call } = await seeded();
    const response = await call('/api/rhydive/assets/alpha-1/bg.png');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(await response.text()).toBe('alpha-cover');
  });

  it('answers HEAD and range requests for archives', async () => {
    const { call } = await seeded();
    const head = await call('/api/rhydive/library/alpha-1/archive', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('accept-ranges')).toBe('bytes');
    const size = Number(head.headers.get('content-length'));
    expect(size).toBeGreaterThan(0);

    const range = await call('/api/rhydive/library/alpha-1/archive', {
      headers: { range: 'bytes=0-9' },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe(`bytes 0-9/${size}`);
    expect((await range.arrayBuffer()).byteLength).toBe(10);

    const bad = await call('/api/rhydive/library/alpha-1/archive', { headers: { range: `bytes=${size}-` } });
    expect(bad.status).toBe(416);
  });

  it('revalidates with ETag', async () => {
    const { call } = await seeded();
    const first = await call('/api/rhydive/assets/alpha-1/bg.png');
    const etag = first.headers.get('etag')!;
    const second = await call('/api/rhydive/assets/alpha-1/bg.png', { headers: { 'if-none-match': etag } });
    expect(second.status).toBe(304);
  });

  it('extracts a cached-away asset from the stored archive on demand', async () => {
    const { call, bucket } = await seeded({ SYNC_ASSET_MODE: 'lazy' });
    expect(bucket.has('alpha-1/bg.png')).toBe(false);

    const response = await call('/api/rhydive/assets/alpha-1/chart.osu');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toBe('osu file format v14');
    // write-through caches it for the next request
    expect(bucket.has('alpha-1/chart.osu')).toBe(true);
  });

  it('supports ranged reads of a lazily extracted asset', async () => {
    const { call } = await seeded({ SYNC_ASSET_MODE: 'lazy' });
    const response = await call('/api/rhydive/assets/alpha-1/audio.mp3', { headers: { range: 'bytes=5-14' } });
    expect(response.status).toBe(206);
    // entry contents are 'alpha-audio' repeated, so bytes 5..14 are '-audioalph'
    expect(await response.text()).toBe('-audioalph');
  });
});

describe('pass-through proxy', () => {
  it('forwards non-chart endpoints with method, path, query and body intact', async () => {
    const { call, official } = await seeded();
    const response = await call('/api/rhydive/results?cache=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playId: 'p1' }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ success: true, saved: true });

    const sent = official.requests.at(-1)!;
    expect(sent.method).toBe('POST');
    expect(new URL(sent.url).pathname).toBe('/api/rhydive/results');
    expect(new URL(sent.url).search).toBe('?cache=1');
    expect(sent.body).toBe(JSON.stringify({ playId: 'p1' }));
  });

  it('re-scopes upstream cookies to the mirror host', async () => {
    const { call } = await seeded();
    const response = await call('/api/rhydive/results', { method: 'POST', body: '{}' });
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain('sid=abc123');
    expect(cookie).not.toContain('Domain=sta.lunprin.test');
  });

  it('forwards reads such as the session endpoint', async () => {
    const { call, official } = await seeded();
    const response = await call('/api/session/current', { headers: { cookie: 'sid=abc123' } });
    expect(response.status).toBe(200);
    expect(official.requests.at(-1)!.headers.cookie).toBe('sid=abc123');
  });
});

describe('fallbacks', () => {
  it('falls back to the official API when a song is not mirrored yet', async () => {
    // Only alpha-1 fits in the first tick; beta-2 is still pending.
    const { call, official } = await seeded({ SYNC_MAX_SONGS_PER_TICK: '1' });
    const response = await call('/api/rhydive/library/beta-2/download');
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { song: { id: string } };
    expect(payload.song.id).toBe('beta-2');
    expect(official.requestedPaths()).toContain('/api/rhydive/library/beta-2/download');
  });

  it('propagates the upstream status for an unknown song', async () => {
    const { call, official } = await seeded();
    const response = await call('/api/rhydive/library/not-in-library/download');
    expect(response.status).toBe(404);
    expect(official.requestedPaths()).toContain('/api/rhydive/library/not-in-library/download');
  });

  it('404s the download-site surface without leaking HTML', async () => {
    const { call } = await seeded({ MIRROR_FALLBACK_PROXY: 'false' });
    const response = await call('/rhydive/beatmap/unknown-song.zip');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('rejects traversal attempts locally without touching the origin', async () => {
    const { call, official } = await seeded();
    const response = await call('/api/rhydive/assets/alpha-1/..%2f..%2fsecret.png');
    expect(response.status).toBe(400);
    expect(official.requests).toHaveLength(0);
  });

  it('prevents open-proxy / SSRF attacks via protocol-relative pathnames', async () => {
    const { call, official } = await seeded();
    await call('//attacker.com/evil/path');
    const last = official.requests.at(-1)!;
    // Must remain strictly bound to the official origin, never attacker.com
    expect(new URL(last.url).origin).toBe(official.origin);
    expect(new URL(last.url).pathname).toBe('/attacker.com/evil/path');
  });
});

describe('admin surface', () => {
  it('is closed unless a token is configured', async () => {
    const { call } = await seeded();
    expect((await call('/__admin/status')).status).toBe(404);
  });

  it('reports state and runs an on-demand sync with a bearer token', async () => {
    const { call } = await seeded({ SYNC_TOKEN: 'secret-token' });
    expect((await call('/__admin/status')).status).toBe(401);
    expect((await call('/__admin/status', { headers: { authorization: 'Bearer nope' } })).status).toBe(401);

    const status = await call('/__admin/status', { headers: { authorization: 'Bearer secret-token' } });
    expect(status.status).toBe(200);
    const payload = (await status.json()) as { catalog: { mirroredSongs: number } };
    expect(payload.catalog.mirroredSongs).toBe(2);

    const sync = await call('/__admin/sync', { method: 'POST', headers: { 'x-sync-token': 'secret-token' } });
    expect(sync.status).toBe(200);
    expect(((await sync.json()) as { success: boolean }).success).toBe(true);
  });
});

describe('health', () => {
  it('reports the resolved mirror configuration', async () => {
    const { call } = await seeded();
    const response = await call('/__health');
    expect(response.status).toBe(200);
    expect(((await response.json()) as { ok: boolean }).ok).toBe(true);
  });
});
