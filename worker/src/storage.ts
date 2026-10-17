/**
 * Storage tiers.
 *
 * The mirror keeps two kinds of objects:
 *
 *  - **metadata** (catalog, per-song manifests, sync state) — a few megabytes,
 *    read on nearly every request. Always R2, always the source of truth.
 *  - **bulk** (archives and extracted assets) — tens of gigabytes. Pluggable:
 *    R2, Google Drive, or a mix.
 *
 * `BulkStore` is the small interface the mirror needs for bulk objects, so the
 * serve path and the sync path do not care which backend is behind it.
 */
import type { Config, StorageLayout } from './config';
import { globalFetch, type FetchLike } from './fetch';
import { GDriveBulkStore } from './gdrive';

export interface BulkHead {
  size: number;
  etag: string;
  uploaded: Date;
  contentType?: string;
  cacheControl?: string;
  customMetadata?: Record<string, string>;
}

export interface BulkBody extends BulkHead {
  body?: ReadableStream | null;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export interface BulkPutOptions {
  contentType?: string;
  cacheControl?: string;
  customMetadata?: Record<string, string>;
  /** Key the caller is storing, used by drivers that need it for side effects. */
  key?: string;
}

export interface BulkStore {
  readonly kind: string;
  head(key: string): Promise<BulkHead | null>;
  get(key: string, range?: { offset: number; length: number }): Promise<BulkBody | null>;
  put(key: string, value: ArrayBuffer | Uint8Array | string, options?: BulkPutOptions): Promise<void>;
  delete(keys: string[]): Promise<void>;
  /** Backend-specific diagnostics for /__admin/status (quota, etc.). */
  status?(): Promise<Record<string, unknown>>;
}

/** Adapter over the R2 binding (whose surface already matches closely). */
export class R2BulkStore implements BulkStore {
  readonly kind = 'r2';

  constructor(private readonly bucket: R2Bucket) {}

  async head(key: string): Promise<BulkHead | null> {
    const object = await this.bucket.head(key);
    if (!object) return null;
    return {
      size: object.size,
      etag: object.httpEtag,
      uploaded: object.uploaded,
      contentType: object.httpMetadata?.contentType,
      cacheControl: object.httpMetadata?.cacheControl,
      customMetadata: object.customMetadata,
    };
  }

  async get(key: string, range?: { offset: number; length: number }): Promise<BulkBody | null> {
    const object = await this.bucket.get(key, range ? { range } : undefined);
    if (!object) return null;
    return {
      size: object.size,
      etag: object.httpEtag,
      uploaded: object.uploaded,
      contentType: object.httpMetadata?.contentType,
      cacheControl: object.httpMetadata?.cacheControl,
      customMetadata: object.customMetadata,
      body: object.body,
      arrayBuffer: () => object.arrayBuffer(),
      text: () => object.text(),
    };
  }

  async put(key: string, value: ArrayBuffer | Uint8Array | string, options: BulkPutOptions = {}): Promise<void> {
    await this.bucket.put(key, value as ArrayBuffer | ArrayBufferView | string, {
      httpMetadata: {
        ...(options.contentType ? { contentType: options.contentType } : {}),
        ...(options.cacheControl ? { cacheControl: options.cacheControl } : {}),
      },
      ...(options.customMetadata ? { customMetadata: options.customMetadata } : {}),
    });
  }

  async delete(keys: string[]): Promise<void> {
    if (keys.length > 0) await this.bucket.delete(keys);
  }

  async status(): Promise<Record<string, unknown>> {
    return { driver: 'r2' };
  }
}

/**
 * Two-tier store.
 *
 * Writes go to `primary(key)`; reads try the primary, then the other tier, then
 * give up (the caller falls back to proxying the origin). Reading both tiers
 * means changing `STORAGE_LAYOUT` never strands objects that were written under
 * the previous layout.
 */
export class TieredBulkStore implements BulkStore {
  readonly kind: string;

