// The pixel office: a hand-drawn (in code) top-down floor where every agent is a little person.
// Everything is drawn with fillRect on a small canvas that CSS scales up with crisp pixels.
// World units are tiles (16 px); positions are the character's feet.

export const TILE = 16;
export const COLS = 30;
export const ROWS = 17;
export const WIDTH = COLS * TILE;
export const HEIGHT = ROWS * TILE;

export interface P {
  x: number;
  y: number;
}

/** Walkable aisles (y) and the connector columns (x) that join them. */
const AISLE_TOP = 8;
const AISLE_BOTTOM = 14;
const CONNECTORS = [9.5, 21.4];

export interface SpotDef {
  pos: P;
  aisle: number;
  /** A corner to pass through between the aisle and the spot (to walk round furniture). */
  via?: P;
  face: Facing;
}
export type Facing = 'up' | 'down' | 'left' | 'right';

export const DESK_COLS = [10, 12, 14, 16, 18];
export const DESK_ROWS = [4, 10];
export const MAX_DESKS = DESK_COLS.length * DESK_ROWS.length;

/** Desk i: the tile where its top-left corner sits. */
export function deskTile(i: number): P {
  return { x: DESK_COLS[i % DESK_COLS.length]!, y: DESK_ROWS[Math.floor(i / DESK_COLS.length)]! };
}

export function deskSpot(i: number): SpotDef {
  if (i >= MAX_DESKS) return KITCHEN_SPOTS[(i - MAX_DESKS) % KITCHEN_SPOTS.length]!;
  const t = deskTile(i);
  return { pos: { x: t.x + 1, y: t.y + 2 }, aisle: t.y < 8 ? AISLE_TOP : AISLE_BOTTOM, face: 'up' };
}

export const WHITEBOARD_SPOTS: SpotDef[] = [
  { pos: { x: 24.6, y: 4.7 }, aisle: AISLE_TOP, via: { x: 23.6, y: 4.7 }, face: 'up' },
  { pos: { x: 26, y: 4.7 }, aisle: AISLE_TOP, via: { x: 23.6, y: 4.7 }, face: 'up' },
  { pos: { x: 27.4, y: 4.7 }, aisle: AISLE_TOP, via: { x: 23.6, y: 4.7 }, face: 'up' },
];

export const REVIEW_SPOTS: SpotDef[] = [
  { pos: { x: 23.7, y: 6.9 }, aisle: AISLE_TOP, face: 'right' },
  { pos: { x: 28.4, y: 6.9 }, aisle: AISLE_TOP, face: 'left' },
  { pos: { x: 26, y: 8.4 }, aisle: AISLE_TOP, face: 'up' },
];

export const KITCHEN_SPOTS: SpotDef[] = [
  { pos: { x: 24.3, y: 12.9 }, aisle: AISLE_BOTTOM, face: 'up' }, // coffee machine
  { pos: { x: 28.5, y: 13 }, aisle: AISLE_BOTTOM, face: 'up' }, // water cooler
  { pos: { x: 25.3, y: 16 }, aisle: AISLE_BOTTOM, face: 'down' }, // couch
  { pos: { x: 26.9, y: 16 }, aisle: AISLE_BOTTOM, face: 'down' }, // couch
  { pos: { x: 26.6, y: 12.9 }, aisle: AISLE_BOTTOM, face: 'up' }, // fridge
];

export const HYDE_POS: P = { x: 3.5, y: 6.1 };
export const INBOX_POS: P = { x: 15, y: 15.4 };
export const OUTBOX_POS: P = { x: 20.6, y: 15.6 };
export const WAR_ROOM_POS: P = { x: 26, y: 6 };

function exitPath(s: SpotDef): P[] {
  const pts: P[] = [];
  if (s.via) pts.push(s.via);
  const x = (s.via ?? s.pos).x;
  pts.push({ x, y: s.aisle });
  return pts;
}

