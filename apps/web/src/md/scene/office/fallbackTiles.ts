import { Texture } from 'pixi.js';
import type { ThemeConfig } from './themeRegistry';
import { resolveThemeMap } from './themeLoader';
import type { TiledMap } from './TiledMapRenderer';

// Hyde Code addition (not in Munder Difflin).
//
// The office map paints LimeZu "Modern Interiors" tiles, which Hyde Code cannot ship.
// The hub serves the owner's licensed copy if they imported one; for every atlas that
// is missing we paint a stand-in atlas of the same size, where each tile the map uses
// is drawn from what the map uses it for (floor, wall or furniture). Same layout, same
// walls and desks, simpler art.

const MASK = 0x1fffffff;
const LAYER_RANK: Record<string, number> = { walls: 3, 'furniture-above': 2, 'furniture-below': 1, floor: 0 };

/** The off and on desk-monitor tiles (see OFFICE_THEME.monitor). */
const MONITOR_OFF = new Set([365, 366, 381, 382]);
const MONITOR_ON = new Set([367, 368, 383, 384]);

export interface LoadedTiles {
  textures: Texture[];
  /** True when every atlas is the owner's real LimeZu art (credit is then required). */
  licensed: boolean;
}

/** Which atlases the hub has (GET /api/tiles lists the owner's imported files). */
async function installed(): Promise<Set<string>> {
  try {
    const res = await fetch('/api/tiles', { credentials: 'same-origin' });
    return new Set(res.ok ? ((await res.json()) as { files: string[] }).files : []);
  } catch {
    return new Set();
  }
}

function usage(map: TiledMap): Map<number, string> {
  const used = new Map<number, string>();
  for (const layer of map.layers) {
    if (layer.type !== 'tilelayer' || !layer.data || !(layer.name in LAYER_RANK)) continue;
    for (const raw of layer.data) {
      const gid = raw & MASK;
      if (!gid) continue;
      const prev = used.get(gid);
      if (!prev || LAYER_RANK[layer.name]! > LAYER_RANK[prev]!) used.set(gid, layer.name);
    }
  }
  return used;
}

// Each floor tile id gets its own calm floor (rooms use different floor tiles, so rooms
// read apart); walls and furniture use one colour each so multi-tile pieces read as one.
const FLOORS = [
  ['#e5c896', '#dcbc86', '#c9a66b'], // light wood
  ['#efe6d2', '#e6dcc4', '#cbbd9f'], // cream tile
  ['#c4d0dc', '#b9c6d3', '#9eabb9'], // blue carpet
  ['#d6dcc2', '#ccd3b5', '#aeb791'], // sage carpet
  ['#e8d3b8', '#dfc7a8', '#c4a985'], // oak
  ['#d9d2c6', '#cfc7ba', '#b3aa9b'], // concrete
  ['#ead9c4', '#e0cdb5', '#c8b293'], // birch
  ['#cfc3d6', '#c5b8cd', '#a99bb3'], // lilac carpet
];

function paintCell(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, gid: number, role: string, floorIndex: number) {
  const px = (c: string, dx: number, dy: number, w = 1, h = 1) => {
    ctx.fillStyle = c;
    ctx.fillRect(x + dx, y + dy, w, h);
  };
  if (MONITOR_OFF.has(gid) || MONITOR_ON.has(gid)) {
    const on = MONITOR_ON.has(gid);
    px('#4a4f5c', 0, 0, size, size);
    px(on ? '#79d6c6' : '#262a33', 1, 1, size - 2, size - 2);
    if (on) for (let i = 0; i < 4; i++) px('#effffb', 3, 3 + i * 3, 4 + ((gid * 7 + i * 5) % 7), 1);
    return;
  }
  if (role === 'floor') {
    // The map alternates floor variants tile by tile, so every floor tile shares one look.
    const pal = FLOORS[0]!;
    void floorIndex;
    px(pal[0]!, 0, 0, size, size);
    px(pal[1]!, 0, size / 2, size, size / 2);
    px(pal[2]!, 0, size - 1, size, 1);
    px(pal[2]!, 0, size / 2 - 1, size, 1);
    return;
  }
  if (role === 'walls') {
    px('#d8c7a2', 0, 0, size, size);
    px('#c3b08a', 0, size - 3, size, 3);
    return;
  }
  if (role === 'furniture-below') {
    px('#b88f5f', 0, 0, size, size);
    return;
  }
  px('#8f9aa8', 0, 0, size, size);
}

function fallbackAtlas(map: TiledMap, index: number, used: Map<number, string>): Texture {
  const ts = map.tilesets[index]!;
  const size = ts.tilewidth ?? map.tilewidth;
  const columns = ts.columns ?? 16;
  const count = ts.tilecount ?? 512;
  const rows = Math.ceil(count / columns);
  const canvas = document.createElement('canvas');
  canvas.width = columns * size;
  canvas.height = rows * size;
  const ctx = canvas.getContext('2d')!;
  const first = ts.firstgid;
  const next = map.tilesets[index + 1]?.firstgid ?? first + count;
  const floors = [...used].filter(([, r]) => r === 'floor').map(([g]) => g).sort((a, b) => a - b);
  for (const [gid, role] of used) {
    if (gid < first || gid >= next) continue;
    const local = gid - first;
    paintCell(ctx, (local % columns) * size, Math.floor(local / columns) * size, size, gid, role, floors.indexOf(gid));
  }
  const tex = Texture.from(canvas);
  tex.source.scaleMode = 'nearest';
  return tex;
}

/** Loads each atlas from the hub, or paints a stand-in for any that is missing. */
export async function loadTilesets(theme: ThemeConfig, loadTexture: (url: string) => Promise<Texture>): Promise<LoadedTiles> {
  const map = resolveThemeMap(theme);
  // The embedded atlas's metadata lives in the map; fill sane defaults for the stand-in.
  map.tilesets = map.tilesets.map((t, i) => ({ tilewidth: map.tilewidth, tileheight: map.tileheight, columns: 16, tilecount: i === 0 ? 512 : undefined, ...t }));
  const used = usage(map);
  let licensed = true;
  const have = await installed();
  const textures = await Promise.all(
    theme.tilesets.map(async (t, i) => {
      if (have.has(t.url.split('/').pop() ?? '')) {
        try {
          return await loadTexture(t.url);
        } catch {
          // fall through to the stand-in
        }
      }
      licensed = false;
      return fallbackAtlas(map, i, used);
    }),
  );
  return { textures, licensed };
}
