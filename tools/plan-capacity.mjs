#!/usr/bin/env node
/**
 * Exact capacity planning for a mirror deployment.
 *
 * Fetches the official catalog and every per-song manifest, then reports what
 * each storage profile would actually cost in R2 — no sampling, no estimates.
 * A manifest lists the exact byte size of every file in the song, so the whole
 * library can be measured from ~800 small requests (~12 MB total).
 *
 * Usage:
 *   node tools/plan-capacity.mjs                      # report against 10 GB
 *   node tools/plan-capacity.mjs --budget-gb 10 --source cdn
 *   node tools/plan-capacity.mjs --json > capacity.json
 */

const args = parseArgs(process.argv.slice(2));
const source = args.source === 'api' ? 'api' : 'cdn';
const budgetBytes = Math.round(Number(args['budget-gb'] ?? 10) * 1e9);
const concurrency = Number(args.concurrency ?? 12);
const json = Boolean(args.json);

const ORIGINS = {
  api: 'https://sta.lunprin.com/api/rhydive',
  cdn: 'https://dl.lunprin.com/rhydive/beatmap',
};

const catalog = await getJson(
  source === 'api' ? `${ORIGINS.api}/library` : `${ORIGINS.cdn}/_catalog/library.json`,
);
const songs = catalog.songs ?? [];
if (!json) console.error(`catalog: ${songs.length} songs from ${source}`);

/** Same predicate the worker uses for `SYNC_ASSET_MODE=hot`. */
const HOT = /^(bg|background|cover|audio|preview)\./i;
const isHot = (name) => {
  const base = name.split('/').pop() ?? name;
  return HOT.test(base) || /\.osu$/i.test(base);
};

const rows = [];
let cursor = 0;
let failures = 0;
async function worker() {
  while (cursor < songs.length) {
    const song = songs[cursor++];
    const url =
      source === 'api'
        ? `${ORIGINS.api}/library/${encodeURIComponent(song.id)}/download`
        : `${ORIGINS.cdn}/_catalog/manifests/${encodeURIComponent(song.id)}.json`;
    try {
      const manifest = await getJson(url);
      let assetBytes = 0;
      let hotBytes = 0;
      const byExt = new Map();
      for (const file of manifest.files) {
        assetBytes += file.size;
        if (isHot(file.name)) hotBytes += file.size;
        const ext = (/\.[^.]+$/.exec(file.name) ?? ['(none)'])[0].toLowerCase();
        byExt.set(ext, (byExt.get(ext) ?? 0) + file.size);
      }
      rows.push({
        id: song.id,
        uploadedAt: song.uploadedAt,
        title: song.title,
        catalogHash: song.archiveHash,
        manifestHash: manifest.archive.sha256,
        zipBytes: manifest.archive.size,
        assetBytes,
        hotBytes,
        files: manifest.files.length,
        byExt: Object.fromEntries(byExt),
      });
    } catch (error) {
      failures += 1;
      rows.push({ id: song.id, error: String(error.message ?? error) });
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

const ok = rows.filter((row) => !row.error);
const sum = (key) => ok.reduce((total, row) => total + row[key], 0);
const zipBytes = sum('zipBytes');
const assetBytes = sum('assetBytes');
const hotBytes = sum('hotBytes');

/** Greedy fill in catalog order (which is newest-first). */
function fill(costOf) {
  let used = 0;
  const picked = [];
  for (const row of ok) {
    const cost = costOf(row);
    if (used + cost > budgetBytes) break;
    used += cost;
    picked.push(row);
  }
  return { songs: picked.length, bytes: used, newest: picked[0]?.uploadedAt, oldest: picked.at(-1)?.uploadedAt };
}

const byExt = new Map();
for (const row of ok) {
  for (const [ext, bytes] of Object.entries(row.byExt)) byExt.set(ext, (byExt.get(ext) ?? 0) + bytes);
}
const extRanking = [...byExt.entries()].sort((a, b) => b[1] - a[1]);

const report = {
  source,
  songs: ok.length,
  failures,
  budgetBytes,
  totals: {
    zipBytes,
    assetBytes,
    hotBytes,
    zipPlusAssets: zipBytes + assetBytes,
    zipPlusHot: zipBytes + hotBytes,
    catalogPlusManifests: 15_000 * ok.length, // measured: ~3.7 MB catalog + ~15 KB/song
  },
  averagesPerSong: {
    zipBytes: zipBytes / ok.length,
    assetBytes: assetBytes / ok.length,
    hotBytes: hotBytes / ok.length,
    files: sum('files') / ok.length,
  },
  profiles: {
    'archive+all-assets': fill((row) => row.zipBytes + row.assetBytes),
    'archive-only (lazy)': fill((row) => row.zipBytes),
    'archive+hot-assets': fill((row) => row.zipBytes + row.hotBytes),
    'hot-assets-only': fill((row) => row.hotBytes),
    'catalog+manifests-only': fill(() => 15_000),
  },
  bytesByExtension: Object.fromEntries(extRanking),
};

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const gb = (bytes) => `${(bytes / 1e9).toFixed(2)} GB`;
  console.log(`\nlibrary: ${report.songs} songs (${failures} manifest failures)\n`);
  console.log('total sizes');
  console.log(`  archives (zip)          ${gb(zipBytes)}`);
  console.log(`  every asset             ${gb(assetBytes)}`);
  console.log(`  hot assets only         ${gb(hotBytes)}`);
  console.log(`  archive + every asset   ${gb(report.totals.zipPlusAssets)}`);
  console.log(`  archive + hot assets    ${gb(report.totals.zipPlusHot)}`);
  console.log(`  catalog + manifests     ${gb(report.totals.catalogPlusManifests)}`);
  console.log('\nper song');
  for (const [key, value] of Object.entries(report.averagesPerSong)) {
    console.log(`  ${key.padEnd(24)} ${key === 'files' ? value.toFixed(1) : gb(value)}`);
  }
  console.log(`\nwhat fits in ${gb(budgetBytes)} (catalog order, newest first)`);
  for (const [name, result] of Object.entries(report.profiles)) {
    console.log(
      `  ${name.padEnd(24)} ${String(result.songs).padStart(4)}/${report.songs} songs, ${gb(result.bytes).padStart(9)}` +
        (result.oldest ? `  (${result.oldest.slice(0, 10)} … ${result.newest.slice(0, 10)})` : ''),
    );
  }
  console.log('\nbytes by extension');
  for (const [ext, bytes] of extRanking.slice(0, 12)) {
    console.log(`  ${ext.padEnd(10)} ${gb(bytes)}`);
  }
}

async function getJson(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (response.ok) return response.json();
    if (response.status === 404) throw new Error(`HTTP 404`);
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  throw new Error(`unavailable`);
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
