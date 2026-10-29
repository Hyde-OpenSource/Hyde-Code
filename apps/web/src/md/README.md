# Office UI port (from Munder Difflin)

The office floor, characters, thought bubbles, envelopes, coffee breaks, errands, task
boards, design tokens and pixel components in this folder are ported from
[Munder Difflin](https://github.com/chaitanyagiri/munder-difflin) (commit f797048),
MIT licence, Copyright (c) 2026 Chaitanya Giri. See `LICENSE-munder-difflin`.

## What Hyde Code changed
- **Data**: `bridge.ts` maps the Hyde hub (tasks, runs, questions, quota) onto the
  office's agent model. Hyde, the hub, is the "boss" at the corner desk. `store/store.ts`
  is a tiny zustand-style store and `i18n/` a tiny English-only `react-i18next` stand-in.
- **Cast**: original generic coworkers (`scene/office/cast.ts`, `portraitArt.ts`), not
  the TV characters upstream draws. The cafeteria lines are rewritten too.
- **Tiles**: see below. `scene/office/fallbackTiles.ts` is new.
- Removed: Electron-only pieces (terminals, voice, cost HUD, rename), the Brooklyn 99
  theme and the cigar errand. The office clock opens Usage instead of quitting.

## Third-party assets
| Asset | Licence | In this repo? |
|---|---|---|
| `assets/maps/office.tmj` (Tiled map) | ISC, shahar061/the-office (`assets/maps/LICENSE-the-office`) | yes |
| `assets/fonts/*.woff2` (Press Start 2P, Inter, JetBrains Mono) | SIL OFL 1.1 (`assets/fonts/LICENSE.txt`) | yes |
| Floor tiles: LimeZu "Modern Interiors" | LimeZu licence: no redistribution, credit required | **no** |

The map is painted with LimeZu tiles. Their licence forbids redistributing them, so the
owner imports their own copy (`pnpm hyde tiles <folder>`, stored in `.hyde/assets/limezu/`,
served only to the logged-in dashboard). Without it the floor uses simple stand-in
tiles with the same layout. When the real tiles are loaded the office shows the
required credit: "Tiles: Modern Interiors by LimeZu" (https://limezu.itch.io/).
