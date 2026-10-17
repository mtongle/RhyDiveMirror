/**
 * Live end-to-end verification against the real RhyDive API.
 *
 * Opt-in, because it talks to the internet:
 *
 *   RHYDIVE_LIVE=1 npx vitest run test/live.test.ts
 *   RHYDIVE_LIVE_SONG=<songId> ...   # pin a specific song
 *
 * It mirrors one real song into an in-memory R2 stand-in and then checks the
 * served surface the way the desktop client consumes it: catalog -> manifest ->
 * archive (sha256 + entry hashes) -> individual asset.
 */
import { describe, expect, it } from 'vitest';
import { resolveConfig, type Env } from '../src/config';
import { sha256Hex } from '../src/http';
import { handleRequest } from '../src/index';
import { OfficialClient } from '../src/official';
import { planPending, emptyState } from '../src/state';
import { runSync, writeMirrorCatalog } from '../src/sync';
import { readCentralDirectory, extractEntry } from '../src/zip';
import { FakeR2, asR2Bucket } from './helpers/fake-r2';

const live = process.env.RHYDIVE_LIVE === '1';
/** `api` (default) or `cdn` — both are real, reachable official surfaces. */
const liveSource = process.env.RHYDIVE_LIVE_SOURCE === 'cdn' ? 'cdn' : 'api';

describe.runIf(live)(`live official ${liveSource} surface`, () => {
  it('mirrors a real song and serves it back in the client-expected shape', async () => {
    const bucket = new FakeR2();
    const env: Env = { MIRROR: asR2Bucket(bucket), SYNC_SOURCE: liveSource };
    const config = resolveConfig(env);
    expect(config.syncSource).toBe(liveSource);
    const client = new OfficialClient(config, fetch);

    // The API origin is slow; give the single song a generous budget so the tick
    // is not skipped. The real cron uses a small budget and converges over ticks.
    const catalogStartedAt = Date.now();
    const catalog = await client.fetchCatalog();
    const catalogMs = Date.now() - catalogStartedAt;
    expect(catalog.songs.length).toBeGreaterThan(100);
    console.log(
      `[live/${liveSource}] catalog: ${catalog.songs.length} songs in ${catalogMs} ms (${Math.round(
        catalog.songs.length / 1,
      )} songs)`,
    );

    // planPending on the real catalog queues every song, as the cron would.
    const planned = planPending(emptyState(), catalog.songs);
    expect(planned.pending.length).toBe(catalog.songs.length);

    const songId = process.env.RHYDIVE_LIVE_SONG ?? catalog.songs[0]!.id;
    const state = emptyState();
    state.officialSongCount = catalog.songs.length;
    state.pending = [songId];

    const result = await runSync(
      env,
      config,
      { skipCatalog: true, maxSongs: 1, budgetMs: 900_000, state },
      fetch,
    );
    expect(result.run.processed).toBe(1);
    expect(result.run.failed).toBe(0);
    const record = result.state.songs[songId];
    expect(record, `song ${songId} was not mirrored`).toBeDefined();
    const mirrored = await writeMirrorCatalog(env, catalog, result.state, config.hashMode);
    expect(mirrored.mirrored).toBe(1);

    // 2. The served catalog contains the song and stays a valid catalog.
    const catalogResponse = await handleRequest(new Request('https://mirror.test/api/rhydive/library'), env, fetch);
    expect(catalogResponse.status).toBe(200);
    expect(catalogResponse.headers.get('content-type')).toContain('application/json');
    const servedCatalog = (await catalogResponse.json()) as { success: boolean; songs: { id: string }[] };
    expect(servedCatalog.success).toBe(true);
    expect(servedCatalog.songs.some((song) => song.id === songId)).toBe(true);

    // 3. The manifest the client downloads is valid and its archive matches.
    const manifestResponse = await handleRequest(
      new Request(`https://mirror.test/api/rhydive/library/${songId}/download`),
      env,
      fetch,
    );
    expect(manifestResponse.status).toBe(200);
    const manifest = (await manifestResponse.json()) as {
      success: boolean;
      archive: { size: number; sha256: string; url: string };
      files: { name: string; url: string; size: number; sha256: string }[];
    };
    expect(manifest.success).toBe(true);
    expect(manifest.archive.url).toBe(`/api/rhydive/library/${songId}/archive`);

    // 4. The archive the client downloads is byte-identical to the official ZIP.
    const archiveResponse = await handleRequest(
      new Request(`https://mirror.test/api/rhydive/library/${songId}/archive`),
      env,
      fetch,
    );
    expect(archiveResponse.status).toBe(200);
    const archive = new Uint8Array(await archiveResponse.arrayBuffer());
    expect(archive.byteLength).toBe(manifest.archive.size);
    expect(await sha256Hex(archive)).toBe(manifest.archive.sha256);

    // 5. Every manifest entry is inside the archive with the manifest digest
    //    (this is exactly what the desktop client validates before publishing).
    const entries = readCentralDirectory(archive);
    expect(entries.length).toBe(manifest.files.length);
    for (const file of manifest.files) {
      const entry = entries.find((candidate) => candidate.name === file.name);
      expect(entry, `missing ${file.name}`).toBeDefined();
      const bytes = await extractEntry(archive, entry!);
      expect(bytes.byteLength).toBe(file.size);
      expect(await sha256Hex(bytes)).toBe(file.sha256);
    }

    // 6. Individual assets are served with ranged reads for streaming.
    const asset = manifest.files.find((file) => /\.(png|jpg|jpeg|webp)$/i.test(file.name)) ?? manifest.files[0]!;
    const assetUrl = `https://mirror.test${asset.url}`;
    const full = await handleRequest(new Request(assetUrl), env, fetch);
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).not.toContain('text/html');
    expect((await full.arrayBuffer()).byteLength).toBe(asset.size);

    const ranged = await handleRequest(new Request(assetUrl, { headers: { range: 'bytes=0-99' } }), env, fetch);
    expect(ranged.status).toBe(206);
    expect((await ranged.arrayBuffer()).byteLength).toBe(Math.min(100, asset.size));

    // 7. Non-chart endpoints are proxied, not answered locally.
    const session = await handleRequest(
      new Request('https://mirror.test/api/session/current'),
      env,
      fetch,
    );
    expect(session.status).toBe(200);
    expect(session.headers.get('content-type')).toContain('application/json');
    const sessionBody = (await session.json()) as { success: boolean };
    expect(typeof sessionBody.success).toBe('boolean');
  }, 300_000);
});