  constructor(
    private readonly r2: BulkStore,
    private readonly drive: BulkStore | null,
    private readonly primaryOf: (key: string) => 'r2' | 'gdrive',
    private readonly layout: StorageLayout,
  ) {
    this.kind = layout === 'hybrid' ? 'hybrid' : (drive ? 'gdrive' : 'r2');
  }

  private storeFor(tier: 'r2' | 'gdrive'): BulkStore | null {
    return tier === 'r2' ? this.r2 : this.drive;
  }

  async head(key: string): Promise<BulkHead | null> {
    for (const tier of this.readOrder(key)) {
      const store = this.storeFor(tier);
      if (!store) continue;
      const found = await store.head(key).catch(() => null);
      if (found) return found;
    }
    return null;
  }

  async get(key: string, range?: { offset: number; length: number }): Promise<BulkBody | null> {
    for (const tier of this.readOrder(key)) {
      const store = this.storeFor(tier);
      if (!store) continue;
      const found = await store.get(key, range).catch(() => null);
      if (found) return found;
    }
    return null;
  }

  async put(key: string, value: ArrayBuffer | Uint8Array | string, options: BulkPutOptions = {}): Promise<void> {
    const store = this.storeFor(this.primaryOf(key));
    if (!store) throw new Error(`storage layout ${this.layout} selected for ${key} but that tier is not configured`);
    await store.put(key, value, options);
  }

  async delete(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    // Delete from both tiers so cleanup is layout-independent.
    await Promise.all(
      [this.r2, this.drive].filter(Boolean).map((store) => store!.delete(keys).catch(() => undefined)),
    );
  }

  async status(): Promise<Record<string, unknown>> {
    const [r2, drive] = await Promise.all([
      this.r2.status?.().catch(() => undefined),
      this.drive?.status?.().catch(() => undefined),
    ]);
    return { layout: this.layout, r2, gdrive: drive };
  }

  private readOrder(key: string): ('r2' | 'gdrive')[] {
    const primary = this.primaryOf(key);
    if (!this.drive || this.layout === 'r2') return ['r2'];
    if (this.layout === 'gdrive') return ['gdrive', 'r2'];
    return primary === 'r2' ? ['r2', 'gdrive'] : ['gdrive', 'r2'];
  }
}

/** True for the small, latency-sensitive assets served while browsing. */
export function isHotAssetKey(key: string): boolean {
  const name = key.slice(key.indexOf('/') + 1);
  const base = name.split('/').pop() ?? name;
  if (/^(bg|background|cover|audio|preview)\./i.test(base)) return true;
  return /\.osu$/i.test(base);
}

/**
 * Which tier owns a bulk key under the configured layout.
 * Archives are the bulk of the bytes; hot assets are the interactive path.
 */
export function primaryTierFor(layout: StorageLayout, key: string): 'r2' | 'gdrive' {
  // Metadata is strictly R2-only under all storage layouts
  if (key.startsWith('_catalog/')) return 'r2';
  if (layout === 'r2') return 'r2';
  if (layout === 'gdrive') return 'gdrive';
  // In hybrid layout: archives (*.zip) live in Google Drive; all assets live in R2
  return key.endsWith('.zip') ? 'gdrive' : 'r2';
}

export function createBulkStore(
  env: { MIRROR: R2Bucket },
  config: Config,
  fetchImpl: FetchLike = globalFetch,
): BulkStore {
  const r2 = new R2BulkStore(env.MIRROR);
  if (config.storageLayout === 'r2') return new TieredBulkStore(r2, null, () => 'r2', 'r2');
  if (!config.gdrive || !config.gdrive.clientId || !config.gdrive.refreshToken) {
    throw new Error(
      `STORAGE_LAYOUT=${config.storageLayout} needs GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET, ` +
        'GDRIVE_REFRESH_TOKEN (and optionally GDRIVE_FOLDER_ID) as worker secrets',
    );
  }
  const drive = new GDriveBulkStore(env.MIRROR, config.gdrive, fetchImpl);
  return new TieredBulkStore(
    r2,
    drive,
    (key) => primaryTierFor(config.storageLayout, key),
    config.storageLayout,
  );
}
