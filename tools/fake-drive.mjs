#!/usr/bin/env node
/**
 * Standalone emulator of the Google Drive subset the mirror uses.
 *
 * Lets you run the whole stack — `wrangler dev`, sync, serving, hybrid layout —
 * without touching a real Drive account:
 *
 *   node tools/fake-drive.mjs --port 8898 &
 *   cd worker && npx wrangler dev \
 *     --var STORAGE_LAYOUT:hybrid \
 *     --var GDRIVE_CLIENT_ID:fake --var GDRIVE_CLIENT_SECRET:fake \
 *     --var GDRIVE_REFRESH_TOKEN:fake
 *   # and point the API endpoints at the fake origin as well
 *
 * Google endpoints are matched by path, so set OFFICIAL_* to your fake origin
 * and let the worker resolve googleapis.com by DNS — in local dev, add
 * `--var GDRIVE_API_BASE:http://127.0.0.1:8898` if you want to avoid DNS tricks.
 */

import { createServer } from 'node:http';

const args = parseArgs(process.argv.slice(2));
const port = Number(args.port ?? 8898);
const origin = `http://127.0.0.1:${port}`;

const files = new Map();
const sessions = new Map();
const tokens = new Set();
let nextId = 1;
let tokenRequests = 0;

const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const url = new URL(request.url, origin);
    const body = Buffer.concat(chunks);
    try {
      route(request, response, url, body);
    } catch (error) {
      sendJson(response, { error: { message: String(error.message) } }, 500);
    }
  });
});
server.listen(port, '127.0.0.1', () =>
  console.log(`fake Google Drive on ${origin} (set GDRIVE_* to any value, tokens are issued locally)`),
);

function route(request, response, url, body) {
  if (url.pathname === '/token') {
    tokenRequests += 1;
    const token = `fake-access-${tokenRequests}`;
    tokens.add(token);
    return sendJson(response, { access_token: token, expires_in: 3600, token_type: 'Bearer' });
  }
  if (url.pathname === '/stats') {
    return sendJson(response, {
      files: files.size,
      objects: [...files.values()].filter((f) => f.mimeType !== FOLDER).length,
      bytes: [...files.values()].reduce((total, f) => total + f.bytes.length, 0),
      uploads: uploads,
      downloads,
      tokenRequests,
    });
  }
  const token = (request.headers.authorization ?? '').replace('Bearer ', '');
  if (!tokens.has(token)) return sendJson(response, { error: { message: 'Invalid Credentials' } }, 401);

  if (url.pathname.startsWith('/upload-session/')) return resumableChunk(request, response, url, body);
  if (url.pathname === '/upload/drive/v3/files') {
    const type = url.searchParams.get('uploadType');
    if (type === 'resumable') return startSession(request, response, url);
    if (type === 'multipart') return multipart(request, response, body);
    return sendJson(response, { error: { message: `unsupported uploadType ${type}` } }, 400);
  }
  if (url.pathname === '/drive/v3/files' && request.method === 'GET') return list(response, url);
  if (url.pathname === '/drive/v3/files' && request.method === 'POST') return create(request, response, body);
  if (url.pathname === '/drive/v3/about') {
    return sendJson(response, {
      storageQuota: { limit: String(5_000_000_000_000), usage: String(21_400_000_000), usageInDrive: String(21_400_000_000) },
      user: { emailAddress: 'fake@example.com', displayName: 'Fake Drive' },
    });
  }
  const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
  if (fileMatch) {
    if (request.method === 'GET') return getFile(request, response, url, fileMatch[1]);
    if (request.method === 'DELETE') {
      files.delete(fileMatch[1]);
      response.writeHead(204);
      return response.end();
    }
  }
  return sendJson(response, { error: { message: `unhandled ${request.method} ${url.pathname}` } }, 404);
}

const FOLDER = 'application/vnd.google-apps.folder';
let uploads = 0;
let downloads = 0;

function create(request, response, body) {
  const metadata = JSON.parse(body.toString('utf8'));
  const id = `file-${nextId++}`;
  files.set(id, {
    id,
    name: metadata.name,
    parents: metadata.parents ?? [],
    mimeType: metadata.mimeType ?? 'application/octet-stream',
    bytes: Buffer.alloc(0),
    modifiedTime: new Date('2026-01-01T00:00:00Z').toISOString(),
  });
  return sendJson(response, { id, name: metadata.name });
}

function list(response, url) {
  const query = url.searchParams.get('q') ?? '';
  const name = /name = '((?:[^'\\]|\\.)*)'/.exec(query)?.[1]?.replace(/\\(.)/g, '$1');
  const parent = /'([^']+)' in parents/.exec(query)?.[1];
  const matches = [...files.values()].filter(
    (file) =>
      file.mimeType !== FOLDER &&
      (name === undefined || file.name === name) &&
      (parent === undefined || file.parents.includes(parent)),
  );
  return sendJson(response, {
    files: matches.map((file) => ({
      id: file.id,
      name: file.name,
      size: String(file.bytes.length),
      md5Checksum: `md5-${file.id}`,
      modifiedTime: file.modifiedTime,
      mimeType: file.mimeType,
    })),
  });
}

