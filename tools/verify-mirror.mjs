#!/usr/bin/env node
/**
 * Verifies a mirror deployment the way a RhyDive client consumes it.
 *
 * Checks, in order:
 *   1. /__health answers and reports its configuration;
 *   2. the mirrored catalog is valid JSON and not a web page;
 *   3. a song's manifest is valid and every field the client validates holds;
 *   4. the archive is byte-identical to the manifest's sha256 and size;
 *   5. each archive entry matches the manifest's per-file sha256 (full check
 *      with --deep, otherwise a sample);
 *   6. assets are served with a concrete Content-Type and honour Range;
 *   7. a non-chart endpoint is proxied (not answered locally).
 *
 * Usage:
 *   node tools/verify-mirror.mjs --worker https://mirror.example.workers.dev
 *   node tools/verify-mirror.mjs --worker http://127.0.0.1:8787 --song <songId> --deep
 */

import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`Usage: node tools/verify-mirror.mjs --worker URL [options]

Checks a deployed mirror with the same invariants the RhyDive client uses.

Options:
  --worker URL     Deployed mirror URL (or RHYDIVE_MIRROR_WORKER)
  --song ID        Pin a song; otherwise one mirrored song is sampled
  --deep           Verify every archive entry instead of a sample
  --sample N       Entries checked without --deep (default 5)
  --help           Show this help

Exit codes: 0 all checks passed, 1 a check failed, 2 usage/fatal error.`);
  process.exit(0);
}
const worker = (args.worker ?? process.env.RHYDIVE_MIRROR_WORKER ?? '').replace(/\/+$/, '');
const deep = Boolean(args.deep);
const sampleLimit = positiveInt(args.sample, 5, '--sample');
if (!worker) fail('missing --worker (or RHYDIVE_MIRROR_WORKER)');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const health = await getJson(`${worker}/__health`).catch((error) => ({ error }));
check('/__health responds', health.ok === true, health.error ? String(health.error) : `origin=${health.mirror?.officialOrigin}`);

const catalogResponse = await fetch(`${worker}/api/rhydive/library`, { headers: { accept: 'application/json' } });
const catalogType = catalogResponse.headers.get('content-type') ?? '';
const catalog = await catalogResponse.json().catch(() => null);
check('catalog is JSON, never HTML', catalogResponse.ok && !/text\/html/i.test(catalogType), `status=${catalogResponse.status} type=${catalogType}`);
check('catalog has songs', Array.isArray(catalog?.songs) && catalog.songs.length > 0, `${catalog?.songs?.length ?? 0} songs`);

const songId = args.song ?? catalog?.songs?.[Math.floor(Math.random() * catalog.songs.length)]?.id;
if (!songId) fail('could not pick a song to verify; pass --song');
console.log(`verifying song: ${songId}`);

const manifestResponse = await fetch(`${worker}/api/rhydive/library/${encodeURIComponent(songId)}/download`);
const manifest = await manifestResponse.json().catch(() => null);
check('manifest is valid', manifestResponse.ok && manifest?.success === true && manifest?.song?.id === songId, `status=${manifestResponse.status}`);
check('manifest archive descriptor is valid', Boolean(manifest?.archive) && Number.isSafeInteger(manifest.archive.size) && manifest.archive.size > 0 && /^[a-f0-9]{64}$/.test(manifest.archive.sha256 ?? ''), `size=${manifest?.archive?.size}`);
check(
  'manifest file urls follow the client contract',
  Array.isArray(manifest?.files) &&
    manifest.files.length > 0 &&
    manifest.files.every((file) => file.url === `/api/rhydive/assets/${songId}/${file.name.split('/').map(encodeURIComponent).join('/')}`),
  `${manifest?.files?.length ?? 0} files`,
);
const manifestFiles = Array.isArray(manifest?.files) ? manifest.files : [];
check(
  'manifest names and sizes fit the client limits',
  manifestFiles.length >= 1 &&
    manifestFiles.length <= 5000 &&
    manifestFiles.every(
      (file) =>
        typeof file?.name === 'string' &&
        Number.isSafeInteger(file.size) &&
        file.size >= 0 &&
        file.size <= 128 * 1024 * 1024,
    ) &&
    manifestFiles.reduce((total, file) => total + file.size, 0) <= 512 * 1024 * 1024,
  `${manifestFiles.length} files`,
);

const archiveResponse = await fetch(`${worker}/api/rhydive/library/${encodeURIComponent(songId)}/archive`);
const archive = new Uint8Array(await archiveResponse.arrayBuffer());
const archiveHash = sha256(archive);
check(
  'archive is byte-identical to the manifest',
  archiveResponse.ok && archive.byteLength === manifest.archive.size && archiveHash === manifest.archive.sha256,
  `${archive.byteLength} bytes sha256=${archiveHash.slice(0, 16)}…`,
);

