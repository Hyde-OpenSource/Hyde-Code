// The cast — roster metadata + sprite frames (ported from Munder Difflin, MIT).
//
// Both the static portraits (cards / picker) and the in-scene walking sprites are
// now fully custom-drawn from the same per-character recipes in portraitArt.ts:
// the scene sprite reuses the portrait's exact head/face/clothing and adds legs,
// so an agent on the office floor looks identical to its card. The LimeZu base
// sheets are no longer used for the cast. See assets/ATTRIBUTION.md.

import { Texture } from 'pixi.js';
import { paintPortrait, sceneFrameBufs, SCENE_W, SCENE_H } from './portraitArt';

export type OfficeCharacterName =
  | 'boss' | 'ada' | 'bo' | 'cy' | 'dee' | 'eli' | 'fay'
  | 'gus' | 'ivy' | 'jo' | 'kai' | 'lu' | 'max';

export interface CastMember {
  name: OfficeCharacterName;
  displayName: string;
  /** Signature accent color (hex) — used for the in-scene selection glow. */
  shirt: string;
  /** Blurb shown when this character is picked / has no description yet. */
  blurb: string;
}

/** Hyde Code's cast: original, generic coworkers. `boss` is Hyde, the hub. */
export const OFFICE_CAST: CastMember[] = [
  { name: 'boss', displayName: 'Hyde', shirt: '#2c344a', blurb: 'The hub: plans and hands out work' },
  { name: 'ada', displayName: 'Ada', shirt: '#608c78', blurb: 'Coworker' },
  { name: 'bo', displayName: 'Bo', shirt: '#d68c5c', blurb: 'Coworker' },
  { name: 'cy', displayName: 'Cy', shirt: '#78a0d2', blurb: 'Coworker' },
  { name: 'dee', displayName: 'Dee', shirt: '#9678c8', blurb: 'Coworker' },
  { name: 'eli', displayName: 'Eli', shirt: '#beaa78', blurb: 'Coworker' },
  { name: 'fay', displayName: 'Fay', shirt: '#5aaabe', blurb: 'Coworker' },
  { name: 'gus', displayName: 'Gus', shirt: '#964646', blurb: 'Coworker' },
  { name: 'ivy', displayName: 'Ivy', shirt: '#dec45a', blurb: 'Coworker' },
  { name: 'jo', displayName: 'Jo', shirt: '#6e788c', blurb: 'Coworker' },
  { name: 'kai', displayName: 'Kai', shirt: '#78be78', blurb: 'Coworker' },
  { name: 'lu', displayName: 'Lu', shirt: '#e68296', blurb: 'Coworker' },
  { name: 'max', displayName: 'Max', shirt: '#465a96', blurb: 'Coworker' },
];

export const CAST_BY_NAME: Record<OfficeCharacterName, CastMember> =
  Object.fromEntries(OFFICE_CAST.map((c) => [c.name, c])) as Record<OfficeCharacterName, CastMember>;

export const DEFAULT_CHARACTER: OfficeCharacterName = 'kai';

/** Workers (everyone but the boss), for picking a look per agent. */
export const WORKER_CAST: OfficeCharacterName[] = OFFICE_CAST.map((c) => c.name).filter((n) => n !== 'boss');

export function hexToNumber(hex: string): number {
  return parseInt(hex.replace('#', ''), 16);
}

// ─── scene frames ────────────────────────────────────────────────────────────
const frameCache = new Map<OfficeCharacterName, Texture[][]>();

function bufToTexture(buf: Uint8ClampedArray): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = SCENE_W; canvas.height = SCENE_H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(SCENE_W, SCENE_H);
  img.data.set(buf);
  ctx.putImageData(img, 0, 0);
  const tex = Texture.from(canvas);
  tex.source.scaleMode = 'nearest';
  return tex;
}

/**
 * Frame grid CharacterSprite expects: 3 rows (down, up, right) × 7 frames
 * [walk1, walk2, walk3, type1, type2, read1, read2]. We provide a front view
 * (down — and reused for the side row, so left/right walkers still show a face)
 * and a back view (up — agents seated facing their desk show their back). The
 * three walk frames are stand / step-left / step-right.
 */
export async function getCastFrames(name: OfficeCharacterName): Promise<Texture[][]> {
  const cached = frameCache.get(name);
  if (cached) return cached;
  const { front, back } = sceneFrameBufs(name);
  const toRow = (bufs: Uint8ClampedArray[]): Texture[] => {
    const [stand, stepL, stepR] = bufs.map(bufToTexture);
    return [stand, stepL, stepR, stand, stand, stand, stand];
  };
  const frontRow = toRow(front);
  const frames: Texture[][] = [frontRow, toRow(back), frontRow]; // down, up, right
  frameCache.set(name, frames);
  return frames;
}

/**
 * Paint a character's static portrait for cards / the picker (delegates to the
 * custom procedural composer in portraitArt.ts).
 */
export async function paintCastPortrait(
  ctx: CanvasRenderingContext2D,
  name: OfficeCharacterName,
  scale = 2,
): Promise<void> {
  paintPortrait(ctx, name, scale);
}