/** A walk from one spot to another along the aisles (no general pathfinding needed). */
export function route(from: SpotDef, to: SpotDef): P[] {
  const out = exitPath(from);
  const into = exitPath(to).reverse();
  if (from.aisle !== to.aisle) {
    const midX = ((from.via ?? from.pos).x + (to.via ?? to.pos).x) / 2;
    const cx = CONNECTORS.reduce((a, b) => (Math.abs(b - midX) < Math.abs(a - midX) ? b : a));
    out.push({ x: cx, y: from.aisle }, { x: cx, y: to.aisle });
  }
  return [...out, ...into, to.pos];
}

// ---------- palette ----------

const C = {
  night: '#0d1022',
  wall: '#2b2f45',
  wallTop: '#3a3f5c',
  wallLine: '#22253a',
  base: '#1a1c2c',
  wood1: '#8a5a3b',
  wood2: '#7b4f33',
  woodSeam: '#6a432b',
  carpet1: '#3d4a6b',
  carpet2: '#37435f',
  tile1: '#c9c3b2',
  tile2: '#b9b3a2',
  dark1: '#23252f',
  dark2: '#1f2129',
  glass: 'rgba(150, 210, 255, 0.28)',
  glassEdge: '#9fd3ff',
  deskTop: '#c7925a',
  deskEdge: '#9b6b3e',
  deskFront: '#7a5130',
  monitor: '#1b1d27',
  chair: '#2f3346',
  plant: '#3fa35b',
  plantDark: '#2b7a42',
  pot: '#b5643c',
  white: '#f3efe2',
  ink: '#1b1d27',
  amber: '#f2b544',
  red: '#ff6b6b',
  green: '#7cf29a',
};

type Ctx = CanvasRenderingContext2D;

function r(ctx: Ctx, x: number, y: number, w: number, h: number, c: string) {
  ctx.fillStyle = c;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}
const T = TILE;

// ---------- static background ----------

function floorWood(ctx: Ctx, x0: number, y0: number, w: number, h: number) {
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      const x = (x0 + tx) * T;
      const y = (y0 + ty) * T;
      r(ctx, x, y, T, T, (tx + ty) % 2 ? C.wood1 : C.wood2);
      r(ctx, x, y + T - 1, T, 1, C.woodSeam);
      r(ctx, x + ((ty % 2) * 8 + 4), y, 1, T - 1, C.woodSeam);
    }
  }
}

function floorChecker(ctx: Ctx, x0: number, y0: number, w: number, h: number, a: string, b: string, size = 8) {
  for (let y = y0 * T; y < (y0 + h) * T; y += size) {
    for (let x = x0 * T; x < (x0 + w) * T; x += size) r(ctx, x, y, size, size, ((x + y) / size) % 2 ? a : b);
  }
}

function topWall(ctx: Ctx) {
  r(ctx, 0, 0, WIDTH, 3 * T, C.wall);
  r(ctx, 0, 0, WIDTH, 4, C.wallTop);
  r(ctx, 0, 3 * T - 4, WIDTH, 4, C.base);
  // windows with a night skyline, one per bay
  for (const wx of [1, 10, 15, 19]) {
    const x = wx * T + 4;
    const y = 8;
    const w = 3 * T - 8;
    const h = 22;
    r(ctx, x - 2, y - 2, w + 4, h + 4, C.wallLine);
    r(ctx, x, y, w, h, C.night);
    for (let i = 0; i < 7; i++) r(ctx, x + ((i * 13 + wx * 7) % w), y + ((i * 5 + wx) % 9), 1, 1, '#c9d4ff');
    for (let bx = 0; bx < w; bx += 6) {
      const bh = 6 + ((bx * 7 + wx * 3) % 10);
      r(ctx, x + bx, y + h - bh, 5, bh, '#1c2140');
      if ((bx + wx) % 3 === 0) r(ctx, x + bx + 2, y + h - bh + 3, 1, 1, '#f2d27a');
    }
    r(ctx, x + w / 2 - 1, y, 2, h, C.wallLine);
  }
}

