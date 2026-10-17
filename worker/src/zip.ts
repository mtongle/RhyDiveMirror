/**
 * Minimal, dependency-free ZIP reader.
 *
 * Only what the mirror needs: enumerate the central directory of a downloaded
 * song archive and extract individual entries. Both classic ZIP and the ZIP64
 * extensions are supported; encrypted entries are rejected.
 */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

export interface ZipEntry {
  /** Archive-relative name, forward slashes, UTF-8 decoded. */
  name: string;
  /** 0 = stored, 8 = deflate. */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  /** Byte offset of the local file header. */
  localHeaderOffset: number;
  flags: number;
}

export class ZipError extends Error {}

export function readCentralDirectory(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);
  if (eocd < 0) throw new ZipError('ZIP end-of-central-directory record not found');

  let entryCount = view.getUint16(eocd + 10, true);
  let cdSize = view.getUint32(eocd + 12, true);
  let cdOffset = view.getUint32(eocd + 16, true);

  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const zip64 = readZip64Eocd(view, eocd);
    if (!zip64) throw new ZipError('ZIP64 archive without a readable ZIP64 end-of-central-directory record');
    entryCount = zip64.entryCount;
    cdSize = zip64.cdSize;
    cdOffset = zip64.cdOffset;
  }

  if (cdOffset + cdSize > bytes.byteLength) throw new ZipError('central directory lies outside the archive');

  const entries: ZipEntry[] = [];
  let cursor = cdOffset;
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > bytes.byteLength) throw new ZipError('truncated central directory');
    if (view.getUint32(cursor, true) !== SIG_CENTRAL) throw new ZipError(`bad central directory signature at ${cursor}`);
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc32 = view.getUint32(cursor + 16, true);
    let compressedSize = view.getUint32(cursor + 20, true);
    let uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    let localHeaderOffset = view.getUint32(cursor + 42, true);

    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.byteLength) throw new ZipError('truncated central directory entry name');
    const name = decodeName(bytes.subarray(nameStart, nameEnd), (flags & 0x800) !== 0);

    const extraStart = nameEnd;
    const extraEnd = extraStart + extraLength;
    if (extraEnd > bytes.byteLength) throw new ZipError('truncated central directory entry extra field');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      const zip64 = readZip64Extra(bytes, view, extraStart, extraLength, {
        uncompressedSize: uncompressedSize === 0xffffffff,
        compressedSize: compressedSize === 0xffffffff,
        localHeaderOffset: localHeaderOffset === 0xffffffff,
      });
      compressedSize = zip64.compressedSize ?? compressedSize;
      uncompressedSize = zip64.uncompressedSize ?? uncompressedSize;
      localHeaderOffset = zip64.localHeaderOffset ?? localHeaderOffset;
    }

    if (flags & 0x1) throw new ZipError(`encrypted archive entry: ${name}`);

    entries.push({ name, method, compressedSize, uncompressedSize, crc32, localHeaderOffset, flags });
    cursor = extraEnd + commentLength;
  }
  return entries;
}

export interface ExtractResult {
  name: string;
  bytes: Uint8Array;
}

/** Extract one entry, returning its *uncompressed* bytes. */
export async function extractEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const local = entry.localHeaderOffset;
  if (local + 30 > bytes.byteLength) throw new ZipError(`truncated local header for ${entry.name}`);
  if (view.getUint32(local, true) !== SIG_LOCAL) throw new ZipError(`bad local header signature for ${entry.name}`);
  const nameLength = view.getUint16(local + 26, true);
  const extraLength = view.getUint16(local + 28, true);
  const dataStart = local + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.byteLength) throw new ZipError(`truncated data for ${entry.name}`);
  const raw = bytes.subarray(dataStart, dataEnd);

  if (entry.method === 0) {
    if (raw.byteLength !== entry.uncompressedSize) throw new ZipError(`stored entry size mismatch: ${entry.name}`);
    return raw.slice();
  }
  if (entry.method !== 8) throw new ZipError(`unsupported compression method ${entry.method} for ${entry.name}`);
  const inflated = await inflateRaw(raw);
  if (inflated.byteLength !== entry.uncompressedSize) {
    throw new ZipError(`inflated size mismatch for ${entry.name}: ${inflated.byteLength} != ${entry.uncompressedSize}`);
  }
  return inflated;
}

/** Extract every entry. Throws on the first structural problem. */
export async function extractAll(bytes: Uint8Array): Promise<ExtractResult[]> {
  const entries = readCentralDirectory(bytes);
  const out: ExtractResult[] = [];
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    out.push({ name: entry.name, bytes: await extractEntry(bytes, entry) });
  }
  return out;
}

export async function inflateRaw(raw: Uint8Array): Promise<Uint8Array> {
  const source = new Blob([raw as unknown as ArrayBuffer]);
  const stream = source.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function decodeName(bytes: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag) return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(bytes);
  // Without the UTF-8 flag the spec says CP437; every RhyDive archive in the
  // wild is UTF-8, and a lossy decode is preferable to a hard failure.
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(bytes);
  }
}

function findEocd(view: DataView): number {
  const min = Math.max(0, view.byteLength - 65557);
  for (let offset = view.byteLength - 22; offset >= min; offset--) {
    if (view.getUint32(offset, true) === SIG_EOCD) return offset;
  }
  return -1;
}

function readZip64Eocd(view: DataView, eocd: number): { entryCount: number; cdSize: number; cdOffset: number } | null {
  const locator = eocd - 20;
  if (locator < 0 || view.getUint32(locator, true) !== SIG_ZIP64_LOCATOR) return null;
  const offset = readUint64(view, locator + 8);
  if (offset + 56 > view.byteLength) return null;
  if (view.getUint32(offset, true) !== SIG_ZIP64_EOCD) return null;
  return {
    entryCount: readUint64(view, offset + 32),
    cdSize: readUint64(view, offset + 40),
    cdOffset: readUint64(view, offset + 48),
  };
}

function readZip64Extra(
  bytes: Uint8Array,
  view: DataView,
  start: number,
  length: number,
  needs: { uncompressedSize: boolean; compressedSize: boolean; localHeaderOffset: boolean },
): { uncompressedSize?: number; compressedSize?: number; localHeaderOffset?: number } {
  let cursor = start;
  const end = start + length;
  while (cursor + 4 <= end) {
    const id = view.getUint16(cursor, true);
    const size = view.getUint16(cursor + 2, true);
    const body = cursor + 4;
    if (id === 0x0001) {
      let at = body;
      const result: { uncompressedSize?: number; compressedSize?: number; localHeaderOffset?: number } = {};
      if (needs.uncompressedSize && at + 8 <= body + size) {
        result.uncompressedSize = readUint64(view, at);
        at += 8;
      }
      if (needs.compressedSize && at + 8 <= body + size) {
        result.compressedSize = readUint64(view, at);
        at += 8;
      }
      if (needs.localHeaderOffset && at + 8 <= body + size) {
        result.localHeaderOffset = readUint64(view, at);
      }
      return result;
    }
    cursor = body + size;
  }
  if (bytes.byteLength === 0) throw new ZipError('unreachable');
  throw new ZipError('ZIP64 entry is missing its required extra field');
}

function readUint64(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('ZIP64 value exceeds safe integer range');
  return Number(value);
}
