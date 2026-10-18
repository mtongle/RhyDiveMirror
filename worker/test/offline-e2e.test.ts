/**
 * Full-pipeline acceptance using the captured official fixture. Unlike the
 * synthetic unit fixtures, this archive and manifest are real RhyDive output.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { handleRequest } from '../src/index';
import { runSync } from '../src/sync';
import { resolveConfig, type Env } from '../src/config';
import { sha256Hex } from '../src/http';
import { FakeOfficial } from './helpers/official';
import { FakeR2, asR2Bucket } from './helpers/fake-r2';

const fixtureDir = fileURLToPath(new URL('../../analysis/fixtures/', import.meta.url));
const hasFixture = existsSync(`${fixtureDir}manifest.json`) && existsSync(`${fixtureDir}archive.zip`);
const manifest = (hasFixture ? JSON.parse(readFileSync(`${fixtureDir}manifest.json`, 'utf8')) : null) as {
  song: { id: string; title: string };
} | null;
const archive = hasFixture ? new Uint8Array(readFileSync(`${fixtureDir}archive.zip`)) : new Uint8Array();

describe.runIf(hasFixture)('offline real-sample end to end', () => {
  it('serves the real catalog, manifest, archive and every asset', async () => {
    if (!manifest) throw new Error('fixture manifest missing');
    const bucket = new FakeR2();
    const official = new FakeOfficial({ songs: [{ id: manifest.song.id, title: manifest.song.title, entries: [] }] });
    // Replace the fake's small generated archive with the captured official bytes.
    installFixture(official, manifest as never, archive);
    const env: Env = {
      MIRROR: asR2Bucket(bucket),
      OFFICIAL_ORIGIN: official.origin,
      OFFICIAL_CDN_ORIGIN: official.cdnOrigin,
      SYNC_ASSET_MODE: 'all',
    };
    const config = resolveConfig(env);
    const result = await runSync(env, config, {}, official.fetch as typeof fetch);
    expect(result.run.failed).toBe(0);
    expect(result.run.processed).toBe(1);

    const call = (path: string, init?: RequestInit) =>
      handleRequest(new Request(`https://mirror.test${path}`, init), env, official.fetch as typeof fetch);

    const catalog = await call('/api/rhydive/library');
    expect(catalog.status).toBe(200);
    const catalogBody = (await catalog.json()) as { songs: { id: string }[] };
    expect(catalogBody.songs.map((song) => song.id)).toEqual([manifest.song.id]);

    const response = await call(`/api/rhydive/library/${manifest.song.id}/download`);
    const served = (await response.json()) as typeof manifest & {
      files: { name: string; size: number; sha256: string; url: string }[];
      archive: { size: number; sha256: string; url: string };
    };
    expect(served.archive.sha256).toBe(await sha256Hex(archive));

    const archiveResponse = await call(served.archive.url);
    const downloaded = new Uint8Array(await archiveResponse.arrayBuffer());
    expect(downloaded).toEqual(archive);
    expect(await sha256Hex(downloaded)).toBe(served.archive.sha256);

    const allFiles = (manifest as unknown as { files: typeof served.files }).files;
    for (const file of allFiles) {
      const asset = await call(file.url);
      expect(asset.status, file.name).toBe(200);
      expect(asset.headers.get('content-type')).not.toContain('text/html');
      const bytes = new Uint8Array(await asset.arrayBuffer());
      expect(bytes.byteLength).toBe(file.size);
      expect(await sha256Hex(bytes), file.name).toBe(file.sha256);
    }
  }, 30_000);
});

function installFixture(store: FakeOfficial, fixture: { song: { id: string; title: string } }, bytes: Uint8Array): void {
  // The fake writes a generated ZIP at construction; replacing its state keeps
  // the test focused on the production sync/serve pipeline.
  const state = store as unknown as {
    zips: Map<string, Uint8Array>;
    manifests: Map<string, unknown>;
    assets: Map<string, Uint8Array>;
  };
  state.zips.set(fixture.song.id, bytes);
  const files = (fixture as unknown as { files: { name: string; size: number; sha256: string; url: string }[] }).files;
  state.manifests.set(fixture.song.id, fixture);
  state.assets.clear();
  // Individual origin fetches are not used when sourcing from the archive;
  // assets are extracted from the captured ZIP after its digest is verified.
  for (const file of files) state.assets.set(`${fixture.song.id}/${file.name}`, new Uint8Array());
}