function vWall(ctx: Ctx, tx: number, y0: number, y1: number, gaps: [number, number][], glass = false) {
  for (let y = y0; y < y1; y++) {
    if (gaps.some(([a, b]) => y >= a && y < b)) continue;
    const x = tx * T + 5;
    if (glass) {
      r(ctx, x, y * T, 6, T, C.glass);
      r(ctx, x, y * T, 1, T, C.glassEdge);
      r(ctx, x + 5, y * T, 1, T, C.glassEdge);
    } else {
      r(ctx, x, y * T, 6, T, C.wallTop);
      r(ctx, x + 5, y * T, 1, T, C.wallLine);
    }
  }
}

function hWall(ctx: Ctx, ty: number, x0: number, x1: number, glass = false) {
  const y = ty * T + 5;
  if (glass) {
    r(ctx, x0 * T, y, (x1 - x0) * T, 6, C.glass);
    r(ctx, x0 * T, y, (x1 - x0) * T, 1, C.glassEdge);
  } else {
    r(ctx, x0 * T, y, (x1 - x0) * T, 6, C.wallTop);
    r(ctx, x0 * T, y + 5, (x1 - x0) * T, 1, C.wallLine);
  }
}

function plant(ctx: Ctx, px: number, py: number, big = false) {
  const s = big ? 1.4 : 1;
  r(ctx, px - 4 * s, py - 6 * s, 8 * s, 6 * s, C.pot);
  r(ctx, px - 4 * s, py - 6 * s, 8 * s, 1, '#d07b4f');
  r(ctx, px - 6 * s, py - 14 * s, 12 * s, 8 * s, C.plantDark);
  r(ctx, px - 4 * s, py - 18 * s, 8 * s, 8 * s, C.plant);
  r(ctx, px - 7 * s, py - 11 * s, 3 * s, 3 * s, C.plant);
  r(ctx, px + 4 * s, py - 12 * s, 3 * s, 3 * s, C.plant);
}

export function drawDesk(ctx: Ctx, tx: number, ty: number) {
  const x = tx * T;
  const y = ty * T;
  r(ctx, x + 1, y + 2, 2 * T - 2, T + 2, C.deskTop);
  r(ctx, x + 1, y + 2, 2 * T - 2, 1, '#dcae78');
  r(ctx, x + 1, y + T + 4, 2 * T - 2, 4, C.deskFront);
  r(ctx, x + 2, y + T + 8, 2, 3, C.deskEdge);
  r(ctx, x + 2 * T - 4, y + T + 8, 2, 3, C.deskEdge);
  // keyboard, mug, papers
  r(ctx, x + 10, y + 13, 12, 3, '#d9d6cc');
  r(ctx, x + 25, y + 10, 3, 4, '#e8e2d0');
  r(ctx, x + 3, y + 11, 5, 6, C.white);
  // monitor stand (the screen is drawn every frame)
  r(ctx, x + 14, y + 7, 4, 3, C.monitor);
  // chair
  r(ctx, x + 10, y + 2 * T + 2, 12, 8, C.chair);
  r(ctx, x + 11, y + 2 * T + 3, 10, 2, '#3c4159');
}

function monitorRect(tx: number, ty: number) {
  return { x: tx * T + 7, y: ty * T - 3, w: 18, h: 11 };
}

export type Screen = 'off' | 'idle' | 'code' | 'question' | 'error';

