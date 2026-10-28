import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useHub } from './api.ts';
import { Audit } from './pages/Audit.tsx';
import { Board } from './pages/Board.tsx';
import { Floor } from './pages/Floor.tsx';
import { Inbox, inboxCount } from './pages/Inbox.tsx';
import { Office } from './pages/Office.tsx';
import { Settings } from './pages/Settings.tsx';
import { TaskPage } from './pages/TaskPage.tsx';
import { Usage } from './pages/Usage.tsx';
import { Toast } from './ui.tsx';
import './styles.css';

const PAGES = [
  ['floor', 'Floor'],
  ['inbox', 'Inbox'],
  ['board', 'Board'],
  ['usage', 'Usage'],
  ['office', 'Office'],
  ['audit', 'Audit'],
  ['settings', 'Settings'],
] as const;

function useHash(): string {
  const [hash, setHash] = useState(window.location.hash.slice(1) || 'floor');
  useEffect(() => {
    const on = () => setHash(window.location.hash.slice(1) || 'floor');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

function App() {
  const hub = useHub();
  const hash = useHash();
  const [toast, setToast] = useState<string | null>(null);
  const [page, arg] = hash.split('/');

  if (hub.needsLogin) {
    return (
      <main>
        <h1>Hyde Code</h1>
        <p className="sub">Log in by opening the link from <code>pnpm hyde dashboard</code> on the hub machine.</p>
      </main>
    );
  }
  if (!hub.state) return <main>{hub.error ? `Can't reach the hub: ${hub.error}` : 'Loading…'}</main>;
  const s = hub.state;
  const ctx = { state: s, refresh: hub.refresh, notify: setToast };
  const count = inboxCount(s);

  return (
    <div className="app">
      <nav className="nav" aria-label="Main">
        <div className="brand">
          <img src="/icon.svg" alt="" width={22} height={22} /> Hyde Code
        </div>
        {PAGES.map(([id, label]) => (
          <a key={id} href={`#${id}`} className={page === id || (page === 'task' && id === 'board') ? 'active' : ''}>
            {label}
            {id === 'inbox' && count > 0 && <span className="badge warn">{count}</span>}
          </a>
        ))}
        <div className="live">
          <span className={`dot ${hub.connected ? 'on' : ''}`} />
          {hub.connected ? 'Live' : 'Reconnecting…'}
        </div>
      </nav>
      <main>
        {page === 'task' && arg ? (
          <TaskPage id={arg} {...ctx} />
        ) : page === 'inbox' ? (
          <Inbox {...ctx} />
        ) : page === 'board' ? (
          <Board {...ctx} />
        ) : page === 'usage' ? (
          <Usage {...ctx} />
        ) : page === 'office' ? (
          <Office {...ctx} />
        ) : page === 'audit' ? (
          <Audit {...ctx} />
        ) : page === 'settings' ? (
          <Settings {...ctx} />
        ) : (
          <Floor {...ctx} />
        )}
      </main>
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
