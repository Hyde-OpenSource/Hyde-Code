import { useEffect, useState } from 'react';
import type { Command } from '@hyde/core';
import { api, type FeedLine, type HubState } from './api.ts';

export interface PageProps {
  state: HubState;
  refresh: () => void;
  notify: (text: string) => void;
  feed: FeedLine[];
}

export function Toast({ text, onDone }: { text: string; onDone: () => void }) {
  useEffect(() => {
    const t = window.setTimeout(onDone, 5000);
    return () => window.clearTimeout(t);
  }, [text, onDone]);
  return (
    <div className="toast" role="status">
      {text}
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  running: 'accent',
  verifying: 'accent',
  review: 'accent',
  clarifying: 'accent',
  awaiting_merge: 'ok',
  done: 'ok',
  blocked: 'warn',
  failed: 'bad',
  cancelled: '',
  ready: '',
  backlog: '',
};

export function Status({ status }: { status: string }) {
  return <span className={`badge ${STATUS_TONE[status] ?? ''}`}>{status.replace('_', ' ')}</span>;
}

/** A button that runs a hub command and shows the reply. */
export function CommandButton({ command, label, notify, refresh, kind = '' }: { command: Command; label: string; kind?: 'primary' | 'danger' | ''; } & Pick<PageProps, 'notify' | 'refresh'>) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={`btn ${kind}`}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          notify((await api.command(command)).text);
          refresh();
        } catch (err) {
          notify(`Failed: ${(err as Error).message}`);
        } finally {
          setBusy(false);
        }
      }}
    >
      {label}
    </button>
  );
}

export function QuotaBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const tone = value >= 0.95 ? 'bad' : value >= 0.8 ? 'warn' : '';
  return (
    <div className="bar" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${pct}% used`}>
      <span className={tone} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

export function vendorColor(vendor: string): string {
  return { anthropic: '#d97757', openai: '#19b88a', google: '#4c8df6' }[vendor] ?? '#9b7bf0';
}