export function drawMonitor(ctx: Ctx, tx: number, ty: number, screen: Screen, t: number, tint: string) {
  const m = monitorRect(tx, ty);
  r(ctx, m.x - 1, m.y - 1, m.w + 2, m.h + 2, C.monitor);
  if (screen === 'off') return r(ctx, m.x, m.y, m.w, m.h, '#0b0c10');
  if (screen === 'error') {
    r(ctx, m.x, m.y, m.w, m.h, Math.floor(t * 2) % 2 ? '#5a1d24' : '#7a2630');
    r(ctx, m.x + 8, m.y + 2, 2, 5, C.white);
    r(ctx, m.x + 8, m.y + 8, 2, 2, C.white);
    return;
  }
  if (screen === 'question') {
    r(ctx, m.x, m.y, m.w, m.h, '#3a2b0d');
    if (Math.floor(t * 2) % 2) {
      r(ctx, m.x + 7, m.y + 2, 4, 1, C.amber);
      r(ctx, m.x + 10, m.y + 3, 1, 2, C.amber);
      r(ctx, m.x + 8, m.y + 5, 2, 2, C.amber);
      r(ctx, m.x + 8, m.y + 8, 2, 1, C.amber);
    }
    return;
  }
  if (screen === 'idle') {
    r(ctx, m.x, m.y, m.w, m.h, '#141a2e');
    const bx = Math.floor((Math.sin(t * 0.7 + tx) * 0.5 + 0.5) * (m.w - 3));
    const by = Math.floor((Math.cos(t * 0.5 + ty) * 0.5 + 0.5) * (m.h - 3));
    r(ctx, m.x + bx, m.y + by, 3, 3, tint);
    return;
  }
  // scrolling code in the agent's colour
  r(ctx, m.x, m.y, m.w, m.h, '#0e1a14');
  const off = Math.floor(t * 6);
  for (let i = 0; i < 5; i++) {
    const seed = (i + off + tx * 3) % 7;
    const w = 4 + ((seed * 5) % 11);
    r(ctx, m.x + 1 + (seed % 3) * 2, m.y + 1 + i * 2, w, 1, i % 2 ? C.green : tint);
  }
}