function getFile(request, response, url, id) {
  const file = files.get(id);
  if (!file) return sendJson(response, { error: { message: 'File not found' } }, 404);
  if (url.searchParams.get('alt') !== 'media') {
    return sendJson(response, { id: file.id, name: file.name, size: String(file.bytes.length), mimeType: file.mimeType, trashed: false });
  }
  downloads += 1;
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), file.bytes.length - 1) : file.bytes.length - 1;
    const slice = file.bytes.subarray(start, end + 1);
    response.writeHead(206, {
      'content-type': file.mimeType,
      'content-length': String(slice.length),
      'content-range': `bytes ${start}-${end}/${file.bytes.length}`,
    });
    return response.end(slice);
  }
  response.writeHead(200, { 'content-type': file.mimeType, 'content-length': String(file.bytes.length) });
  return response.end(file.bytes);
}

function startSession(request, response, url) {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks);
    const metadata = body.length > 0 ? JSON.parse(body.toString('utf8')) : null;
    const existing = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    const sessionId = `session-${nextId++}`;
    sessions.set(sessionId, {
      fileId: existing ? existing[1] : null,
      name: metadata?.name ?? null,
      mimeType: metadata?.mimeType ?? request.headers['x-upload-content-type'] ?? 'application/octet-stream',
      parents: metadata?.parents ?? [],
      chunks: [],
      total: Number(request.headers['x-upload-content-length'] ?? 0),
    });
    response.writeHead(200, { location: `${origin}/upload-session/${sessionId}` });
    response.end();
  });
}

function resumableChunk(request, response, url, body) {
  const session = sessions.get(url.pathname.split('/').pop());
  if (!session) return sendJson(response, { error: { message: 'no such session' } }, 404);
  const received = session.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(request.headers['content-range'] ?? '');
  if (!range) return sendJson(response, { error: { message: 'missing content-range' } }, 400);
  const start = Number(range[1]);
  const end = Number(range[2]) + 1;
  if (start !== received) return sendJson(response, { error: { message: 'chunk out of order' } }, 400);
  session.chunks.push(body);
  session.total = Number(range[3]);
  if (end < session.total) {
    response.writeHead(308);
    return response.end();
  }
  const bytes = Buffer.concat(session.chunks);
  sessions.delete(url.pathname.split('/').pop());
  uploads += 1;
  const id = session.fileId ?? `file-${nextId++}`;
  const previous = files.get(id);
  files.set(id, {
    id,
    name: session.name ?? previous?.name ?? `unnamed-${id}`,
    parents: session.parents.length > 0 ? session.parents : (previous?.parents ?? []),
    mimeType: session.mimeType,
    bytes,
    modifiedTime: new Date('2026-02-01T00:00:00Z').toISOString(),
  });
  return sendJson(response, { id, name: files.get(id).name, size: String(bytes.length) });
}

function multipart(request, response, body) {
  const boundary = /boundary=(.+)$/.exec(request.headers['content-type'] ?? '')?.[1];
  if (!boundary) return sendJson(response, { error: { message: 'missing boundary' } }, 400);
  const marker = Buffer.from(`--${boundary}`);
  const positions = [];
  let search = 0;
  for (;;) {
    const at = body.indexOf(marker, search);
    if (at < 0) break;
    positions.push(at);
    search = at + marker.length;
  }
  if (positions.length < 3) return sendJson(response, { error: { message: 'malformed multipart body' } }, 400);
  const segments = [];
  for (let i = 0; i < positions.length - 1; i++) {
    const start = positions[i] + marker.length + 2;
    const end = positions[i + 1] - 2;
    const chunk = body.subarray(start, end);
    const headerEnd = chunk.indexOf('\r\n\r\n');
    segments.push({
      headers: chunk.subarray(0, headerEnd).toString('utf8'),
      body: chunk.subarray(headerEnd + 4),
    });
  }
  const metadata = JSON.parse(segments[0].body.toString('utf8'));
  const contentType = /content-type:\s*([^\r\n]+)/i.exec(segments[1].headers)?.[1] ?? metadata.mimeType;
  uploads += 1;
  const id = `file-${nextId++}`;
  files.set(id, {
    id,
    name: metadata.name,
    parents: metadata.parents ?? [],
    mimeType: contentType,
    bytes: segments[1].body,
    modifiedTime: new Date('2026-02-01T00:00:00Z').toISOString(),
  });
  return sendJson(response, { id, name: metadata.name, size: String(segments[1].body.length) });
}

function sendJson(response, value, status = 200) {
  const payload = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(payload.length) });
  response.end(payload);
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
