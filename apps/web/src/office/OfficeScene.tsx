import { useEffect, useMemo, useRef } from 'react';
import type { AgentActivity, FeedEvent } from '@hyde/core/office';
import { onHubEvent, type HubState } from '../api.ts';
import { vendorColor } from '../ui.tsx';
import {
  HEIGHT, HYDE_LOOK, HYDE_POS, INBOX_POS, KITCHEN_SPOTS, OUTBOX_POS, REVIEW_SPOTS, TILE, WAR_ROOM_POS, WHITEBOARD_SPOTS, WIDTH,
  deskSpot, deskTile, drawBackground, drawClock, drawEnvelope, drawHydeDesk, drawInboxFlag, drawLeds, drawMonitor, drawPerson, drawSparkle, hash, lookFor, route,
  type Facing, type Look, type P, type Screen, type SpotDef,
} from './scene.ts';

interface Walker {
  name: string;
  look: Look;
  pos: P;
  path: P[];
  spotKey: string;
  spot: SpotDef;
  face: Facing;
  dist: number;
  wanderAt: number;
  wanderKey: string;
}

interface Flight {
  from: P;
  to: P;
  start: number;
  dur: number;
  color?: string;
}

const SPEED = 3.2; // tiles per second

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function spotFor(a: AgentActivity, deskIndex: number, order: number, w: Walker | undefined, now: number, taken: Set<string>): { key: string; spot: SpotDef } | null {
  switch (a.mood) {
    case 'off':
      return null;
    case 'planning':
      return { key: `wb${order % WHITEBOARD_SPOTS.length}`, spot: WHITEBOARD_SPOTS[order % WHITEBOARD_SPOTS.length]! };
    case 'reviewing':
      return { key: `rv${order % REVIEW_SPOTS.length}`, spot: REVIEW_SPOTS[order % REVIEW_SPOTS.length]! };
    case 'idle': {
      // Idle agents drift between their desk and the kitchen.
      if (w && now < w.wanderAt && w.wanderKey) return w.wanderKey === 'desk' ? { key: 'desk', spot: deskSpot(deskIndex) } : { key: w.wanderKey, spot: KITCHEN_SPOTS[Number(w.wanderKey.slice(1))]! };
      const roll = (hash(`${a.name}${Math.floor(now / 1000)}`) % 100) / 100;
      if (roll < 0.4) return { key: 'desk', spot: deskSpot(deskIndex) };
      // Pick a free kitchen spot so two people never stand on each other.
      const start = hash(`${a.name}${now}`) % KITCHEN_SPOTS.length;
      for (let j = 0; j < KITCHEN_SPOTS.length; j++) {
        const k = (start + j) % KITCHEN_SPOTS.length;
        if (!taken.has(`k${k}`)) return { key: `k${k}`, spot: KITCHEN_SPOTS[k]! };
      }
      return { key: 'desk', spot: deskSpot(deskIndex) };
    }
    default:
      return { key: 'desk', spot: deskSpot(deskIndex) };
  }
}

function screenFor(a: AgentActivity | undefined, atDesk: boolean): Screen {
  if (!a || a.mood === 'off') return 'off';
  if (a.mood === 'broken') return 'error';
  if (a.mood === 'needs-you') return 'question';
  if (a.mood === 'working' && atDesk) return 'code';
  return 'idle';
}

const pct = (p: P, dy = 0) => ({ left: `${((p.x * TILE) / WIDTH) * 100}%`, top: `${((p.y * TILE + dy) / HEIGHT) * 100}%` });