/** Draws everything that never moves, once, into the given context. */
export function drawBackground(ctx: Ctx) {
  r(ctx, 0, 0, WIDTH, HEIGHT, C.base);
  floorWood(ctx, 0, 3, COLS, ROWS - 3);
  floorChecker(ctx, 0, 3, 8, 7, '#4a3a5a', '#433452', 16); // Hyde's office rug
  floorChecker(ctx, 0, 11, 8, 6, C.dark1, C.dark2);
  floorChecker(ctx, 23, 3, 7, 8, C.carpet1, C.carpet2, 16);
  floorChecker(ctx, 23, 11, 7, 6, C.tile1, C.tile2);
  topWall(ctx);

  // interior walls: Hyde's office and the war room are glass, the server room and kitchen solid
  vWall(ctx, 8, 3, 10, [[7, 9]], true);
  vWall(ctx, 8, 10, 17, [[13, 15]]);
  hWall(ctx, 10, 0, 8.4);
  vWall(ctx, 22, 3, 10, [[7, 9]], true);
  vWall(ctx, 22, 10, 17, [[13, 15]]);
  hWall(ctx, 10, 22.4, 30, true);

  // Hyde's office: big desk, bookshelf, rug, plant
  r(ctx, 1 * T, 3 * T + 2, 2 * T, 10, '#5b3a26');
  for (let i = 0; i < 6; i++) r(ctx, 1 * T + 3 + i * 5, 3 * T + 3, 3, 7, ['#c45b4b', '#4b8bc4', '#e2c15b', '#6bbd78', '#a07ad0', '#d98a4b'][i]!);
  plant(ctx, 7 * T + 2, 4 * T + 6, true);
  plant(ctx, 1 * T, 9 * T + 8);

  // server room: racks with LED slots (the LEDs blink per frame)
  for (let i = 0; i < 3; i++) {
    const x = (1 + i * 2.3) * T;
    r(ctx, x, 11 * T, 26, 3 * T + 4, '#111318');
    r(ctx, x + 1, 11 * T + 1, 24, 1, '#3a3f5c');
    for (let s = 0; s < 6; s++) r(ctx, x + 3, 11 * T + 5 + s * 8, 20, 5, '#1f232c');
  }

  // war room: whiteboard, table, chairs
  r(ctx, 24 * T, 1 * T, 4 * T, 1.6 * T, '#d9dde6');
  r(ctx, 24 * T, 1 * T, 4 * T, 2, '#9aa3b5');
  for (const [x, y, w, c] of [[4, 5, 18, '#4b8bc4'], [4, 10, 12, '#c45b4b'], [26, 6, 14, '#3fa35b'], [26, 12, 22, '#4b8bc4'], [8, 16, 30, '#1b1d27']] as const) {
    r(ctx, 24 * T + x, 1 * T + y, w, 1, c);
  }
  r(ctx, 24.5 * T, 5.8 * T, 3 * T, 1.3 * T, '#6e4a33');
  r(ctx, 24.5 * T, 5.8 * T, 3 * T, 2, '#8a5d40');
  plant(ctx, 29.3 * T, 4.8 * T);
  plant(ctx, 29.3 * T, 10 * T);

  // kitchen: counter, coffee machine, fridge, cooler, couch
  r(ctx, 23 * T, 11 * T, 7 * T, 12, '#8f8a7c');
  r(ctx, 23 * T, 11 * T, 7 * T, 2, '#aaa595');
  r(ctx, 23.8 * T, 10.6 * T, 12, 14, '#2a2c35'); // coffee machine
  r(ctx, 24.1 * T, 11.1 * T, 4, 3, C.red);
  r(ctx, 26.1 * T, 10.4 * T, 16, 22, '#e8e6e0'); // fridge
  r(ctx, 26.1 * T + 13, 10.4 * T + 6, 1, 8, '#9a978e');
  r(ctx, 28.3 * T, 10.9 * T, 10, 6, '#9fd3ff'); // cooler
  r(ctx, 28.3 * T, 11.3 * T, 10, 12, '#d8dde6');
  r(ctx, 24.6 * T, 15.6 * T, 3 * T, 14, '#b4483f'); // couch
  r(ctx, 24.6 * T, 15.6 * T, 3 * T, 5, '#cf5a4f');
  r(ctx, 28.6 * T, 15.5 * T, 14, 10, '#6e4a33'); // side table
  plant(ctx, 23.6 * T, 16.9 * T);

  // open floor: desks, plants
  for (let i = 0; i < MAX_DESKS; i++) {
    const d = deskTile(i);
    drawDesk(ctx, d.x, d.y);
  }
  plant(ctx, 9.6 * T, 4.4 * T, true);
  plant(ctx, 21.4 * T, 4.4 * T, true);
  plant(ctx, 9.6 * T, 16.8 * T);

  // your desk: an inbox tray and a phone, nobody sits here (you are on Telegram)
  r(ctx, 13.5 * T, 15.6 * T, 3 * T, 14, C.deskTop);
  r(ctx, 13.5 * T, 15.6 * T + 10, 3 * T, 4, C.deskFront);
  r(ctx, 14.5 * T, 15.6 * T + 2, 14, 8, '#7a7f95');
  r(ctx, 14.5 * T + 1, 15.6 * T + 3, 12, 6, '#565a6c');
  r(ctx, 15.6 * T, 15.6 * T + 3, 5, 8, '#1b1d27');
  r(ctx, 15.6 * T + 1, 15.6 * T + 4, 3, 5, '#6cb6ff');

  // outbox to GitHub
  r(ctx, 20 * T, 15.2 * T, 18, 16, '#3c5a8a');
  r(ctx, 20 * T, 15.2 * T, 18, 3, '#4f74ad');
  r(ctx, 20 * T + 4, 15.2 * T + 6, 10, 2, '#1b1d27');
}

/** Hyde's desk front, drawn over Hyde so he sits behind it. */
export function drawHydeDesk(ctx: Ctx) {
  r(ctx, 2 * T, 6.2 * T, 3 * T, 10, '#5b3a26');
  r(ctx, 2 * T, 6.2 * T, 3 * T, 2, '#7a5236');
  r(ctx, 3 * T, 5.4 * T, 18, 11, C.monitor);
  r(ctx, 3 * T + 1, 5.4 * T + 1, 16, 8, '#1d2b4a');
}

