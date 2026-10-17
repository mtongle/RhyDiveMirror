/**
 * In-memory Google Drive API v3 emulator.
 *
 * Implements the subset `GDriveBulkStore` uses — OAuth token refresh, exact-name
 * lookup, multipart and resumable uploads, ranged media download, delete and
 * `about` quota — so the driver can be exercised end to end without credentials.
 */

export interface FakeDriveFile {
  id: string;
  name: string;
  parents: string[];
  mimeType: string;
  bytes: Uint8Array;
  modifiedTime: string;
}

export interface FakeDriveOptions {
  /** Token lifetime in seconds; short values let tests exercise refresh. */
  tokenTtlSeconds?: number;
  /** Reject the first N media reads with 403 to emulate throttling. */
  throttleReads?: number;
  /** Storage quota reported by about.get. */
  quotaLimit?: number;
  quotaUsage?: number;
}

export class FakeDriveAuthError extends Error {}

export class FakeDrive {
  readonly origin = 'https://drive.test';
  files = new Map<string, FakeDriveFile>();
  tokenRequests = 0;
  uploads = 0;
  downloads = 0;
  lookups = 0;
  deletes = 0;

  private nextId = 1;
  private sessions = new Map<string, { fileId: string | null; name: string | null; mimeType: string; parents: string[]; received: Uint8Array[]; total: number }>();
  private issuedTokens = new Set<string>();
  private readonly tokenTtl: number;
  private throttleReads: number;
  private readonly quotaLimit: number;
  private readonly quotaUsage: number;

  constructor(options: FakeDriveOptions = {}) {
    this.tokenTtl = options.tokenTtlSeconds ?? 3600;
    this.throttleReads = options.throttleReads ?? 0;
    this.quotaLimit = options.quotaLimit ?? 5_000_000_000_000;
    this.quotaUsage = options.quotaUsage ?? 21_000_000_000;
  }

  /** Expire every issued token, forcing the driver to refresh. */
  expireTokens(): void {
    this.issuedTokens.clear();
  }

  /** `fetch` implementation to hand to `GDriveBulkStore`. */
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(String(input), init);
    const url = new URL(request.url);

    if (url.href === 'https://oauth2.googleapis.com/token') {
      this.tokenRequests += 1;
      const body = new URLSearchParams(await request.text());
      if (body.get('grant_type') !== 'refresh_token' || !body.get('refresh_token')) {
        return json({ error: 'invalid_grant' }, 400);
      }
      const token = `fake-access-${this.tokenRequests}`;
      this.issuedTokens.add(token);
      return json({ access_token: token, expires_in: this.tokenTtl, token_type: 'Bearer' });
    }

    if (!this.authorized(request)) return json({ error: { message: 'Invalid Credentials' } }, 401);

