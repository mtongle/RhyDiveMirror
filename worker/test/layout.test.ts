import { describe, expect, it } from 'vitest';
import { classify, hasAssetExtension, safeEntryName, SONG_ID_PATTERN } from '../src/layout';

const layout = { apiPrefix: '/api/rhydive' };

describe('classify', () => {
  it('maps the API surface', () => {
    expect(classify('/api/rhydive/library', layout)).toEqual({
      kind: 'catalog',
      key: '_catalog/library.json',
    });
    expect(classify('/api/rhydive/library/song-1/download', layout)).toEqual({
      kind: 'manifest',
      songId: 'song-1',
      key: '_catalog/manifests/song-1.json',
    });
    expect(classify('/api/rhydive/library/song-1/archive', layout)).toEqual({
      kind: 'archive',
      songId: 'song-1',
      key: 'song-1.zip',
    });
    expect(classify('/api/rhydive/assets/song-1/bg.png', layout)).toEqual({
      kind: 'asset',
      songId: 'song-1',
      assetName: 'bg.png',
      key: 'song-1/bg.png',
    });
  });

  it('decodes percent-encoded asset names', () => {
    const route = classify(
      '/api/rhydive/assets/cysmix-triangles-1841885-a702605d/cYsmix%20-%20triangles%20(yf_bmp)%20%5BEasy%5D.osu',
      layout,
    );
    expect(route?.assetName).toBe('cYsmix - triangles (yf_bmp) [Easy].osu');
    expect(route?.key).toBe('cysmix-triangles-1841885-a702605d/cYsmix - triangles (yf_bmp) [Easy].osu');
  });

  it('maps the download-site surface used by the built-in mirror', () => {
    expect(classify('/rhydive/beatmap/_catalog/library.json', layout)).toEqual({
      kind: 'catalog',
      key: '_catalog/library.json',
    });
    expect(classify('/rhydive/beatmap/_catalog/manifests/song-1.json', layout)).toEqual({
      kind: 'manifest',
      songId: 'song-1',
      key: '_catalog/manifests/song-1.json',
    });
    expect(classify('/rhydive/beatmap/song-1.zip', layout)).toEqual({
      kind: 'archive',
      songId: 'song-1',
      key: 'song-1.zip',
    });
    expect(classify('/rhydive/beatmap/song-1/SB/D1.png', layout)).toEqual({
      kind: 'asset',
      songId: 'song-1',
      assetName: 'SB/D1.png',
      key: 'song-1/SB/D1.png',
    });
  });

  it('rejects traversal, absolute paths and unknown extensions', () => {
    expect(classify('/api/rhydive/assets/song-1/../../etc/passwd', layout)).toBeNull();
    expect(classify('/api/rhydive/assets/song-1/..%2f..%2fetc%2fpasswd.png', layout)).toBeNull();
    expect(classify('/api/rhydive/assets/song-1/%2Fetc%2Fshadow.png', layout)).toBeNull();
    expect(classify('/api/rhydive/assets/song-1/C:%5Cwindows%5Cevil.png', layout)).toBeNull();
    expect(classify('/api/rhydive/assets/song-1/payload.exe', layout)).toBeNull();
    expect(classify('/api/rhydive/assets/song-1/.hidden.png', layout)).toBeNull();
    expect(classify('/api/rhydive/assets/song-1/name%00.png', layout)).toBeNull();
  });

  it('rejects song ids outside the official id alphabet', () => {
    expect(classify('/api/rhydive/assets/bad%20id/bg.png', layout)).toBeNull();
    expect(classify('/api/rhydive/library/bad%2Fid/archive', layout)).toBeNull();
    expect(SONG_ID_PATTERN.test('cysmix-triangles-1841885-a702605d')).toBe(true);
    expect(SONG_ID_PATTERN.test('a'.repeat(97))).toBe(false);
  });

  it('leaves every other path to the proxy', () => {
    for (const path of [
      '/api/login',
      '/api/session/current',
      '/api/rhydive/results',
      '/api/rhydive/profile',
      '/api/rhydive/client/files/RhyDive-Setup-0.7.2-x64.exe',
      '/rhydive/client/blocks/' + 'a'.repeat(64),
      '/api/rhydive/library/song-1/other',
      '/rhydive/beatmap/not-a-song.txt',
    ]) {
      expect(classify(path, layout)).toBeNull();
    }
  });
});

describe('safeEntryName', () => {
  it('normalises separators and rejects unsafe names', () => {
    expect(safeEntryName('SB/D1.png')).toBe('SB/D1.png');
    expect(safeEntryName('SB\\D1.png')).toBe('SB/D1.png');
    expect(safeEntryName('./bg.png')).toBe('bg.png');
    expect(safeEntryName('a//b.png')).toBeNull();
    expect(safeEntryName('a/../b.png')).toBeNull();
    expect(safeEntryName('/abs.png')).toBeNull();
    expect(safeEntryName('C:/abs.png')).toBeNull();
    expect(safeEntryName('trailing. ')).toBeNull();
    expect(safeEntryName('CON.png')).toBeNull();
    expect(safeEntryName('bad|name.png')).toBeNull();
  });
});

describe('hasAssetExtension', () => {
  it('accepts exactly the official client extension set', () => {
    for (const name of ['a.osu', 'a.osb', 'a.mp3', 'a.OGG', 'a.webm', 'a.jpeg']) {
      expect(hasAssetExtension(name)).toBe(true);
    }
    for (const name of ['a.exe', 'a.json', 'a', 'a.zip']) {
      expect(hasAssetExtension(name)).toBe(false);
    }
  });
});
