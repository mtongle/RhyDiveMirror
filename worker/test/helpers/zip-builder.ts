/**
 * Builds ZIP archives in tests, so the reader can be exercised against stored
 * entries, deflated entries, nested paths, and ZIP64 extra fields.
 */
import { deflateRawSync } from 'node:zlib';

export interface FixtureEntry {
  name: string;
  data: Uint8Array | string;
  /** Store uncompressed (method 0) instead of deflating. */
  store?: boolean;
  /** Emit 0xFFFFFFFF size/offset fields plus a ZIP64 extra field. */
  zip64?: boolean;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function buildZip(entries: FixtureEntry[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const raw = typeof entry.data === 'string' ? new TextEncoder().encode(entry.data) : entry.data;
    const deflated = entry.store ? raw : new Uint8Array(deflateRawSync(raw));
    const method = entry.store ? 0 : 8;
    const crc = crc32(raw);

    const localExtra = entry.zip64 ? buildZip64Extra(raw.byteLength, deflated.byteLength, null) : new Uint8Array();
    const centralExtra = entry.zip64 ? buildZip64Extra(raw.byteLength, deflated.byteLength, offset) : new Uint8Array();

    const local = new Uint8Array(30 + nameBytes.byteLength + localExtra.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, method, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, entry.zip64 ? 0xffffffff : deflated.byteLength, true);
    localView.setUint32(22, entry.zip64 ? 0xffffffff : raw.byteLength, true);
    localView.setUint16(26, nameBytes.byteLength, true);
    localView.setUint16(28, localExtra.byteLength, true);
    local.set(nameBytes, 30);
    local.set(localExtra, 30 + nameBytes.byteLength);
    locals.push(local, deflated);

    const central = new Uint8Array(46 + nameBytes.byteLength + centralExtra.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, entry.zip64 ? 0xffffffff : deflated.byteLength, true);
    centralView.setUint32(24, entry.zip64 ? 0xffffffff : raw.byteLength, true);
    centralView.setUint16(28, nameBytes.byteLength, true);
    centralView.setUint16(30, centralExtra.byteLength, true);
    centralView.setUint32(42, entry.zip64 ? 0xffffffff : offset, true);
    central.set(nameBytes, 46);
    central.set(centralExtra, 46 + nameBytes.byteLength);
    centrals.push(central);

    offset += local.byteLength + deflated.byteLength;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.byteLength, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);

  return concat([...locals, ...centrals, eocd]);
}

function buildZip64Extra(uncompressedSize: number, compressedSize: number, localHeaderOffset: number | null): Uint8Array {
  const payload = localHeaderOffset === null ? 16 : 24;
  const extra = new Uint8Array(4 + payload);
  const view = new DataView(extra.buffer);
  view.setUint16(0, 0x0001, true);
  view.setUint16(2, payload, true);
  view.setBigUint64(4, BigInt(uncompressedSize), true);
  view.setBigUint64(12, BigInt(compressedSize), true);
  if (localHeaderOffset !== null) view.setBigUint64(20, BigInt(localHeaderOffset), true);
  return extra;
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
