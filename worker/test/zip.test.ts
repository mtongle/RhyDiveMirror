import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/http';
import { extractAll, extractEntry, readCentralDirectory, ZipError } from '../src/zip';
import { buildZip } from './helpers/zip-builder';

describe('zip reader', () => {
  it('extracts stored and deflated entries, including nested paths', async () => {
    const zip = buildZip([
      { name: 'bg.png', data: 'cover-bytes-'.repeat(40) },
      { name: 'audio.mp3', data: 'mp3-bytes-'.repeat(200), store: true },
      { name: 'SB/D1.png', data: 'storyboard' },
    ]);
    const entries = readCentralDirectory(zip);
    expect(entries.map((entry) => entry.name)).toEqual(['bg.png', 'audio.mp3', 'SB/D1.png']);
    expect(entries[1]!.method).toBe(0);

    const all = await extractAll(zip);
    expect(all.find((file) => file.name === 'bg.png')!.bytes.byteLength).toBe('cover-bytes-'.repeat(40).length);
    expect(new TextDecoder().decode(all.find((file) => file.name === 'SB/D1.png')!.bytes)).toBe('storyboard');
  });

  it('reads ZIP64 size/offset extra fields', async () => {
    const zip = buildZip([{ name: 'big.bin', data: 'x'.repeat(5000), zip64: true }]);
    const entries = readCentralDirectory(zip);
    expect(entries[0]!.uncompressedSize).toBe(5000);
    const bytes = await extractEntry(zip, entries[0]!);
    expect(bytes.byteLength).toBe(5000);
  });

  it('rejects truncated or non-zip input', () => {
    expect(() => readCentralDirectory(new Uint8Array([1, 2, 3]))).toThrow(ZipError);
    const zip = buildZip([{ name: 'a.txt', data: 'hello' }]);
    expect(() => readCentralDirectory(zip.subarray(0, zip.byteLength - 10))).toThrow(ZipError);
  });

  it('rejects a central directory signature that is not where it claims to be', () => {
    const zip = buildZip([{ name: 'a.txt', data: 'hello' }]);
    // Corrupt the first central-directory signature byte.
    const corrupted = zip.slice();
    const centralAt = corrupted.findIndex((_, index) => index > 0 && new DataView(corrupted.buffer).getUint32(index, true) === 0x02014b50);
    corrupted[centralAt] = 0;
    expect(() => readCentralDirectory(corrupted)).toThrow(ZipError);
  });
});

const FIXTURE_ZIP = fileURLToPath(new URL('../../analysis/fixtures/archive.zip', import.meta.url));
const FIXTURE_MANIFEST = fileURLToPath(new URL('../../analysis/fixtures/manifest.json', import.meta.url));

describe.runIf(existsSync(FIXTURE_ZIP) && existsSync(FIXTURE_MANIFEST))('zip reader against a real RhyDive archive', () => {
  it('reproduces every manifest entry byte-for-byte', async () => {
    const zip = new Uint8Array(readFileSync(FIXTURE_ZIP));
    const manifest = JSON.parse(readFileSync(FIXTURE_MANIFEST, 'utf8')) as {
      archive: { size: number; sha256: string };
      files: { name: string; size: number; sha256: string }[];
    };

    expect(zip.byteLength).toBe(manifest.archive.size);
    expect(await sha256Hex(zip)).toBe(manifest.archive.sha256);

    const entries = readCentralDirectory(zip);
    expect(entries.length).toBe(manifest.files.length);

    for (const file of manifest.files) {
      const entry = entries.find((candidate) => candidate.name === file.name);
      expect(entry, `missing entry ${file.name}`).toBeDefined();
      const bytes = await extractEntry(zip, entry!);
      expect(bytes.byteLength).toBe(file.size);
      expect(await sha256Hex(bytes)).toBe(file.sha256);
    }
  });
});
