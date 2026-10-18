/**
 * A small in-memory stand-in for the R2 binding, implementing just the surface
 * the mirror uses (`get`, `head`, `put`, `delete`, `list`).
 */
import { createHash } from 'node:crypto';

export interface StoredObject {
  key: string;
  bytes: Uint8Array;
  httpMetadata?: { contentType?: string; cacheControl?: string };
  customMetadata?: Record<string, string>;
  uploaded: Date;
}

interface GetOptions {
  range?: { offset: number; length: number };
}

interface PutOptions {
  httpMetadata?: { contentType?: string; cacheControl?: string };
  customMetadata?: Record<string, string>;
  onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
}

function etagOf(bytes: Uint8Array): string {
  return `"${createHash('md5').update(bytes).digest('hex')}"`;
}

export class FakeR2 {
  private objects = new Map<string, StoredObject>();
  puts = 0;
  deletes = 0;
  gets = 0;
  deleteBatches: number[] = [];
  failPutKey: string | null = null;
  failDeleteKey: string | null = null;

  async get(key: string, options?: GetOptions): Promise<unknown> {
    this.gets += 1;
    const found = this.objects.get(key);
    if (!found) return null;
    const requested = options?.range;
    const bodyBytes = requested
      ? found.bytes.subarray(requested.offset, requested.offset + requested.length)
      : found.bytes;
    return {
      key,
      size: found.bytes.byteLength,
      etag: etagOf(found.bytes),
      httpEtag: etagOf(found.bytes),
      uploaded: found.uploaded,
      httpMetadata: found.httpMetadata,
      customMetadata: found.customMetadata,
      range: requested,
      body: new Response(bodyBytes as unknown as BodyInit).body,
      arrayBuffer: async () =>
        bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength) as ArrayBuffer,
      text: async () => new TextDecoder().decode(bodyBytes),
      json: async <T>() => JSON.parse(new TextDecoder().decode(bodyBytes)) as T,
    };
  }

  async head(key: string): Promise<unknown> {
    const found = this.objects.get(key);
    if (!found) return null;
    return {
      key,
      size: found.bytes.byteLength,
      etag: etagOf(found.bytes),
      httpEtag: etagOf(found.bytes),
      uploaded: found.uploaded,
      httpMetadata: found.httpMetadata,
      customMetadata: found.customMetadata,
    };
  }

  async put(
    key: string,
    value: unknown,
    options?: PutOptions,
  ): Promise<unknown> {
    if (this.failPutKey === key) throw new Error(`injected R2 put failure: ${key}`);
    const existing = this.objects.get(key);
    if (options?.onlyIf?.etagMatches !== undefined) {
      if (!existing || etagOf(existing.bytes) !== options.onlyIf.etagMatches) return null;
    }
    if (options?.onlyIf?.etagDoesNotMatch === '*' && existing) return null;
    this.puts += 1;
    const bytes = await toBytes(value);
    this.objects.set(key, {
      key,
      bytes,
      httpMetadata: options?.httpMetadata,
      customMetadata: options?.customMetadata,
      uploaded: new Date('2026-01-01T00:00:00.000Z'),
    });
    return { key, size: bytes.byteLength };
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    this.deleteBatches.push(list.length);
    if (this.failDeleteKey && list.includes(this.failDeleteKey)) {
      throw new Error(`injected R2 delete failure: ${this.failDeleteKey}`);
    }
    for (const key of list) {
      this.deletes += 1;
      this.objects.delete(key);
    }
  }

  async list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<unknown> {
    const prefix = options?.prefix ?? '';
    const matching = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    return {
      objects: matching.map((key) => ({
        key,
        size: this.objects.get(key)!.bytes.byteLength,
        etag: etagOf(this.objects.get(key)!.bytes),
        uploaded: this.objects.get(key)!.uploaded,
      })),
      truncated: false,
      cursor: undefined,
      delimitedPrefixes: [],
    };
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  keys(): string[] {
    return [...this.objects.keys()].sort();
  }

  /** Object keys referenced by the active-generation pointer. */
  generation(songId: string): {
    archiveHash: string;
    archiveKey: string;
    manifestKey: string;
    assetPaths: Record<string, string>;
    assetKeys?: Record<string, string>;
  } {
    return this.json(`_catalog/songs/${songId}.json`);
  }

  text(key: string): string {
    const found = this.objects.get(key);
    if (!found) throw new Error(`missing key: ${key}`);
    return new TextDecoder().decode(found.bytes);
  }

  json<T>(key: string): T {
    return JSON.parse(this.text(key)) as T;
  }

  bytes(key: string): Uint8Array {
    const found = this.objects.get(key);
    if (!found) throw new Error(`missing key: ${key}`);
    return found.bytes;
  }

  etag(key: string): string {
    const found = this.objects.get(key);
    if (!found) throw new Error(`missing key: ${key}`);
    return etagOf(found.bytes);
  }
}

async function toBytes(value: unknown): Promise<Uint8Array> {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value && typeof (value as { arrayBuffer?: unknown }).arrayBuffer === 'function') {
    return new Uint8Array(await (value as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer());
  }
  if (value && typeof (value as { getReader?: unknown }).getReader === 'function') {
    const reader = (value as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      chunks.push(chunk);
    }
    return concat(chunks);
  }
  throw new Error('FakeR2.put received an unsupported value');
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function asR2Bucket(bucket: FakeR2): R2Bucket {
  return bucket as unknown as R2Bucket;
}