export function drawLeds(ctx: Ctx, t: number, busy: number) {
  for (let i = 0; i < 3; i++) {
    const x = (1 + i * 2.3) * T;
    for (let s = 0; s < 6; s++) {
      const on = Math.floor(t * (2 + busy) + i * 3 + s * 5) % 3 !== 0;
      r(ctx, x + 5, 11 * T + 6 + s * 8, 2, 2, on ? C.green : '#24412d');
      r(ctx, x + 9, 11 * T + 6 + s * 8, 2, 2, s % 2 && on ? C.amber : '#3b301a');
    }
  }
}

export function drawClock(ctx: Ctx, now: Date) {
  const cx = 13 * T + 8;
  const cy = 1.4 * T;
  r(ctx, cx - 7, cy - 7, 14, 14, C.white);
  r(ctx, cx - 7, cy - 7, 14, 1, '#9aa3b5');
  const h = ((now.getHours() % 12) + now.getMinutes() / 60) / 12;
  const m = now.getMinutes() / 60;
  for (const [f, len, c] of [[h, 3.5, C.ink], [m, 5.5, C.red]] as const) {
    const a = f * Math.PI * 2 - Math.PI / 2;
    for (let s = 0; s <= len; s += 0.5) r(ctx, cx + Math.cos(a) * s, cy + Math.sin(a) * s, 1, 1, c);
  }
}

// ---------- people ----------

export interface Look {
  skin: string;
  hair: string;
  hairStyle: 0 | 1 | 2 | 3;
  shirt: string;
  pants: string;
  tie?: string;
}

const SKINS = ['#f1c6a5', '#e0a982', '#c68863', '#9a6646', '#6e4630'];
const HAIRS = ['#2b1d16', '#5a3a22', '#a8692f', '#d9b35b', '#7d7d86', '#1d1d24', '#b5443c'];

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function lookFor(name: string, shirt: string): Look {
  const h = hash(name);
  return {
    skin: SKINS[h % SKINS.length]!,
    hair: HAIRS[(h >> 3) % HAIRS.length]!,
    hairStyle: ((h >> 6) % 4) as Look['hairStyle'],
    shirt,
    pants: ['#2f3346', '#3b3326', '#25303f'][(h >> 9) % 3]!,
  };
}

export const HYDE_LOOK: Look = { skin: '#f1c6a5', hair: '#1d1d24', hairStyle: 0, shirt: '#2b2d42', pants: '#1b1c28', tie: '#c0392b' };

/**
 * One person, feet at (fx, fy) in pixels. frame: walk cycle step (0..3); typing: hands move.
 * 12 px wide, 20 px tall.
 */
