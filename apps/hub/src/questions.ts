import type { HarnessState, QuestionView, TaskView } from '@hyde/core';

// Question memory: before a question is recorded, it is compared with the open and answered
// questions of its task and project. An answered match goes back to the agent at once; an open
// match is linked instead of creating a second Q-n. Cheap and deterministic: normalised word
// sets, compared by overlap.

const STOP = new Set(
  'a an the and or but if then so to of in on at for from by with without as is are was were be been being do does did i we you it this that these those there here which what who whom whose when where why how should shall would will can could may might must my our your their its me us them please just also any some all each every other only own same than too very about into over under again further once more most such no nor not ok okay ask asking question want like need use using used'.split(' '),
);

function stem(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('es') && !word.endsWith('ses')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** The content words of a question, lower-cased and stemmed. */
export function questionWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[`'"’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w))
    .map(stem)
    .filter((w) => w.length > 1 || /\d/.test(w));
  return new Set(words);
}

/**
 * 0..1. Jaccard overlap, or (for questions with at least three content words) how much of the
 * shorter one the longer contains: "What three rooms should ROOMS.md list?" is inside the original
 * long question about which three rooms docs/ROOMS.md should list.
 */
export function similarity(a: string, b: string): number {
  const x = questionWords(a);
  const y = questionWords(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  const jaccard = both / (x.size + y.size - both);
  const small = Math.min(x.size, y.size);
  const containment = small >= 3 ? (both / small) * 0.9 : 0;
  return Math.max(jaccard, containment);
}

/** Same task: a looser match is enough. Other tasks in the project: only close matches. */
export const SAME_TASK_THRESHOLD = 0.6;
export const PROJECT_THRESHOLD = 0.75;

export interface QuestionMatch {
  question: QuestionView;
  score: number;
  /** 'task' when the earlier question belongs to (or is linked to) this task. */
  scope: 'task' | 'project';
}

/** True when the question was asked on this task or linked to it by a later ask. */
export function questionOf(q: QuestionView, taskId: string): boolean {
  return q.taskId === taskId || q.matches.some((m) => m.taskId === taskId);
}

/**
 * The best earlier question this one repeats, if any. Answered questions win over open ones at
 * equal scores (the agent can go on at once). Questions of cancelled tasks still count as answered
 * memory but not as open ones (nobody will answer them).
 */
export function findMatch(state: HarnessState, task: TaskView, text: string): QuestionMatch | undefined {
  let best: QuestionMatch | undefined;
  for (const q of state.questions.values()) {
    const owner = state.tasks.get(q.taskId);
    if (!owner || owner.projectId !== task.projectId) continue;
    const scope = questionOf(q, task.id) ? 'task' : 'project';
    if (q.status === 'open' && scope === 'project' && ['cancelled', 'done', 'failed'].includes(owner.status)) continue;
    if (q.status === 'open' && scope === 'task' && owner.status === 'cancelled') continue;
    const score = Math.max(similarity(text, q.text), ...q.matches.map((m) => similarity(text, m.text)));
    if (score < (scope === 'task' ? SAME_TASK_THRESHOLD : PROJECT_THRESHOLD)) continue;
    const better = !best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && q.status === 'answered' && best.question.status === 'open');
    if (better) best = { question: q, score, scope };
  }
  return best;
}
