// Minimal ASAR extractor (no deps)
import fs from 'node:fs';
import path from 'node:path';

const archive = process.argv[2];
const outDir = process.argv[3];
if (!archive || !outDir) { console.error('usage: asar-extract.mjs <archive> <outDir>'); process.exit(2); }

const fd = fs.openSync(archive, 'r');
const head = Buffer.alloc(64);
fs.readSync(fd, head, 0, 64, 0);
// locate JSON header: it starts with '{'
let hdrOff = -1;
for (let i = 8; i < 64; i++) { if (head[i] === 0x7b) { hdrOff = i; break; } }
if (hdrOff < 0) throw new Error('cannot locate asar json header');
// json length is the uint32 immediately preceding the '{'
const jsonLen = head.readUInt32LE(hdrOff - 4);
const jsonBuf = Buffer.alloc(jsonLen);
fs.readSync(fd, jsonBuf, 0, jsonLen, hdrOff);
const header = JSON.parse(jsonBuf.toString('utf8'));
const dataOffset = hdrOff + jsonLen;

const stats = { files: 0, bytes: 0, skipped: [], links: 0 };
function walk(node, rel) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = path.join(rel, name);
    if (entry.files) { fs.mkdirSync(path.join(outDir, p), { recursive: true }); walk(entry, p); }
    else if (entry.link) { stats.links++; stats.skipped.push(`symlink:${p}`); }
    else if (typeof entry.offset === 'string' || typeof entry.offset === 'number') {
      const off = dataOffset + Number(entry.offset);
      const size = Number(entry.size ?? 0);
      fs.mkdirSync(path.dirname(path.join(outDir, p)), { recursive: true });
      const buf = Buffer.alloc(size);
      let got = 0;
      while (got < size) { const n = fs.readSync(fd, buf, got, size - got, off + got); if (!n) break; got += n; }
      fs.writeFileSync(path.join(outDir, p), buf.subarray(0, got));
      stats.files++; stats.bytes += got;
    } else if (entry.unpacked) { stats.skipped.push(`unpacked:${p}`); }
  }
}
walk(header, '');
fs.closeSync(fd);
console.log(JSON.stringify({ dataOffset, jsonLen, ...stats }, null, 2));
