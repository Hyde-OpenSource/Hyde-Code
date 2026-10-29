// Cafeteria small talk. Structure ported from Munder Difflin (MIT); the lines are
// Hyde Code's own: coding-agent office banter, no TV-show references.
//   • solo  — one quip shown above a single agent at a break spot
//   • pair  — a short exchange between two agents at the same table

import type { OfficeCharacterName } from './cast';

/** Where an agent is lingering — picks a contextual line pool. */
export type BreakSpot = 'coffee' | 'vending' | 'snack' | 'table';

const pick = <T,>(arr: readonly T[], seed: number): T => arr[((seed % arr.length) + arr.length) % arr.length]!;

const COFFEE: readonly string[] = [
  'is this… decaf?? who did this',
  "we're out of beans again",
  'first cup of the day. and the fifth.',
  'coffee: the real build step',
  'who took my mug?',
  'brewing while the tests run',
];

const VENDING: readonly string[] = [
  'the machine ate my coin',
  'B4… please be the pretzels',
  "it's stuck. classic.",
  'one (1) emotional-support snack',
  'A1 again. living dangerously.',
];

const SNACK: readonly string[] = ['who finished the chips??', 'just a little treat', 'second breakfast', 'snack-driven development'];

const TABLE: readonly string[] = [
  'big diff today.',
  'just five more minutes',
  'did you see the review notes?',
  'pretending to read the spec',
  'I needed this break, honestly',
  'do NOT tell Hyde I’m in here',
  'my context window is full',
];

const SPOT_POOL: Record<BreakSpot, readonly string[]> = { coffee: COFFEE, vending: VENDING, snack: SNACK, table: TABLE };

/** A little personality per look (optional; anyone else uses the spot pools). */
const BY_CHARACTER: Partial<Record<OfficeCharacterName, readonly string[]>> = {
  ada: ['tabs or spaces? both. depends.', 'I wrote a test for my coffee'],
  bo: ['ship it friday? bold.', 'my PR has 2 approvals and a vibe'],
  cy: ['I read the whole RFC. for fun.', 'linter says hi'],
  gus: ['back in my day we had makefiles', 'have you tried turning it off and on'],
  max: ['who renamed my branch', 'merge conflict, my old friend'],
};

export function pickSoloLine(character: OfficeCharacterName, spot: BreakSpot, seed: number): string {
  const flavour = BY_CHARACTER[character];
  if (flavour && seed % 5 < 3) return pick(flavour, Math.floor(seed / 5));
  return pick(SPOT_POOL[spot], seed);
}

type Exchange = readonly string[];

const EXCHANGES: readonly Exchange[] = [
  ['did your tests pass?', 'all green.', 'first try?', "…don't ask."],
  ['who broke staging?', 'not me.', 'it says your name.', 'blame says a lot of things.'],
  ['how big was your diff?', 'three lines.', 'nice.', 'and a 400-line lockfile.'],
  ['quota check?', 'eighty percent.', 'Hyde will park us soon.', 'more coffee then.'],
  ['you got the review?', 'changes requested.', 'ouch.', 'it was a typo. one typo.'],
  ['what are you on?', 'docs.', 'nice and calm.', 'until someone reads them.'],
  ['the owner answered my question', 'on a Sunday?', 'from their phone.', 'legend.'],
];

const KEYED_EXCHANGES: Partial<Record<OfficeCharacterName, Exchange>> = {
  cy: ['question.', 'yes?', 'nothing. just checking the linter.'],
  bo: ['ship it?', 'review first.', 'fine. ship it after review.'],
};

/** A multi-beat exchange for two agents sharing a table. Beats alternate:
 *  index 0 = `speaker`, 1 = the table-mate, 2 = speaker, … */
export function pickExchange(speaker: OfficeCharacterName, seed: number): Exchange {
  const keyed = KEYED_EXCHANGES[speaker];
  if (keyed && seed % 4 === 0) return keyed;
  return pick(EXCHANGES, seed);
}
