/**
 * Route classification and key mapping.
 *
 * The mirror deliberately reproduces two official surfaces:
 *
 *  1. the API surface  `/api/rhydive/{library,assets,...}` — used when a client
 *     is pointed at this worker through its `server` setting;
 *  2. the download-site surface `/rhydive/beatmap/...` — used when
 *     `dl.lunprin.com` is redirected here (`_catalog/library.json`,
 *     `_catalog/manifests/<id>.json`, `<id>.zip`, `<id>/<asset>`).
 *
 * Everything that is not a chart download is forwarded verbatim.
 */

export type RouteKind =
  | 'catalog'
  | 'manifest'
  | 'archive'
  | 'asset'
  | 'admin'
  | 'health'
  | 'proxy';

export interface Route {
  kind: RouteKind;
  /** R2 key of the backing object (absent for `proxy`/`admin`/`health`). */
  key?: string;
  songId?: string;
  /** Decoded, validated archive-relative asset name. */
  assetName?: string;
}

export const SONG_ID_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._~-]{1,96}$/;
const SONG_ID_CAPTURE = '((?!\\.{1,2}$)[A-Za-z0-9._~-]{1,96})';

/** Extensions the official client is willing to fetch as a mirrored asset. */
export const ASSET_EXTENSIONS = new Set([
  '.osu',
  '.osb',
  '.mp3',
  '.ogg',
  '.wav',
  '.flac',
  '.m4a',
  '.mp4',
  '.webm',
  '.ogv',
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
]);

/**
 * Validate one archive-relative path. Mirrors the official client's
 * `safeEntryName` + `rhydiveAssetMirrorUrl` checks so a request can never
 * escape the `<songId>/` key prefix or address a Windows-hostile name.
 */
export function safeEntryName(value: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  const normalized = decoded
    .replaceAll('\\', '/')
    .normalize('NFC')
    .replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null;
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) return null;
  if (parts.some((part) => /[\u0000-\u001f<>:"|?*]/.test(part) || /[. ]$/.test(part))) return null;
  if (parts.some((part) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))) return null;
  return parts.join('/');
}

export function hasAssetExtension(name: string): boolean {
  const match = /\.[^.]+$/.exec(name);
  return match ? ASSET_EXTENSIONS.has(match[0].toLowerCase()) : false;
}

export interface Layout {
  apiPrefix: string;
}

interface PrefixRegexes {
  asset: RegExp;
  manifest: RegExp;
  archive: RegExp;
}

const PREFIX_CACHE = new Map<string, PrefixRegexes>();

function regexesFor(prefix: string): PrefixRegexes {
  let cached = PREFIX_CACHE.get(prefix);
  if (!cached) {
    const escaped = escapeRegExp(prefix);
    cached = {
      asset: new RegExp(`^${escaped}/assets/${SONG_ID_CAPTURE}/(.+)$`),
      manifest: new RegExp(`^${escaped}/library/${SONG_ID_CAPTURE}/download$`),
      archive: new RegExp(`^${escaped}/library/${SONG_ID_CAPTURE}/archive$`),
    };
    PREFIX_CACHE.set(prefix, cached);
  }
  return cached;
}

/** Compiled once per prefix; used by both the router and the tests. */
const CDN_CATALOG = /^\/rhydive\/beatmap\/(.+)$/;
const CDN_MANIFEST = /^_catalog\/manifests\/([A-Za-z0-9._~-]{1,96})\.json$/;
const CDN_ARCHIVE = /^([A-Za-z0-9._~-]{1,96})\.zip$/;
const CDN_ASSET = /^([A-Za-z0-9._~-]{1,96})\/(.+)$/;

/**
 * Classify a request path against the mirror surface. `null` means "not a
 * mirrored chart download" and the caller forwards the request upstream.
 */
export function classify(pathname: string, layout: Layout): Route | null {
  const prefix = layout.apiPrefix;

  if (pathname === `${prefix}/library` || pathname === `${prefix}/library/`) {
    return { kind: 'catalog', key: catalogKeyFor() };
  }

  const patterns = regexesFor(prefix);
  const apiAsset = patterns.asset.exec(pathname);
  if (apiAsset) return assetRoute(apiAsset[1]!, apiAsset[2]!);

  const apiManifest = patterns.manifest.exec(pathname);
  if (apiManifest) return { kind: 'manifest', songId: apiManifest[1]!, key: manifestKeyFor(apiManifest[1]!) };

  const apiArchive = patterns.archive.exec(pathname);
  if (apiArchive) return { kind: 'archive', songId: apiArchive[1]!, key: archiveKeyFor(apiArchive[1]!) };

  // Download-site surface: /rhydive/beatmap/...
  const cdn = CDN_CATALOG.exec(pathname);
  if (cdn) {
    const rest = cdn[1]!;
    if (rest === '_catalog/library.json') return { kind: 'catalog', key: catalogKeyFor() };
    const manifest = CDN_MANIFEST.exec(rest);
    if (manifest) return { kind: 'manifest', songId: manifest[1]!, key: manifestKeyFor(manifest[1]!) };
    const archive = CDN_ARCHIVE.exec(rest);
    if (archive) return { kind: 'archive', songId: archive[1]!, key: archiveKeyFor(archive[1]!) };
    const asset = CDN_ASSET.exec(rest);
    if (asset) return assetRoute(asset[1]!, asset[2]!);
  }

  return null;
}

function assetRoute(songId: string, rawName: string): Route | null {
  if (!SONG_ID_PATTERN.test(songId)) return null;
  const name = safeEntryName(rawName);
  if (!name || !hasAssetExtension(name)) return null;
  return { kind: 'asset', songId, assetName: name, key: assetKeyFor(songId, name) };
}

/**
 * Key builders. The `<id>/` prefix is the mirror's ownership boundary; the
 * archive lives at `<id>.zip` exactly like the official download site.
 */
function catalogKeyFor(): string {
  return '_catalog/library.json';
}
function manifestKeyFor(id: string): string {
  return `_catalog/manifests/${id}.json`;
}
function archiveKeyFor(id: string): string {
  return `${id}.zip`;
}
function assetKeyFor(id: string, name: string): string {
  return `${id}/${name}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
