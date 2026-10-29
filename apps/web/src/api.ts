import { useEffect, useRef, useState } from 'react';
import type { Command, StateSnapshot } from '@hyde/core';
import { describeEvent, type FeedEvent } from '@hyde/core/office';

export interface AgentInfo {
  name: string;
  adapter: string;
  enabled: boolean;
  model?: string;
  roles: string[];
  maxConcurrent: number;
  account: string;
  node: string;
  vendor: string;
  health: { installed: boolean; signedIn: boolean; version?: string; account?: string; problem?: string } | null;
}

export interface Metrics {
  agent: string;
  runs: number;
  running: number;
  failed: number;
  successRate: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  avgMinutes: number;
  tasksDone: number;
}

export type HubState = StateSnapshot & {
  agents: AgentInfo[];
  projects: { id: string; name: string; baseBranch: string; releaseBranch: string; checks: string[]; preview: boolean }[];
  metrics: Metrics[];
  stages: { planner: boolean; review: boolean; browser: boolean; policy: boolean };
};

export class AuthError extends Error {}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...init.headers }, credentials: 'same-origin' });
  if (res.status === 401) throw new AuthError('login required');
  const ct = res.headers.get('content-type') ?? '';
  const body = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  state: () => call<HubState>('/api/state'),
  command: (command: Command | string) =>
    call<{ text: string }>('/api/commands', { method: 'POST', body: JSON.stringify(typeof command === 'string' ? { text: command } : { command }) }),
  taskEvents: (id: string) => call<(FeedEvent & { payload: any })[]>(`/api/tasks/${id}/events`),
  diff: (id: string) => call<string>(`/api/tasks/${id}/diff`),
  config: () => call<Record<string, any>>('/api/config'),
  saveConfig: (raw: unknown) => call<{ ok: boolean }>('/api/config', { method: 'PUT', body: JSON.stringify(raw) }),
  detect: () =>
    call<{ id: string; label: string; kind: string; installed: boolean; signedIn: boolean; version?: string; account?: string; problem?: string; howTo?: string; suggest?: Record<string, any> }[]>('/api/setup/detect'),
  feed: () => call<FeedEvent[]>('/api/feed'),
  audit: () => call<{ seq: number; ts: string; type: string; actor: { kind: string; id: string }; taskId?: string; runId?: string }[]>('/api/audit'),
};

const listeners = new Set<(e: FeedEvent) => void>();

/** Every live hub event, as it arrives. Returns an unsubscribe function. */
export function onHubEvent(fn: (e: FeedEvent) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export interface FeedLine {
  seq: number;
  ts: string;
  text: string;
  type: string;
  taskId?: string;
}

const FEED_MAX = 150;

function toLines(events: FeedEvent[]): FeedLine[] {
  const out: FeedLine[] = [];
  for (const e of events) {
    const text = describeEvent(e);
    if (text) out.push({ seq: e.seq, ts: e.ts, text, type: e.type, taskId: e.payload?.taskId ?? e.taskId });
  }
  return out;
}

/** The hub state, refreshed on every server-sent event (debounced), plus a live activity feed. */
export function useHub(): { state: HubState | null; error: string | null; needsLogin: boolean; refresh: () => void; connected: boolean; feed: FeedLine[] } {
  const [feed, setFeed] = useState<FeedLine[]>([]);
  const [state, setState] = useState<HubState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [connected, setConnected] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const refresh = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      api.state().then(
        (s) => {
          setState(s);
          setError(null);
        },
        (e: Error) => (e instanceof AuthError ? setNeedsLogin(true) : setError(e.message)),
      );
    }, 150);
  };

  useEffect(() => {
    refresh();
    api.feed().then((events) => setFeed((now) => [...toLines(events), ...now.filter((l) => l.seq > (events.at(-1)?.seq ?? 0))].slice(-FEED_MAX)), () => {});
    const source = new EventSource('/api/events', { withCredentials: true });
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (m) => {
      refresh();
      let e: FeedEvent;
      try {
        e = JSON.parse(m.data) as FeedEvent;
      } catch {
        return;
      }
      for (const fn of listeners) fn(e);
      const lines = toLines([e]);
      if (lines.length) setFeed((now) => (now.some((l) => l.seq === e.seq) ? now : [...now, ...lines].slice(-FEED_MAX)));
    };
    return () => source.close();
  }, []);

  return { state, error, needsLogin, refresh, connected, feed };
}

export function ago(ts: string | undefined): string {
  if (!ts) return '';
  const s = Math.round((Date.now() - Date.parse(ts)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function navigate(hash: string): void {
  window.location.hash = hash;
}
