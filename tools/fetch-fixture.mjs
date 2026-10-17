#!/usr/bin/env node
/**
 * Downloads one real song (manifest + archive) into analysis/fixtures so the
 * ZIP-reader test in worker/test/zip.test.ts can validate against genuine
 * RhyDive bytes instead of synthetic archives.
 *
 * These files are intentionally gitignored: they are official chart content,
 * reproducible on demand, and must not be redistributed with the source.
 *
 * Usage:
 *   node tools/fetch-fixture.mjs                       # smallest song from a sample
 *   node tools/fetch-fixture.mjs --song <songId>
 *   node tools/fetch-fixture.mjs --list 5              # show candidates and exit
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ORIGIN = process.env.RHYDIVE_ORIGIN ?? 'https://sta.lunprin.com';
const OUT = path.resolve('analysis/fixtures');
const args = parseArgs(process.argv.slice(2));

const catalog = await getJson(`${ORIGIN}/api/rhydive/library`);
const songs = catalog.songs ?? [];
console.log(`catalog: ${songs.length} songs`);

if (args.song) {
  await download(args.song);
} else {
  const count = Number(args.list ?? 0);
  if (count > 0) {
    // Sample across the catalog and report sizes so the smallest one can be picked.
    const step = Math.max(1, Math.floor(songs.length / count));
    for (let i = 0; i < songs.length && i / step < count; i += step) {
      const song = songs[i];
      const manifest = await getJson(`${ORIGIN}/api/rhydive/library/${encodeURIComponent(song.id)}/download`);
      console.log(`${song.id}  zip=${manifest.archive.size}  files=${manifest.files.length}`);
    }
    process.exit(0);
  }

  // Default: probe a small sample and take the smallest archive.
  const probes = await Promise.all(
    [0.05, 0.25, 0.5, 0.7, 0.9].map(async (fraction) => {
      const song = songs[Math.floor(fraction * (songs.length - 1))];
      try {
        const manifest = await getJson(`${ORIGIN}/api/rhydive/library/${encodeURIComponent(song.id)}/download`);
        return { id: song.id, size: manifest.archive.size };
      } catch (error) {
        console.warn(`probe ${song.id} failed: ${error.message}`);
        return null;
      }
    }),
  );
  const candidates = probes.filter(Boolean).sort((a, b) => a.size - b.size);
  if (candidates.length === 0) fail('could not probe any song');
  console.log('candidates:', candidates.map((c) => `${c.id} (${c.size})`).join(', '));
  await download(candidates[0].id);
}

async function download(songId) {
  const manifest = await getJson(`${ORIGIN}/api/rhydive/library/${encodeURIComponent(songId)}/download`);
  const response = await fetch(`${ORIGIN}/api/rhydive/library/${encodeURIComponent(songId)}/archive`, {
    signal: AbortSignal.timeout(600_000),
  });
  if (!response.ok) fail(`archive download failed: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== manifest.archive.size) {
    fail(`archive size mismatch: ${bytes.byteLength} != ${manifest.archive.size}`);
  }
  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(OUT, 'archive.zip'), bytes);
  console.log(`wrote ${path.join(OUT, 'manifest.json')} and archive.zip (${bytes.byteLength} bytes, song ${songId})`);
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!response.ok) fail(`GET ${url} -> HTTP ${response.status}`);
  return response.json();
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[name] = true;
    else {
      out[name] = next;
      i += 1;
    }
  }
  return out;
}

function fail(message) {
  console.error(`fetch-fixture.mjs: ${message}`);
  process.exit(1);
}
