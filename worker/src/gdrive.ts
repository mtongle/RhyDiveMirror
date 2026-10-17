/**
 * Google Drive as a bulk object store — the same idea as OpenList/Alist's
 * Google Drive driver, reduced to what a mirror needs.
 *
 * Design decisions, and why:
 *
 *  - **OAuth refresh token of a real account, not a service account.** A service
 *    account has no Drive storage of its own, so uploads into a personal "My
 *    Drive" fail with `storageQuotaExceeded`; a refresh token spends the
 *    account's own quota (15 GB free, 2 TB/5 TB on Google One plans).
 *  - **`drive.file` scope.** The app only ever needs the files it created, which
 *    is exactly what this scope grants, so no restricted-scope verification is
 *    involved.
 *  - **Flat namespace, key encoded into the file name.** Drive has no atomic
 *    path KV; naming each file `encodeURIComponent(key)` inside one folder keeps
 *    lookups unambiguous, avoids a folder tree (and an index that can go stale),
 *    and makes the mirror folder self-describing in the Drive UI.
 *  - **No persistent id index.** A lookup is one `files.list` with an exact name
 *    query. Cold-tier reads can afford it, and there is nothing to invalidate.
 *  - **Range passthrough.** `files.get?alt=media` honours `Range`, so audio and
 *    video stream instead of being buffered whole.
 *
 * Consequences worth knowing: every read costs Drive API quota, Google throttles
 * heavily re-downloaded files ("download quota exceeded"), and using Drive as a
 * public content CDN is outside Google's terms. Keep the hot path in R2
 * (`STORAGE_LAYOUT=hybrid`) and treat Drive as the bulk/cold tier.
 */
import type { Config } from './config';
import type { FetchLike } from './fetch';
import type { BulkBody, BulkHead, BulkPutOptions, BulkStore } from './storage';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
/** Default resumable chunk size (8 MiB, 32 * 256 KiB). */
const DEFAULT_CHUNK = 8 * 1024 * 1024;
const MULTIPART_LIMIT = 4 * 1024 * 1024;
const TOKEN_KEY = '_system/gdrive/token.json';
const FOLDER_KEY = '_system/gdrive/folder.json';

export type GDriveConfig = NonNullable<Config['gdrive']>;

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

export class GDriveError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export class GDriveBulkStore implements BulkStore {
  readonly kind = 'gdrive';
  private tokenPromise: Promise<string> | null = null;
  private folderPromise: Promise<string> | null = null;

  constructor(
    /** R2 is always available: it caches the OAuth token and the folder id. */
    private readonly meta: R2Bucket,
    private readonly config: GDriveConfig,
    private readonly fetchImpl: FetchLike = (...args) => fetch(...args),
  ) {}

  // ---------------------------------------------------------------- auth ----

  private async accessToken(): Promise<string> {
    if (!this.tokenPromise) {
      this.tokenPromise = this.loadToken().catch((error) => {
        this.tokenPromise = null;
        throw error;
      });
    }
    return this.tokenPromise;
  }

