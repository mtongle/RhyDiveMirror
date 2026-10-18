import { describe, expect, it } from 'vitest';
import { resolveConfig, type Env } from '../src/config';
import { handleRequest } from '../src/index';
import { OfficialClient } from '../src/official';
import { R2BulkStore, TieredBulkStore } from '../src/storage';
import { emptyState } from '../src/state';
import { runSync, writeMirrorCatalog } from '../src/sync';
import { readCentralDirectory } from '../src/zip';
import { buildZip } from './helpers/zip-builder';
import { FakeOfficial } from './helpers/official';
import { sha256 } from './helpers/official';
import { FakeR2, asR2Bucket } from './helpers/fake-r2';

const id = 'alpha-1';

function bodyFor(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
}

describe('regressions found during full-repository audit', () => {
  it('chunks bulk deletion below the R2 limit', async () => {
    const bucket = new FakeR2();
    const store = new TieredBulkStore(new R2BulkStore(asR2Bucket(bucket)), null, () => 'r2', 'r2');
    const keys = Array.from({ length: 2_501 }, (_, index) => `a/${index}.osu`);
    for (const key of keys) await bucket.put(key, 'x');
    await store.delete(keys);
    expect(bucket.deleteBatches).toEqual([1_000, 1_000, 501]);
    expect(bucket.keys()).toEqual([]);
  });

  it('rejects manifests beyond the client limits before materialising anything', async () => {
    const official = new FakeOfficial({ songs: [{ id, title: 'x', entries: [{ name: 'bg.png', data: 'x' }] }] });
    const manifest = official.manifestOf(id) as unknown as Record<string, unknown>;
    const tooMany = Array.from({ length: 5_001 }, (_, index) => ({
      name: `${index}.osu`,
      url: `/api/rhydive/assets/${id}/${index}.osu`,
      size: 1,
      sha256: 'a'.repeat(64),
    }));
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/download')) return bodyFor({ ...manifest, files: tooMany });
      return official.fetch(input);
    }) as typeof fetch;
    const client = new OfficialClient(resolveConfig({
      MIRROR: asR2Bucket(new FakeR2()),
      OFFICIAL_ORIGIN: official.origin,
    }), fetchImpl);
    await expect(client.fetchManifest(id)).rejects.toThrow(/invalid/);
  });

  it('turns upstream HTML for a chart resource into a JSON 502', async () => {
    const official = new FakeOfficial({ songs: [{ id, title: 'x', entries: [{ name: 'bg.png', data: 'x' }] }] });
    const env: Env = {
      MIRROR: asR2Bucket(new FakeR2()),
      OFFICIAL_ORIGIN: official.origin,
      OFFICIAL_CDN_ORIGIN: official.cdnOrigin,
      SYNC_MAX_SONGS_PER_TICK: '0',
    };
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/archive') && path.startsWith('/api/rhydive/')) {
        return new Response('<html>not public</html>', { headers: { 'content-type': 'text/html' } });
      }
      return official.fetch(input, init);
    }) as typeof fetch;
    const response = await handleRequest(
      new Request(`https://mirror.test/api/rhydive/library/${id}/archive`),
      env,
      fetchImpl,
    );
    expect(response.status).toBe(502);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toMatchObject({ code: 'origin_returned_html' });
  });

  it('does not publish a catalog that points at an uncommitted generation', async () => {
    const bucket = new FakeR2();
    const env: Env = { MIRROR: asR2Bucket(bucket) };
    const state = emptyState();
    state.songs[id] = {
      archiveHash: 'a'.repeat(64),
      zipBytes: 1,
      files: 1,
      assetBytes: 1,
      storedAssetBytes: 1,
      materialized: 'all',
      syncedAt: new Date().toISOString(),
      title: 'x',
    };
    await writeMirrorCatalog(env, {
      success: true,
      songs: [{ id, archiveHash: state.songs[id]!.archiveHash, title: 'x' }],
    }, state);
    expect(bucket.has('_catalog/library.json')).toBe(true);
    expect(bucket.json<{ songs: { id: string; archiveHash: string }[] }>('_catalog/library.json').songs).toEqual([
      { id, archiveHash: 'a'.repeat(64), title: 'x' },
    ]);
  });

  it('reads a central directory from a tail-only buffer', () => {
    const zip = buildZip([
      { name: 'bg.png', data: 'cover' },
      { name: 'audio.mp3', data: 'audio'.repeat(20) },
    ]);
    const eocd = zip.byteLength - 22;
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const cdSize = view.getUint32(eocd + 12, true);
    const offset = view.getUint32(eocd + 16, true);
    expect(offset + cdSize).toBeLessThan(zip.byteLength);
    const tail = zip.subarray(offset);
    const entries = readCentralDirectory(tail, offset);
    expect(entries.map((entry) => entry.name)).toEqual(['bg.png', 'audio.mp3']);
    expect(entries[0]!.archiveOffset).toBe(offset);
  });

  it('rejects an archive with extra entries not listed in the manifest', async () => {
    const official = new FakeOfficial({
      songs: [{ id, title: 'x', entries: [{ name: 'bg.png', data: 'x' }] }],
    });
    const manifest = (official as unknown as { manifests: Map<string, unknown> }).manifests.get(id) as {
      files: { name: string; url: string; size: number; sha256: string }[];
      archive: { url: string; size: number; sha256: string };
    };
    // Keep the archive descriptor internally consistent so only the entry-set
    // comparison can reject this archive.
    const zipWithExtra = buildZip([
      { name: 'bg.png', data: 'x' },
      { name: 'extra.osu', data: 'extra' },
    ]);
    manifest.archive = {
      url: `/api/rhydive/library/${id}/archive`,
      size: zipWithExtra.byteLength,
      sha256: sha256(zipWithExtra),
    };
    const env: Env = { MIRROR: asR2Bucket(new FakeR2()), OFFICIAL_ORIGIN: official.origin };
    (official as unknown as { zips: Map<string, Uint8Array> }).zips.set(id, zipWithExtra);
    const result = await runSync(env, { ...resolveConfig(env), maxSongsPerTick: 1 }, {}, official.fetch as typeof fetch);
    expect(result.run.failed).toBe(1);
    expect(result.run.errors[0]?.message).toMatch(/entry set mismatch/);
  });
});