export function OfficeScene({
  state,
  activity,
  selected,
  onSelect,
  onInbox,
  inboxCount,
}: {
  state: HubState;
  activity: AgentActivity[];
  selected: string | null;
  onSelect: (name: string | null) => void;
  onInbox: () => void;
  inboxCount: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const tags = useRef(new Map<string, HTMLElement>());
  const walkers = useRef(new Map<string, Walker>());
  const flights = useRef<Flight[]>([]);
  const sparkles = useRef<{ at: P; start: number }[]>([]);
  const live = useRef({ state, activity, selected, inboxCount });
  live.current = { state, activity, selected, inboxCount };

  const agents = state.agents;
  const deskOf = useMemo(() => new Map(agents.map((a, i) => [a.name, i])), [agents]);
  const background = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = WIDTH;
    c.height = HEIGHT;
    drawBackground(c.getContext('2d')!);
    return c;
  }, []);

  // Envelopes fly when work is handed out, questions are asked, reviews come back and PRs open.
  useEffect(
    () =>
      onHubEvent((e: FeedEvent) => {
        if (reducedMotion()) return;
        const { state: s } = live.current;
        const p = e.payload ?? {};
        const taskAgent = (taskId?: string) => s.tasks.find((t) => t.id === taskId)?.agent;
        const at = (name?: string): P => (name && walkers.current.get(name)?.pos) || HYDE_POS;
        const fly = (from: P, to: P, color?: string) => flights.current.push({ from: { ...from, y: from.y - 1 }, to: { ...to, y: to.y - 0.6 }, start: performance.now(), dur: 1400, color });
        switch (e.type) {
          case 'run.dispatched':
            return fly(HYDE_POS, at(p.agent));
          case 'question.asked':
          case 'approval.requested':
            return fly(at(taskAgent(p.taskId)), INBOX_POS, '#ffe9a8');
          case 'question.answered':
          case 'approval.decided':
            return fly(INBOX_POS, HYDE_POS);
          case 'task.review_finished':
            return fly(WAR_ROOM_POS, at(taskAgent(p.taskId)), p.verdict === 'approve' ? '#c8f7d4' : '#ffd0d0');
          case 'task.pr_opened':
            return fly(at(taskAgent(p.taskId)), OUTBOX_POS);
          case 'task.merged':
            sparkles.current.push({ at: OUTBOX_POS, start: performance.now() });
            return;
        }
      }),
    [],
  );

  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const still = reducedMotion();
      const t = still ? 0 : now / 1000;
      const { activity: acts, inboxCount: count, state: s } = live.current;
      const byName = new Map(acts.map((a) => [a.name, a]));

      // move people
      let n = 0;
      for (const a of acts) {
        const i = deskOf.get(a.name) ?? 0;
        if (a.mood === 'planning' || a.mood === 'reviewing') n++;
        let w = walkers.current.get(a.name);
        const taken = new Set([...walkers.current.values()].filter((x) => x.name !== a.name).map((x) => x.spotKey));
        const want = spotFor(a, i, n, w, Date.now(), taken);
        if (!want) {
          walkers.current.delete(a.name);
          continue;
        }
        if (!w) {
          const agent = s.agents.find((x) => x.name === a.name);
          w = { name: a.name, look: lookFor(a.name, vendorColor(agent?.vendor ?? '')), pos: { ...want.spot.pos }, path: [], spotKey: want.key, spot: want.spot, face: want.spot.face, dist: 0, wanderAt: 0, wanderKey: '' };
          walkers.current.set(a.name, w);
        }
        if (a.mood === 'idle' && Date.now() >= w.wanderAt) {
          w.wanderKey = want.key;
          w.wanderAt = Date.now() + 9000 + (hash(a.name + now) % 14000);
        }
        if (want.key !== w.spotKey) {
          const from: SpotDef = { pos: { ...w.pos }, aisle: w.pos.y < 11 ? 8 : 14, face: w.face };
          w.path = still ? [want.spot.pos] : route(from, want.spot);
          w.spotKey = want.key;
          w.spot = want.spot;
        }
        if (still && w.path.length) {
          w.pos = { ...w.spot.pos };
          w.path = [];
        }
        let budget = SPEED * dt;
        while (budget > 0 && w.path.length) {
          const next = w.path[0]!;
          const dx = next.x - w.pos.x;
          const dy = next.y - w.pos.y;
          const d = Math.hypot(dx, dy);
          if (d > 0.001) w.face = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : 'down';
          if (d <= budget) {
            w.pos = { ...next };
            w.path.shift();
            budget -= d;
            w.dist += d;
          } else {
            w.pos = { x: w.pos.x + (dx / d) * budget, y: w.pos.y + (dy / d) * budget };
            w.dist += budget;
            budget = 0;
          }
        }
        if (!w.path.length) w.face = w.spot.face;
      }

      // draw
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(background, 0, 0);
      drawClock(ctx, new Date());
      const busy = acts.filter((a) => a.mood === 'working').length;
      drawLeds(ctx, t, busy);
      agents.forEach((a, i) => {
        if (i >= 10) return;
        const d = deskTile(i);
        const act = byName.get(a.name);
        const w = walkers.current.get(a.name);
        const atDesk = Boolean(w && !w.path.length && w.spotKey === 'desk');
        drawMonitor(ctx, d.x, d.y, screenFor(act, atDesk), t, vendorColor(a.vendor));
      });
      const people = [...walkers.current.values()].sort((a, b) => a.pos.y - b.pos.y);
      // Hyde, the hub, behind his desk
      drawPerson(ctx, HYDE_POS.x * TILE, HYDE_POS.y * TILE - 6, HYDE_LOOK, 'down', 0, { sitting: true, t });
      drawHydeDesk(ctx);
      for (const w of people) {
        const act = byName.get(w.name);
        const walking = w.path.length > 0;
        const atDesk = !walking && w.spotKey === 'desk';
        drawPerson(ctx, w.pos.x * TILE, w.pos.y * TILE, w.look, w.face, Math.floor(w.dist * 4), {
          typing: atDesk && act?.mood === 'working',
          sitting: !walking,
          t,
          dim: act?.mood === 'broken',
        });
        const el = tags.current.get(w.name);
        // People close together (desks, couch): lift every other name tag so they don't overlap.
        const crowd = people.filter((o) => Math.abs(o.pos.y - w.pos.y) < 1 && Math.abs(o.pos.x - w.pos.x) < 3).sort((a, b) => a.pos.x - b.pos.x);
        const lift = crowd.indexOf(w) % 2 ? 13 : 0;
        if (el) Object.assign(el.style, pct(w.pos, -26 - lift));
      }
      drawInboxFlag(ctx, count, t);
      flights.current = flights.current.filter((f) => {
        const k = (now - f.start) / f.dur;
        if (k >= 1) return false;
        const x = f.from.x + (f.to.x - f.from.x) * k;
        const y = f.from.y + (f.to.y - f.from.y) * k - Math.sin(k * Math.PI) * 2.2;
        drawEnvelope(ctx, x * TILE, y * TILE, f.color);
        return true;
      });
      sparkles.current = sparkles.current.filter((sp) => {
        const k = (now - sp.start) / 1200;
        if (k >= 1) return false;
        drawSparkle(ctx, sp.at.x * TILE, sp.at.y * TILE - 8, k);
        return true;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [background, deskOf, agents]);

  const byName = new Map(activity.map((a) => [a.name, a]));
  return (
    <div className="scene" role="group" aria-label="Office floor: each agent is a person at their desk">
      <canvas ref={canvas} width={WIDTH} height={HEIGHT} aria-hidden="true" onClick={() => onSelect(null)} />
      <span className="room-label" style={pct({ x: 0.4, y: 3.15 })}>Hyde's office</span>
      <span className="room-label" style={pct({ x: 0.4, y: 10.6 })}>Server room</span>
      <span className="room-label" style={pct({ x: 23.3, y: 3.15 })}>War room</span>
      <span className="room-label" style={pct({ x: 23.3, y: 14.2 })}>Kitchen</span>
      <button className="tag hyde" style={pct(HYDE_POS, -36)} onClick={() => onInbox()} title="Hyde, the hub: plans, hands out work and checks it">
        Hyde
      </button>
      <button className={`tag inbox ${inboxCount ? 'hot' : ''}`} style={pct(INBOX_POS, -30)} onClick={onInbox}>
        Your desk{inboxCount ? ` · ${inboxCount}` : ''}
      </button>
      {agents.map((a) => {
        const act = byName.get(a.name);
        if (!act || act.mood === 'off') return null;
        const isSel = selected === a.name;
        return (
          <button
            key={a.name}
            ref={(el) => {
              if (el) tags.current.set(a.name, el);
              else tags.current.delete(a.name);
            }}
            className={`tag agent mood-${act.mood} ${isSel ? 'selected' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(isSel ? null : a.name);
            }}
            aria-pressed={isSel}
            aria-label={`${a.name}: ${act.line}`}
          >
            <span className="tag-dot" style={{ background: vendorColor(a.vendor) }} />
            {a.name}
            {act.mood === 'needs-you' && <span className="tag-icon">?</span>}
            {(isSel || act.mood === 'needs-you') && <span className="bubble">{act.line}</span>}
          </button>
        );
      })}
    </div>
  );
}