const ranged = await fetch(`${worker}/api/rhydive/library/${encodeURIComponent(songId)}/archive`, { headers: { range: 'bytes=0-15' } });
const rangedBytes = new Uint8Array(await ranged.arrayBuffer());
check('archive honours Range', ranged.status === 206 && rangedBytes.byteLength === 16, `status=${ranged.status}`);

try {
  const archiveBuffer = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  const entries = readCentralDirectory(archiveBuffer);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const expectedNames = new Set(manifestFiles.map((file) => file.name.toLowerCase()));
  const actualNames = new Set(entries.filter((entry) => !entry.name.endsWith('/')).map((entry) => entry.name.toLowerCase()));
  check(
    'archive entry count matches the manifest',
    entries.length === manifestFiles.length && actualNames.size === expectedNames.size,
    `archive=${entries.length} manifest=${manifestFiles.length}`,
  );
  const targets = deep ? manifestFiles : manifestFiles.slice(0, sampleLimit);
  let verified = 0;
  for (const file of targets) {
    const entry = byName.get(file.name);
    if (!entry) continue;
    const bytes = extract(archiveBuffer, entry);
    if (bytes.byteLength === file.size && sha256(bytes) === file.sha256) verified += 1;
  }
  check(
    `archive entries match the manifest (${deep ? 'all' : `first ${targets.length}`})`,
    verified === targets.length,
    `${verified}/${targets.length} verified`,
  );
} catch (error) {
  check('archive entries match the manifest', false, String(error.message));
}

const asset = manifestFiles.find((file) => /\.(png|jpg|jpeg|webp|ogg|mp3)$/i.test(file.name)) ?? manifestFiles[0];
if (!asset) fail('manifest has no asset to verify');
const assetResponse = await fetch(`${worker}${asset.url}`);
const assetType = assetResponse.headers.get('content-type') ?? '';
const assetBytes = new Uint8Array(await assetResponse.arrayBuffer());
check(
  'asset is served with a concrete content type',
  assetResponse.ok && !/text\/html/i.test(assetType) && assetBytes.byteLength === asset.size,
  `${asset.name} ${assetResponse.status} ${assetType} ${assetBytes.byteLength}B`,
);
check('asset matches the manifest sha256', sha256(assetBytes) === asset.sha256, asset.name);

const rangeEnd = Math.min(9, asset.size - 1);
const assetRange = await fetch(`${worker}${asset.url}`, {
  headers: { range: rangeEnd >= 0 ? `bytes=0-${rangeEnd}` : 'bytes=0-' },
});
check(
  'asset honours Range',
  asset.size > 0
    ? assetRange.status === 206 && (await assetRange.arrayBuffer()).byteLength === Math.min(10, asset.size)
    : assetRange.status === 416,
  `status=${assetRange.status} size=${asset.size}`,
);

const cdnCatalog = await fetch(`${worker}/rhydive/beatmap/_catalog/library.json`);
const cdnType = cdnCatalog.headers.get('content-type') ?? '';
check('download-site catalog surface works', cdnCatalog.ok && !/text\/html/i.test(cdnType), `status=${cdnCatalog.status} type=${cdnType}`);

// A real, existing non-chart endpoint: if the mirror answered locally instead of
// proxying, this would 404 (the local surface only knows chart routes).
const session = await fetch(`${worker}/api/session/current`, { headers: { accept: 'application/json' } });
const sessionType = session.headers.get('content-type') ?? '';
let sessionBody = null;
try {
  sessionBody = await session.clone().json();
} catch {
  sessionBody = null;
}
check(
  'non-chart endpoints are proxied upstream',
  session.ok &&
    /application\/json/i.test(sessionType) &&
    sessionBody !== null &&
    typeof sessionBody.success === 'boolean' &&
    sessionBody.message !== 'not mirrored yet',
  `status=${session.status} type=${sessionType} keys=${sessionBody ? Object.keys(sessionBody).join(',') : 'n/a'}`,
);

const traversal = await fetch(`${worker}/api/rhydive/assets/${encodeURIComponent(songId)}/..%2f..%2fsecret.png`);
check('traversal is rejected locally', traversal.status === 400, `status=${traversal.status}`);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readCentralDirectory(buffer) {
  const eocd = findEocd(buffer);
  if (eocd < 0) throw new Error('archive is not a zip');
  const count = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  const out = [];
  let cursor = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('bad central directory');
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    out.push({ name, method, compressedSize, localHeaderOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

function extract(buffer, entry) {
  const nameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
  const start = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`unsupported method ${entry.method}`);
}

function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= min; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
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
  console.error(`verify-mirror.mjs: ${message}`);
  process.exit(2);
}

function positiveInt(value, fallback, label) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail(`${label} must be a positive integer`);
  return parsed;
}
