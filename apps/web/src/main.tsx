import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useHub } from './api.ts';
import { Audit } from './pages/Audit.tsx';
import { Board } from './pages/Board.tsx';
import { Inbox, inboxCount } from './pages/Inbox.tsx';
import { Office } from './pages/Office.tsx';
import { Settings } from './pages/Settings.tsx';
import { TaskPage } from './pages/TaskPage.tsx';
import { Usage } from './pages/Usage.tsx';
import { Toast } from './ui.tsx';
import '@/design/fonts.css';
import '@/design/tokens.css';
import './styles.css';
import { toggleAppTheme, useAppTheme } from '@/design/theme';
import { Icon } from '@/components/Icon';

const PAGES = [
  ['office', 'Office'],
  ['board', 'Board'],
  ['inbox', 'Inbox'],
  ['usage', 'Usage'],
  ['audit', 'Audit'],
  ['settings', 'Settings'],
] as const;

function useHash(): string {
  const [hash, setHash] = useState(window.location.hash.slice(1) || 'office');
  useEffect(() => {
    const on = () => setHash(window.location.hash.slice(1) || 'office');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

function Logo() {
  return (
    <svg className="logo" viewBox="0 0 8 8" width="20" height="20" aria-hidden="true" shapeRendering="crispEdges">
      <rect width="8" height="8" fill="var(--cth-lemon)" />
      <rect x="1" y="1" width="2" height="6" fill="var(--cth-on-accent)" />
      <rect x="5" y="1" width="2" height="6" fill="var(--cth-on-accent)" />
      <rect x="3" y="3" width="2" height="2" fill="var(--cth-on-accent)" />
    </svg>
  );
}

function ThemeToggle() {
  const theme = useAppTheme();
  return (
    <button className="top-btn" onClick={() => toggleAppTheme()} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} title="Light / dark">
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}

/** Explains how to switch to the terminal UI; both read the same hub, so nothing is lost. */
function TerminalMode({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const cmd = 'pnpm hyde tui';
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="panel modal" role="dialog" aria-modal="true" aria-labelledby="tm-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="tm-title">Switch to the terminal</h2>
        <p>The same office, in your terminal. It talks to the same hub, so tasks, questions and approvals carry over. Press <kbd>w</kbd> there to come back here.</p>
        <div className="cmd">
          <code>$ {cmd}</code>
          <button
            className="btn small"
            onClick={() => {
              void navigator.clipboard?.writeText(cmd).then(() => setCopied(true));
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="meta">Keys: 1–5 switch screens · ↑↓ pick · enter open · a approve · d deny · r reply · n new task · q quit</p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function App() {
  const hub = useHub();
  const hash = useHash();
  const [toast, setToast] = useState<string | null>(null);
  const [term, setTerm] = useState(false);
  const [page, arg] = hash.split('/');

  if (hub.needsLogin) {
    return (
      <main className="center">
        <div className="panel login">
          <Logo />
          <h1>Hyde Code</h1>
          <p>Log in by opening the link from <code>pnpm hyde dashboard</code> on the hub machine.</p>
        </div>
      </main>
    );
  }
  if (!hub.state) return <main className="center">{hub.error ? `Can't reach the hub: ${hub.error}` : 'Opening the office…'}</main>;
  const s = hub.state;
  const ctx = { state: s, refresh: hub.refresh, notify: setToast, feed: hub.feed };
  const count = inboxCount(s);
  const current = page === 'task' ? 'board' : page === 'floor' ? 'office' : page;

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#office">
          <Logo /> <span>HYDE CODE</span>
        </a>
        <nav aria-label="Main">
          {PAGES.map(([id, label]) => (
            <a key={id} href={`#${id}`} className={current === id ? 'active' : ''} aria-current={current === id ? 'page' : undefined}>
              {label}
              {id === 'inbox' && count > 0 && <span className="count">{count}</span>}
            </a>
          ))}
        </nav>
        <div className="top-right">
          <span className={`live ${hub.connected ? 'on' : ''}`}>{hub.connected ? 'LIVE' : 'RECONNECTING'}</span>
          <ThemeToggle />
          <button className="top-btn" onClick={() => setTerm(true)} title="Use Hyde Code from your terminal">
            <Icon name="terminal" /> Terminal
          </button>
        </div>
      </header>
      <main className={current === 'office' ? 'office-main' : current === 'board' && page !== 'task' ? 'wide' : ''}>
        {page === 'task' && arg ? (
          <TaskPage id={arg} {...ctx} />
        ) : current === 'inbox' ? (
          <Inbox {...ctx} />
        ) : current === 'board' ? (
          <Board {...ctx} />
        ) : current === 'usage' ? (
          <Usage {...ctx} />
        ) : current === 'audit' ? (
          <Audit {...ctx} />
        ) : current === 'settings' ? (
          <Settings {...ctx} />
        ) : (
          <Office {...ctx} />
        )}
      </main>
      {term && <TerminalMode onClose={() => setTerm(false)} />}
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