    const path = url.pathname;
    if (path === '/upload-session' || path.startsWith('/upload-session/')) {
      return this.handleResumable(request, url);
    }
    if (path.startsWith('/upload/drive/v3/files')) {
      return this.handleUpload(request, url);
    }
    if (path.startsWith('/drive/v3/about')) {
      return json({
        storageQuota: { limit: String(this.quotaLimit), usage: String(this.quotaUsage), usageInDrive: String(this.quotaUsage) },
        user: { emailAddress: 'mirror@example.com', displayName: 'Mirror' },
      });
    }
    if (path === '/drive/v3/files' && request.method === 'GET') {
      return this.handleList(url);
    }
    if (path === '/drive/v3/files' && request.method === 'POST') {
      return this.handleCreate(request);
    }
    const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
    if (fileMatch) {
      if (request.method === 'GET') return this.handleGet(request, fileMatch[1]!, url);
      if (request.method === 'DELETE') return this.handleDelete(fileMatch[1]!);
    }
    return json({ error: { message: `unhandled ${request.method} ${path}` } }, 404);
  };

  createFolder(name: string, parents: string[] = []): string {
    const id = `folder-${this.nextId++}`;
    this.files.set(id, {
      id,
      name,
      parents,
      mimeType: 'application/vnd.google-apps.folder',
      bytes: new Uint8Array(),
      modifiedTime: new Date('2026-01-01T00:00:00Z').toISOString(),
    });
    return id;
  }

  /** All non-folder children of a folder, by decoded key name. */
  namesIn(parentId: string): string[] {
    return [...this.files.values()]
      .filter((file) => file.mimeType !== 'application/vnd.google-apps.folder' && file.parents.includes(parentId))
      .map((file) => file.name)
      .sort();
  }

  private authorized(request: Request): boolean {
    const header = request.headers.get('authorization');
    if (!header?.startsWith('Bearer ')) return false;
    return this.issuedTokens.has(header.slice(7));
  }

  private async handleCreate(request: Request): Promise<Response> {
    const metadata = (await request.json()) as { name: string; mimeType?: string; parents?: string[] };
    const id = `file-${this.nextId++}`;
    this.files.set(id, {
      id,
      name: metadata.name,
      parents: metadata.parents ?? [],
      mimeType: metadata.mimeType ?? 'application/octet-stream',
      bytes: new Uint8Array(),
      modifiedTime: new Date('2026-01-01T00:00:00Z').toISOString(),
    });
    return json({ id, name: metadata.name });
  }

  private handleList(url: URL): Response {
    this.lookups += 1;
    const query = url.searchParams.get('q') ?? '';
    const name = /name = '((?:[^'\\]|\\.)*)'/.exec(query)?.[1];
    const parent = /'([^']+)' in parents/.exec(query)?.[1];
    const decodedName = name?.replace(/\\(.)/g, '$1');
    const matches = [...this.files.values()].filter(
      (file) =>
        file.mimeType !== 'application/vnd.google-apps.folder' &&
        (decodedName === undefined || file.name === decodedName) &&
        (parent === undefined || file.parents.includes(parent)),
    );
    return json({
      files: matches.map((file) => ({
        id: file.id,
        name: file.name,
        size: String(file.bytes.byteLength),
        md5Checksum: md5Hex(file.bytes),
        modifiedTime: file.modifiedTime,
        mimeType: file.mimeType,
      })),
    });
  }

  private handleGet(request: Request, id: string, url: URL): Response {
    const file = this.files.get(id);
    if (!file) return json({ error: { message: 'File not found' } }, 404);
    if (url.searchParams.get('alt') !== 'media') {
      return json({ id: file.id, name: file.name, size: String(file.bytes.byteLength), mimeType: file.mimeType, trashed: false });
    }
    this.downloads += 1;
    if (this.throttleReads > 0) {
      this.throttleReads -= 1;
      return json({ error: { message: 'Download quota exceeded for this file' } }, 403);
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get('range') ?? '');
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), file.bytes.byteLength - 1);
      const slice = file.bytes.subarray(start, end + 1);
      return new Response(slice as unknown as BodyInit, {
        status: 206,
        headers: {
          'content-type': file.mimeType,
          'content-length': String(slice.byteLength),
          'content-range': `bytes ${start}-${end}/${file.bytes.byteLength}`,
        },
      });
    }
    return new Response(file.bytes as unknown as BodyInit, {
      headers: { 'content-type': file.mimeType, 'content-length': String(file.bytes.byteLength) },
    });
  }

  private handleDelete(id: string): Response {
    this.deletes += 1;
    this.files.delete(id);
    return new Response(null, { status: 204 });
  }

  private handleUpload(request: Request, url: URL): Response | Promise<Response> {
    const uploadType = url.searchParams.get('uploadType');
    if (uploadType === 'resumable') return this.startSession(request, url);
    if (uploadType === 'multipart') return this.multipart(request);
    return json({ error: { message: `unsupported uploadType ${uploadType}` } }, 400);
  }

  private async startSession(request: Request, _url: URL): Promise<Response> {
    const metadata = request.method === 'PATCH' ? null : ((await request.json()) as { name: string; mimeType: string; parents: string[] });
    const existing = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(new URL(request.url).pathname);
    const sessionId = `session-${this.nextId++}`;
    this.sessions.set(sessionId, {
      fileId: existing ? existing[1]! : null,
      name: metadata?.name ?? null,
      mimeType: metadata?.mimeType ?? request.headers.get('x-upload-content-type') ?? 'application/octet-stream',
      parents: metadata?.parents ?? [],
      received: [],
      total: Number(request.headers.get('x-upload-content-length') ?? '0'),
    });
    return new Response(null, {
      status: 200,
      headers: { location: `${this.origin}/upload-session/${sessionId}` },
    });
  }

  private async handleResumable(request: Request, url: URL): Promise<Response> {
    const sessionId = url.pathname.split('/').pop()!;
    const session = this.sessions.get(sessionId);
    if (!session) return json({ error: { message: 'no such session' } }, 404);
    const body = new Uint8Array(await request.arrayBuffer());
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(request.headers.get('content-range') ?? '');
    if (!range) return json({ error: { message: 'missing content-range' } }, 400);
    const [, rawStart, rawEnd, rawTotal] = range;
    if (Number(rawStart) !== session.received.reduce((sum, part) => sum + part.byteLength, 0)) {
      return json({ error: { message: 'chunk out of order' } }, 400);
    }
    session.received.push(body);
    session.total = Number(rawTotal);
    const end = Number(rawEnd) + 1;
    if (end < session.total) return new Response(null, { status: 308 });

    const bytes = concat(session.received);
    this.sessions.delete(sessionId);
    this.uploads += 1;
    const id = session.fileId ?? `file-${this.nextId++}`;
    const previous = this.files.get(id);
    this.files.set(id, {
      id,
      name: session.name ?? previous?.name ?? `unnamed-${id}`,
      parents: session.parents.length > 0 ? session.parents : (previous?.parents ?? []),
      mimeType: session.mimeType,
      bytes,
      modifiedTime: new Date('2026-02-01T00:00:00Z').toISOString(),
    });
    return json({ id, name: this.files.get(id)!.name, size: String(bytes.byteLength) });
  }

  private async multipart(request: Request): Promise<Response> {
    const contentType = request.headers.get('content-type') ?? '';
    const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
    if (!boundary) return json({ error: { message: 'missing multipart boundary' } }, 400);
    const body = new Uint8Array(await request.arrayBuffer());
    const parts = splitMultipart(body, boundary);
    if (parts.length < 2) return json({ error: { message: 'malformed multipart body' } }, 400);
    const metadata = JSON.parse(new TextDecoder().decode(parts[0]!.body)) as {
      name: string;
      mimeType: string;
      parents: string[];
    };
    this.uploads += 1;
    const id = `file-${this.nextId++}`;
    this.files.set(id, {
      id,
      name: metadata.name,
      parents: metadata.parents ?? [],
      mimeType: parts[1]!.contentType || metadata.mimeType,
      bytes: parts[1]!.body,
      modifiedTime: new Date('2026-02-01T00:00:00Z').toISOString(),
    });
    return json({ id, name: metadata.name, size: String(parts[1]!.body.byteLength) });
  }
}

