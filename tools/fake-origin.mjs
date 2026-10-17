#!/usr/bin/env node
/**
 * Local stand-in for the official RhyDive API, driven by the captured fixture
 * in `analysis/fixtures/`.
 *
 * Why: the real origin is slow (~70 KB/s, the 3.5 MB catalog takes ~1 minute)
 * and requires network access. This server reproduces the exact endpoints the
 * mirror consumes, so `wrangler dev` can be exercised end to end in seconds:
 *
 *   node tools/fake-origin.mjs --port 8899 &
 *   cd worker && npx wrangler dev --var OFFICIAL_ORIGIN:http://127.0.0.1:8899 \
 *                                --var OFFICIAL_CDN_ORIGIN:http://127.0.0.1:8899
 *
 * Run `node tools/fetch-fixture.mjs` first to create the fixture.
 */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const port = Number(args.port ?? 8899);
const fixtureDir = path.resolve(args.fixture ?? 'analysis/fixtures');

let manifest;
let archive;
try {
  manifest = JSON.parse(readFileSync(path.join(fixtureDir, 'manifest.json'), 'utf8'));
  archive = readFileSync(path.join(fixtureDir, 'archive.zip'));
} catch (error) {
  console.error(`fake-origin.mjs: cannot read fixture in ${fixtureDir} (${error.message})`);
  console.error('Run: node tools/fetch-fixture.mjs');
  process.exit(1);
}

const songId = manifest.song.id;
const entries = readCentralDirectory(archive);
const catalog = { success: true, songs: [manifest.song] };

const server = createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks);
    console.log(`${request.method} ${url.pathname}${url.search}${body.length ? ` (${body.length}B)` : ''}`);
    route(request, response, url, body);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`fake official origin on http://127.0.0.1:${port} (song ${songId}, ${archive.length} bytes, ${entries.length} entries)`);
});

function route(request, response, url, body) {
  const pathname = url.pathname;

  if (pathname === '/api/rhydive/library' && request.method === 'GET') {
    return sendJson(response, catalog);
  }

  const manifestMatch = /^\/api\/rhydive\/library\/([^/]+)\/download$/.exec(pathname);
  if (manifestMatch && request.method === 'GET') {
    if (decodeURIComponent(manifestMatch[1]) !== songId) return sendJson(response, { success: false, message: 'not in library' }, 404);
    return sendJson(response, manifest);
  }

  const archiveMatch = /^\/api\/rhydive\/library\/([^/]+)\/archive$/.exec(pathname);
  if (archiveMatch && request.method === 'GET') {
    if (decodeURIComponent(archiveMatch[1]) !== songId) return sendText(response, 'not found', 404);
    response.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': String(archive.length),
      'content-disposition': `attachment; filename="${songId}.zip"`,
    });
    return response.end(request.method === 'HEAD' ? undefined : archive);
  }

  const assetMatch = /^\/api\/rhydive\/assets\/([^/]+)\/(.+)$/.exec(pathname);
  if (assetMatch && (request.method === 'GET' || request.method === 'HEAD')) {
    const id = decodeURIComponent(assetMatch[1]);
    const name = decodeURIComponent(assetMatch[2]);
    if (id !== songId) return sendText(response, 'not found', 404);
    const entry = entries.find((candidate) => candidate.name === name);
    if (!entry) return sendText(response, 'not found', 404);
    const bytes = extract(archive, entry);
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length), 'accept-ranges': 'bytes' });
    return response.end(request.method === 'HEAD' ? undefined : bytes);
  }

  if (pathname === '/api/session/current') {
    return sendJson(response, { success: false, user: null });
  }

  if (pathname === '/api/rhydive/results' && request.method === 'POST') {
    return sendJson(response, { success: true, saved: true, echoLength: body.length }, 201);
  }

  // Everything else echoes what reached the origin, so proxy fidelity is visible.
  return sendJson(response, {
    success: true,
    echo: { method: request.method, path: pathname, search: url.search, bodyLength: body.length },
  });
}

function sendJson(response, value, status = 200) {
  const payload = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(payload.length) });
  response.end(payload);
}

function sendText(response, value, status = 200) {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(value);
}

function readCentralDirectory(buffer) {
  const eocd = findEocd(buffer);
  if (eocd < 0) throw new Error('not a zip');
  const count = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  const out = [];
  let cursor = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('bad central directory');
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    out.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
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