export function drawPerson(ctx: Ctx, fx: number, fy: number, look: Look, face: Facing, frame: number, opts: { typing?: boolean; sitting?: boolean; t?: number; dim?: boolean } = {}) {
  const x = Math.round(fx - 6);
  const y = Math.round(fy - 20);
  ctx.globalAlpha = opts.dim ? 0.55 : 1;
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.fillRect(x + 1, y + 19, 10, 2);
  const step = opts.sitting ? 0 : [0, 1, 0, -1][frame % 4]!;
  // legs
  r(ctx, x + 3, y + 15, 3, 4 - Math.max(0, step), look.pants);
  r(ctx, x + 7, y + 15, 3, 4 - Math.max(0, -step), look.pants);
  r(ctx, x + 3, y + 19 - Math.max(0, step), 3, 1, '#14151c');
  r(ctx, x + 7, y + 19 - Math.max(0, -step), 3, 1, '#14151c');
  // body and arms
  r(ctx, x + 2, y + 9, 8, 7, look.shirt);
  const tap = opts.typing ? Math.floor((opts.t ?? 0) * 8) % 2 : 0;
  const swing = opts.sitting ? 0 : step;
  if (face === 'up' && opts.typing) {
    r(ctx, x + 1, y + 9, 2, 4, look.shirt);
    r(ctx, x + 9, y + 9, 2, 4, look.shirt);
    r(ctx, x + 1, y + 7 + tap, 2, 2, look.skin);
    r(ctx, x + 9, y + 8 - tap, 2, 2, look.skin);
  } else if (face === 'left' || face === 'right') {
    const ax = face === 'left' ? x + 5 + swing : x + 5 - swing;
    r(ctx, ax, y + 10, 2, 5, look.shirt);
    r(ctx, ax, y + 15, 2, 1, look.skin);
  } else {
    r(ctx, x + 1, y + 10 + swing, 2, 5, look.shirt);
    r(ctx, x + 9, y + 10 - swing, 2, 5, look.shirt);
    r(ctx, x + 1, y + 15 + swing, 2, 1, look.skin);
    r(ctx, x + 9, y + 15 - swing, 2, 1, look.skin);
  }
  if (face === 'down') {
    r(ctx, x + 5, y + 9, 2, 1, C.white);
    if (look.tie) r(ctx, x + 5, y + 10, 2, 4, look.tie);
  }
  // head
  r(ctx, x + 3, y + 2, 6, 7, look.skin);
  r(ctx, x + 2, y + 4, 1, 3, look.skin);
  r(ctx, x + 9, y + 4, 1, 3, look.skin);
  const hairTop = () => {
    r(ctx, x + 2, y + 1, 8, 3, look.hair);
    r(ctx, x + 3, y, 6, 1, look.hair);
  };
  if (face === 'up') {
    r(ctx, x + 2, y + 1, 8, 7, look.hair);
    r(ctx, x + 3, y, 6, 1, look.hair);
    if (look.hairStyle === 2) r(ctx, x + 2, y + 7, 8, 3, look.hair);
    if (look.hairStyle === 3) r(ctx, x + 4, y - 2, 4, 2, look.hair);
  } else {
    if (look.hairStyle !== 1 || face !== 'down') hairTop();
    else r(ctx, x + 3, y + 1, 6, 2, look.hair);
    if (look.hairStyle === 2) {
      r(ctx, x + 2, y + 3, 1, 6, look.hair);
      r(ctx, x + 9, y + 3, 1, 6, look.hair);
    }
    if (look.hairStyle === 3) r(ctx, x + 4, y - 2, 4, 2, look.hair);
    if (face === 'down') {
      r(ctx, x + 4, y + 5, 1, 2, C.ink);
      r(ctx, x + 7, y + 5, 1, 2, C.ink);
      r(ctx, x + 5, y + 8, 2, 1, '#c97a6a');
    } else {
      const ex = face === 'left' ? x + 3 : x + 8;
      r(ctx, ex, y + 5, 1, 2, C.ink);
      r(ctx, face === 'left' ? x + 7 : x + 2, y + 3, 2, 4, look.hair);
    }
  }
  ctx.globalAlpha = 1;
}

export function drawEnvelope(ctx: Ctx, px: number, py: number, color = C.white) {
  const x = Math.round(px - 4);
  const y = Math.round(py - 3);
  r(ctx, x, y, 9, 6, color);
  r(ctx, x, y, 9, 1, '#b9b3a2');
  r(ctx, x + 1, y + 1, 1, 1, '#b9b3a2');
  r(ctx, x + 7, y + 1, 1, 1, '#b9b3a2');
  r(ctx, x + 2, y + 2, 1, 1, '#b9b3a2');
  r(ctx, x + 6, y + 2, 1, 1, '#b9b3a2');
  r(ctx, x + 3, y + 3, 3, 1, '#b9b3a2');
}

export function drawSparkle(ctx: Ctx, px: number, py: number, k: number) {
  const colors = [C.amber, C.green, '#6cb6ff', C.red, C.white];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const d = 4 + k * 18;
    r(ctx, px + Math.cos(a) * d, py + Math.sin(a) * d - k * 6, 2, 2, colors[i % colors.length]!);
  }
}

export function drawInboxFlag(ctx: Ctx, count: number, t: number) {
  if (!count) return;
  const x = 14.5 * T + 14;
  const y = 15.6 * T - 10 + (Math.floor(t * 2) % 2);
  r(ctx, x, y, 1, 12, '#d9d6cc');
  r(ctx, x + 1, y, 7, 5, C.red);
}