  private async loadToken(): Promise<string> {
    const cached = await this.readMeta<CachedToken>(TOKEN_KEY);
    if (cached && cached.expiresAt - Date.now() > 300_000) return cached.accessToken;

    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: this.config.refreshToken,
      grant_type: 'refresh_token',
    });
    const response = await this.fetchImpl(this.config.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new GDriveError(`Drive token refresh failed (${response.status}) ${detail.slice(0, 200)}`, response.status);
    }
    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!payload.access_token) throw new GDriveError('Drive token refresh returned no access_token');
    const token: CachedToken = {
      accessToken: payload.access_token,
      expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
    };
    await this.writeMeta(TOKEN_KEY, token);
    return token.accessToken;
  }

  /** One folder holds every mirror object; created lazily unless configured. */
  private async folderId(): Promise<string> {
    if (this.config.folderId) return this.config.folderId;
    if (!this.folderPromise) {
      this.folderPromise = this.resolveFolder().catch((error) => {
        this.folderPromise = null;
        throw error;
      });
    }
    return this.folderPromise;
  }

  private async resolveFolder(): Promise<string> {
    const cached = await this.readMeta<{ id: string }>(FOLDER_KEY);
    if (cached?.id) {
      const exists = await this.request(`/files/${cached.id}?fields=id,trashed&supportsAllDrives=true`).catch(() => null);
      if (exists && exists.ok) {
        const info = (await exists.json()) as { id?: string; trashed?: boolean };
        if (info.id && !info.trashed) return info.id;
      }
    }
    // Search for an existing "RhyDiveMirror" folder in Drive before creating a duplicate
    const query = `name = 'RhyDiveMirror' and mimeType = '${FOLDER_MIME}' and trashed = false`;
    const search = await this.request(`/files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1&supportsAllDrives=true`).catch(() => null);
    if (search && search.ok) {
      const list = (await search.json().catch(() => null)) as { files?: { id: string }[] } | null;
      if (list?.files && list.files.length > 0 && list.files[0]?.id) {
        const existingId = list.files[0].id;
        await this.writeMeta(FOLDER_KEY, { id: existingId });
        return existingId;
      }
    }
    const created = await this.request(`/drive/v3/files?fields=id&supportsAllDrives=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'RhyDiveMirror', mimeType: FOLDER_MIME }),
    });
    if (!created.ok) throw new GDriveError(`cannot create Drive folder (${created.status})`, created.status);
    const payload = (await created.json()) as { id: string };
    await this.writeMeta(FOLDER_KEY, { id: payload.id });
    return payload.id;
  }

  // ------------------------------------------------------------- objects ----

  async head(key: string): Promise<BulkHead | null> {
    const file = await this.find(key);
    if (!file) return null;
    return {
      size: Number(file.size ?? 0),
      etag: `"${file.md5Checksum ?? md5Hex(key)}"`,
      uploaded: file.modifiedTime ? new Date(file.modifiedTime) : new Date(0),
      contentType: file.mimeType,
      cacheControl: 'public, max-age=31536000, immutable',
    };
  }

  async get(key: string, range?: { offset: number; length: number }): Promise<BulkBody | null> {
    const file = await this.find(key);
    if (!file) return null;
    const headers: Record<string, string> = {};
    if (range) headers.range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
    const response = await this.request(`/files/${file.id}?alt=media&supportsAllDrives=true`, { headers });
    if (response.status === 404) return null;
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new GDriveError(`Drive download of ${key} failed (${response.status}) ${detail.slice(0, 200)}`, response.status);
    }
    const sizeHeader = Number(response.headers.get('content-length') ?? '0');
    const total = Number(file.size ?? 0);
    return {
      size: range ? (sizeHeader || range.length) : (sizeHeader || total),
      etag: `"${file.md5Checksum ?? md5Hex(key)}"`,
      uploaded: file.modifiedTime ? new Date(file.modifiedTime) : new Date(0),
      contentType: response.headers.get('content-type') ?? file.mimeType,
      cacheControl: 'public, max-age=31536000, immutable',
      body: response.body,
      arrayBuffer: () => response.arrayBuffer(),
      text: () => response.text(),
    };
  }

  async put(key: string, value: ArrayBuffer | Uint8Array | string, options: BulkPutOptions = {}): Promise<void> {
    const bytes = toBytes(value);
    const name = encodeName(key);
    const existing = await this.find(key);
    const mimeType = options.contentType ?? 'application/octet-stream';
    const parents = [await this.folderId()];

    if (!existing && bytes.byteLength <= MULTIPART_LIMIT) {
      await this.multipartUpload(name, bytes, mimeType, parents);
      return;
    }
    await this.resumableUpload(bytes, mimeType, existing?.id ?? null, existing ? null : name, parents);
  }

  async delete(keys: string[]): Promise<void> {
    for (const key of keys) {
      const file = await this.find(key).catch(() => null);
      if (!file) continue;
      const response = await this.request(`/files/${file.id}?supportsAllDrives=true`, { method: 'DELETE' });
      if (!response.ok && response.status !== 404) {
        throw new GDriveError(`cannot delete ${key} from Drive (${response.status})`, response.status);
      }
    }
  }

  async status(): Promise<Record<string, unknown>> {
    const response = await this.request(
      `/drive/v3/about?fields=storageQuota,user(emailAddress,displayName)&supportsAllDrives=true`,
    ).catch(() => null);
    if (!response || !response.ok) return { driver: 'gdrive', quota: 'unavailable' };
    const payload = (await response.json()) as {
      storageQuota?: { limit?: string; usage?: string; usageInDrive?: string };
      user?: { emailAddress?: string };
    };
    const limit = Number(payload.storageQuota?.limit ?? 0);
    const usage = Number(payload.storageQuota?.usage ?? 0);
    return {
      driver: 'gdrive',
      account: maskEmail(payload.user?.emailAddress),
      limitBytes: limit,
      usageBytes: usage,
      freeBytes: limit > 0 ? limit - usage : null,
      usageInDriveBytes: Number(payload.storageQuota?.usageInDrive ?? 0),
      rootFolderId: await this.folderId().catch(() => null),
    };
  }

  // ------------------------------------------------------------- internals ---

  private get apiBase(): string {
    return `${this.config.apiBase}/drive/v3`;
  }

  private get uploadBase(): string {
    return `${this.config.apiBase}/upload/drive/v3`;
  }

  private request(path: string, init: RequestInit = {}): Promise<Response> {
    return this.withAuth(async (token) => {
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${token}`);
      const target = path.startsWith('http')
        ? path
        : path.startsWith('/drive/') || path.startsWith('/upload/')
          ? `${this.config.apiBase}${path}`
          : `${this.apiBase}${path}`;
      return this.fetchImpl(target, { ...init, headers, redirect: 'manual' });
    });
  }

  /** Retry once on 401 so a revoked/expired cached token self-heals. */
  private async withAuth(run: (token: string) => Promise<Response>): Promise<Response> {
    const response = await run(await this.accessToken());
    if (response.status !== 401) return response;
    await response.body?.cancel();
    this.tokenPromise = null;
    await this.meta.delete(TOKEN_KEY);
    return run(await this.accessToken());
  }

  private async find(key: string): Promise<DriveFile | null> {
    const parent = await this.folderId();
    const query = `name = '${escapeQuery(encodeName(key))}' and '${parent}' in parents and trashed = false`;
    const params = new URLSearchParams({
      q: query,
      fields: 'files(id,name,size,md5Checksum,modifiedTime,mimeType,appProperties)',
      pageSize: '10',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    const response = await this.request(`/files?${params.toString()}`);
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new GDriveError(`Drive lookup of ${key} failed (${response.status}) ${detail.slice(0, 200)}`, response.status);
    }
    const payload = (await response.json()) as { files?: DriveFile[] };
    return payload.files?.[0] ?? null;
  }

  private async multipartUpload(name: string, bytes: Uint8Array, mimeType: string, parents: string[]): Promise<void> {
    const boundary = `rhydive${crypto.randomUUID().replaceAll('-', '')}`;
    const metadata = JSON.stringify({ name, mimeType, parents });
    const head = `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\ncontent-type: ${mimeType}\r\n\r\n`;
    const tail = `\r\n--${boundary}--`;
    const body = concat([encode(head), bytes, encode(tail)]);
    const response = await this.request(
      `${this.uploadBase}/files?uploadType=multipart&fields=id&supportsAllDrives=true`,
      {
        method: 'POST',
        headers: { 'content-type': `multipart/related; boundary=${boundary}` },
        body,
      },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new GDriveError(`Drive upload of ${name} failed (${response.status}) ${detail.slice(0, 200)}`, response.status);
    }
    await response.body?.cancel();
  }

  /**
   * Resumable upload: start a session, then send chunks. Works for both create
   * (`POST`) and content replacement (`PATCH` on the existing file id).
   */
  private async resumableUpload(
    bytes: Uint8Array,
    mimeType: string,
    existingId: string | null,
    name: string | null,
    parents: string[],
  ): Promise<void> {
    const sessionUrl = existingId
      ? `${this.uploadBase}/files/${existingId}?uploadType=resumable&fields=id&supportsAllDrives=true`
      : `${this.uploadBase}/files?uploadType=resumable&fields=id&supportsAllDrives=true`;
    const method = existingId ? 'PATCH' : 'POST';
    const started = await this.request(sessionUrl, {
      method,
      headers: {
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-type': mimeType,
        'x-upload-content-length': String(bytes.byteLength),
      },
      body: existingId ? null : JSON.stringify({ name, mimeType, parents }),
    });
    if (!started.ok) {
      const detail = await started.text().catch(() => '');
      throw new GDriveError(`Drive upload session failed (${started.status}) ${detail.slice(0, 200)}`, started.status);
    }
    const location = started.headers.get('location');
    await started.body?.cancel();
    if (!location) throw new GDriveError('Drive upload session returned no Location header');

    const token = await this.accessToken();
    const chunkSize = this.config.chunkSizeBytes ?? DEFAULT_CHUNK;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      const chunk = bytes.subarray(offset, end);
      const response = await this.fetchImpl(location, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-length': String(chunk.byteLength),
          'content-range': `bytes ${offset}-${end - 1}/${bytes.byteLength}`,
        },
        body: chunk as unknown as BodyInit,
      });
      const ok = response.status === 200 || response.status === 201 || response.status === 308;
      if (!ok) {
        const detail = await response.text().catch(() => '');
        throw new GDriveError(
          `Drive chunk upload failed at ${offset} (${response.status}) ${detail.slice(0, 200)}`,
          response.status,
        );
      }
      await response.body?.cancel();
    }
  }

  private async readMeta<T>(key: string): Promise<T | null> {
    const object = await this.meta.get(key);
    if (!object) return null;
    try {
      return (await object.json()) as T;
    } catch {
      return null;
    }
  }

  private async writeMeta(key: string, value: unknown): Promise<void> {
    await this.meta.put(key, JSON.stringify(value), {
      httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' },
    });
  }
}

interface DriveFile {
  id: string;
  name?: string;
  size?: string;
  md5Checksum?: string;
  modifiedTime?: string;
  mimeType?: string;
}

function encodeName(key: string): string {
  return encodeURIComponent(key);
}

function escapeQuery(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function toBytes(value: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof value === 'string') return encode(value);
  if (value instanceof Uint8Array) return value;
  return new Uint8Array(value);
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

function maskEmail(email?: string): string | undefined {
  if (!email || !email.includes('@')) return email;
  const [user, domain] = email.split('@');
  if (!user || user.length <= 2) return `***@${domain}`;
  return `${user[0]}***${user.slice(-1)}@${domain}`;
}

function md5Hex(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return hash.toString(16).padStart(8, '0');
}
