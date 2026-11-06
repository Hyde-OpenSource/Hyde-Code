import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importTiles, tilePath } from './tiles.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A PNG header with the given size (enough for the size check; not a real image). */
function fakePng(width: number, height: number): Buffer {
  const b = Buffer.alloc(32);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

describe('tile import', () => {
  it('takes hand-picked sheets of the right size and serves only known names', () => {
    const root = mkdtempSync(join(tmpdir(), 'hyde-tiles-'));
    dirs.push(root);
    const pack = join(root, 'pack');
    mkdirSync(pack);
    writeFileSync(join(pack, 'Interiors_16x16.png'), fakePng(256, 1424));
    writeFileSync(join(pack, 'wrong.png'), fakePng(100, 100));
    const data = join(root, 'data');

    const res = importTiles(data, pack, { 'interiors.png': join(pack, 'Interiors_16x16.png') });
    expect(Object.keys(res.found)).toEqual(['interiors.png']);
    expect(res.missing).toEqual(['office-tileset.png', 'a5-office-floors-walls.png']);
    expect(tilePath(data, 'interiors.png')).toBeTruthy();
    expect(tilePath(data, '../hyde.config.json')).toBeNull();
    expect(() => importTiles(data, undefined, { 'office-tileset.png': join(pack, 'wrong.png') })).toThrow(/must be 256×512/);
  });
});
