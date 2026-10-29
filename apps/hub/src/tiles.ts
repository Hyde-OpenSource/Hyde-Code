import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

// The office floor uses three LimeZu "Modern Interiors" atlases. Their licence forbids
// redistribution, so Hyde Code never ships them: the owner imports their own licensed copy
// into <dataDir>/assets/limezu/ and the hub serves it to the dashboard only.

export const TILE_FILES = ['office-tileset.png', 'a5-office-floors-walls.png', 'interiors.png'] as const;
export type TileFile = (typeof TILE_FILES)[number];

/** SHA-256 of the exact sheets the office map was built on, plus their pixel size. */
const KNOWN: Record<TileFile, { sha256: string; width: number; height: number }> = {
  'office-tileset.png': { sha256: '95d448c5df9d726799abe8c3ce211ead27f8e503dca62f616e044b63aa42fa8e', width: 256, height: 512 },
  'a5-office-floors-walls.png': { sha256: '7983d4b5782bd5ea80ead73310c92681f36b8d15bd2996ba5aff35953e656f3c', width: 256, height: 512 },
  'interiors.png': { sha256: '01a890f9e34d8dc8d7e275489143b837569127d5f928419e6b6edc54b9b5ff33', width: 256, height: 1424 },
};

export function tilesDir(dataDir: string): string {
  return join(dataDir, 'assets', 'limezu');
}

export function tilePath(dataDir: string, name: string): string | null {
  if (!(TILE_FILES as readonly string[]).includes(name)) return null;
  const p = join(tilesDir(dataDir), name);
  return existsSync(p) ? p : null;
}

function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function* pngs(dir: string, depth = 0): Generator<string> {
  if (depth > 6) return;
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* pngs(p, depth + 1);
    else if (/\.png$/i.test(name) && st.size < 20_000_000) yield p;
  }
}

export interface ImportResult {
  found: Partial<Record<TileFile, string>>;
  missing: TileFile[];
}

/**
 * Finds the three sheets in a folder (an unzipped Modern Interiors pack): first by exact
 * content hash, then `explicit` overrides (name=path) for packs whose files differ.
 */
export function importTiles(dataDir: string, folder: string | undefined, explicit: Partial<Record<TileFile, string>> = {}): ImportResult {
  const found: Partial<Record<TileFile, string>> = {};
  if (folder) {
    for (const p of pngs(folder)) {
      const buf = readFileSync(p);
      const hash = createHash('sha256').update(buf).digest('hex');
      for (const name of TILE_FILES) if (!found[name] && KNOWN[name].sha256 === hash) found[name] = p;
    }
  }
  for (const [name, p] of Object.entries(explicit) as [TileFile, string][]) {
    const size = pngSize(readFileSync(p));
    const want = KNOWN[name];
    if (!size || size.width !== want.width || size.height !== want.height) {
      throw new Error(`${basename(p)} is ${size ? `${size.width}×${size.height}` : 'not a PNG'}; ${name} must be ${want.width}×${want.height}`);
    }
    found[name] = p;
  }
  const out = tilesDir(dataDir);
  mkdirSync(out, { recursive: true });
  for (const [name, p] of Object.entries(found) as [TileFile, string][]) copyFileSync(p, join(out, name));
  return { found, missing: TILE_FILES.filter((n) => !found[n] && !existsSync(join(out, n))) };
}
