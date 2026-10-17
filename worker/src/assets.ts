/**
 * Content-type resolution and "hot asset" classification.
 *
 * The official client refuses a mirrored asset whose response is `text/html`
 * ("谱面外链返回了网页"), so every serve path must produce a concrete type.
 */
import { ASSET_EXTENSIONS } from './layout';

const TYPES: Record<string, string> = {
  '.osu': 'text/plain; charset=utf-8',
  '.osb': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8',
  '.cfg': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.zip': 'application/zip',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.opus': 'audio/opus',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.psb': 'application/octet-stream',
};

export function contentTypeFor(name: string): string {
  const match = /\.[^.]+$/.exec(name);
  if (!match) return 'application/octet-stream';
  return TYPES[match[0].toLowerCase()] ?? 'application/octet-stream';
}

export function isMirrorableAsset(name: string): boolean {
  const match = /\.[^.]+$/.exec(name);
  return match ? ASSET_EXTENSIONS.has(match[0].toLowerCase()) : false;
}

const HOT_BASENAMES = /^(bg|background|cover|audio|preview)\./i;

/**
 * Files a client touches on almost every browse/launch: the cover, the audio
 * track, and the beatmaps. In `hot` mode these are always materialised so the
 * interactive path never pays an extraction.
 */
export function isHotAsset(name: string): boolean {
  const base = name.split('/').pop() ?? name;
  if (HOT_BASENAMES.test(base)) return true;
  return /\.osu$/i.test(base);
}