function splitMultipart(body: Uint8Array, boundary: string): { contentType: string; body: Uint8Array }[] {
  const text = latin1(body);
  const marker = `--${boundary}`;
  const segments = text.split(marker).slice(1, -1);
  const parts: { contentType: string; body: Uint8Array }[] = [];
  // Re-scan the raw bytes using the marker positions so binary content survives.
  const positions: number[] = [];
  let search = 0;
  for (;;) {
    const at = text.indexOf(marker, search);
    if (at < 0) break;
    positions.push(at);
    search = at + marker.length;
  }
  // Segment between marker i and marker i+1 (the last marker is the closing one).
  for (let i = 0; i < positions.length - 1; i++) {
    const start = positions[i]! + marker.length + 2; // skip CRLF
    const end = positions[i + 1]! - 2; // drop trailing CRLF
    const chunk = body.subarray(start, end);
    const headerEnd = indexOfDoubleCrlf(chunk);
    const headerText = latin1(chunk.subarray(0, headerEnd));
    const contentType = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1] ?? '';
    parts.push({ contentType, body: chunk.subarray(headerEnd + 4) });
  }
  return parts;
}

function indexOfDoubleCrlf(bytes: Uint8Array): number {
  for (let i = 0; i + 3 < bytes.byteLength; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i;
  }
  return bytes.byteLength;
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function md5Hex(bytes: Uint8Array): string {
  // Not a real MD5; the driver only needs a stable etag.
  let hash = 0;
  for (const byte of bytes) hash = (hash * 31 + byte) >>> 0;
  return hash.toString(16).padStart(8, '0');
}
