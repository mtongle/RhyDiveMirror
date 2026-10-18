// Samples per-song manifests to size the full mirror and to learn asset/content characteristics.
import fs from 'node:fs/promises';

const catalog = JSON.parse(await fs.readFile('analysis/probes/library.local.json', 'utf8'));
const songs = catalog.songs;
const N = Number(process.env.SAMPLE ?? 12);
// deterministic spread across the catalog
const idx = Array.from({ length: N }, (_, i) => Math.floor((i + 0.5) * songs.length / N));
const picked = idx.map((i) => songs[i]);
const origin = 'https://sta.lunprin.com';

const rows = [];
let cursor = 0;
async function worker() {
  while (cursor < picked.length) {
    const song = picked[cursor++];
    try {
      const res = await fetch(`${origin}/api/rhydive/library/${encodeURIComponent(song.id)}/download`, {
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) { rows.push({ id: song.id, error: `HTTP ${res.status}` }); continue; }
      const m = await res.json();
      const exts = {};
      let assetBytes = 0;
      for (const f of m.files) {
        const e = (f.name.match(/\.[^.]+$/) ?? ['(none)'])[0].toLowerCase();
        exts[e] = (exts[e] ?? 0) + 1;
        assetBytes += f.size;
      }
      rows.push({ id: song.id, title: song.title, difficulties: song.difficulties?.length ?? 0, files: m.files.length, assetBytes, zipBytes: m.archive.size, totalBytes: m.totalBytes, exts });
    } catch (e) { rows.push({ id: song.id, error: String(e.message) }); }
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
const ok = rows.filter((r) => !r.error);
const sum = (k) => ok.reduce((a, r) => a + r[k], 0);
const stats = {
  sampled: rows.length, ok: ok.length,
  avgFiles: ok.length ? Math.round(sum('files') / ok.length) : 0,
  avgAssetBytes: ok.length ? Math.round(sum('assetBytes') / ok.length) : 0,
  avgZipBytes: ok.length ? Math.round(sum('zipBytes') / ok.length) : 0,
  totalLibrarySongs: songs.length,
  rows,
};
stats.projected = {
  songs: songs.length,
  assetBytesTotal: stats.avgAssetBytes * songs.length,
  zipBytesTotal: stats.avgZipBytes * songs.length,
  mirroredBytesTotal: (stats.avgAssetBytes + stats.avgZipBytes) * songs.length,
  zipOnlyBytesTotal: stats.avgZipBytes * songs.length,
};
await fs.writeFile('analysis/probes/stats.json', JSON.stringify(stats, null, 2));
console.log(JSON.stringify({ ...stats, rows: rows.map(r => ({id: r.id, files: r.files, assetBytes: r.assetBytes, zipBytes: r.zipBytes, error: r.error})) }, null, 2));
