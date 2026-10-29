import { useEffect, useState } from 'react';
import { openCount } from '@hyde/core/office';
import { api, scopeState, type HubState } from './api.ts';
import { Icon } from '@/components/Icon';
import { PixelButton } from '@/components/PixelButton';

// The project list, like the workspace list in other agent apps: every folder Hyde
// works in, what is running there and what waits for you. "All projects" shows everything.

const LS_KEY = 'hyde.project';

/** The selected project: ?project= from `hyde web`, else the last one picked. */
export function useProject(state: HubState | null): [string | null, (id: string | null) => void] {
  const [project, setProject] = useState<string | null>(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('project');
    if (fromUrl) return fromUrl;
    try {
      return window.localStorage.getItem(LS_KEY);
    } catch {
      return null;
    }
  });
  const set = (id: string | null) => {
    setProject(id);
    try {
      if (id) window.localStorage.setItem(LS_KEY, id);
      else window.localStorage.removeItem(LS_KEY);
    } catch {
      // storage blocked: the choice lasts until reload
    }
    const url = new URL(window.location.href);
    url.searchParams.delete('project');
    window.history.replaceState(null, '', url.toString());
  };
  // A project that was removed falls back to "all".
  useEffect(() => {
    if (state && project && !state.projects.some((p) => p.id === project)) set(null);
  }, [state?.projects, project]);
  return [project, set];
}

function shortPath(path: string): string {
  return path.replace(/^\/home\/[^/]+/, '~').replace(/^\/Users\/[^/]+/, '~');
}

export function ProjectsSidebar({ state, project, onPick, notify, refresh }: { state: HubState; project: string | null; onPick: (id: string | null) => void; notify: (t: string) => void; refresh: () => void }) {
  const [adding, setAdding] = useState(false);
  const active = (s: HubState) => s.tasks.filter((t) => ['running', 'verifying', 'review', 'clarifying'].includes(t.status)).length;
  const waiting = (s: HubState) => openCount(s) + s.tasks.filter((t) => t.status === 'awaiting_merge' && t.prUrl && !t.children.length).length;
  return (
    <aside className="projects" aria-label="Projects">
      <div className="projects-head">
        <span>PROJECTS</span>
        <button className="md-x" title="Add a project" aria-label="Add a project" onClick={() => setAdding(true)}>
          <Icon name="plus" />
        </button>
      </div>
      <button className={`project ${project === null ? 'on' : ''}`} onClick={() => onPick(null)}>
        <span className="project-name">All projects</span>
        <span className="project-meta">
          {state.projects.length} folders · {active(state)} running
        </span>
        {waiting(state) > 0 && <span className="md-count">{waiting(state)}</span>}
      </button>
      {state.projects.map((p) => {
        const s = scopeState(state, p.id);
        const w = waiting(s);
        const a = active(s);
        return (
          <button key={p.id} className={`project ${project === p.id ? 'on' : ''}`} onClick={() => onPick(p.id)} title={p.path}>
            <span className="project-name">
              <Icon name="folder" /> {p.name}
            </span>
            <span className="project-meta">{shortPath(p.path)}</span>
            <span className="project-meta">
              #{p.id} · {p.baseBranch}
              {a ? ` · ${a} running` : ''}
            </span>
            {w > 0 && <span className="md-count">{w}</span>}
          </button>
        );
      })}
      <div className="projects-foot">
        Open a terminal in a folder and run <code>hyde</code>, or <button className="linklike" onClick={() => setAdding(true)}>add one here</button>.
      </div>
      {adding && (
        <AddProject
          onClose={() => setAdding(false)}
          onAdded={(id, added) => {
            setAdding(false);
            notify(added ? `Added #${id}.` : `#${id} was already here.`);
            onPick(id);
            refresh();
          }}
        />
      )}
      {project && <RemoveProject state={state} id={project} onRemoved={() => { onPick(null); refresh(); }} notify={notify} />}
    </aside>
  );
}

function RemoveProject({ state, id, onRemoved, notify }: { state: HubState; id: string; onRemoved: () => void; notify: (t: string) => void }) {
  const [confirm, setConfirm] = useState(false);
  if (state.projects.length < 2) return null;
  return (
    <div className="projects-remove">
      {confirm ? (
        <>
          <span>Remove #{id} from Hyde? Its history stays.</span>
          <span className="md-row">
            <PixelButton
              variant="destructive"
              size="sm"
              onClick={async () => {
                try {
                  await api.removeProject(id);
                  notify(`Removed #${id}.`);
                  onRemoved();
                } catch (err) {
                  notify(`Failed: ${(err as Error).message}`);
                }
              }}
            >
              remove
            </PixelButton>
            <PixelButton variant="ghost" size="sm" onClick={() => setConfirm(false)}>
              keep
            </PixelButton>
          </span>
        </>
      ) : (
        <button className="linklike" onClick={() => setConfirm(true)}>
          Remove #{id}…
        </button>
      )}
    </div>
  );
}

/** Add a folder: the same trust question and terms as `hyde` in a terminal. */
function AddProject({ onClose, onAdded }: { onClose: () => void; onAdded: (id: string, added: boolean) => void }) {
  const [path, setPath] = useState('');
  const [trust, setTrust] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [terms, setTerms] = useState<{ version: string; url: string } | null>(null);
  useEffect(() => {
    api.projectList().then((r) => setTerms(r.terms), () => undefined);
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.addProject(path.trim());
      onAdded(r.project.id, r.added);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-back" onClick={onClose}>
      <form
        className="modal stack"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (trust && path.trim()) void submit();
        }}
      >
        <h2 id="add-title">ADD A PROJECT</h2>
        <div>
          <label htmlFor="add-path">Full path of the folder (a git repository)</label>
          <input id="add-path" autoFocus placeholder="/home/you/code/my-app" value={path} onChange={(e) => setPath(e.target.value)} />
        </div>
        <div className="trust">
          <strong>Do you trust the files in this folder?</strong>
          <p>
            Hyde Code lets AI agents (Claude Code, Codex, OpenCode and others, under your own logins) read and change files there, run commands, and push branches you approve. Only add folders you trust.
          </p>
          <label className="md-check trust-check">
            <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />I trust this folder and accept the{' '}
            <a href={terms?.url ?? 'https://github.com/Hyde-OpenSource/Hyde-Code/blob/main/TERMS.md'} target="_blank" rel="noreferrer">
              Hyde Code Terms
            </a>
            {terms ? ` (version ${terms.version})` : ''}
          </label>
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <PixelButton variant="ghost" onClick={onClose}>
            cancel
          </PixelButton>
          <PixelButton variant="primary" disabled={!trust || !path.trim() || busy} onClick={() => void submit()}>
            {busy ? 'adding…' : 'add project'}
          </PixelButton>
        </div>
      </form>
    </div>
  );
}

/** Phone-width stand-in for the sidebar. */
export function ProjectSelect({ state, project, onPick }: { state: HubState; project: string | null; onPick: (id: string | null) => void }) {
  return (
    <select className="project-select" aria-label="Project" value={project ?? ''} onChange={(e) => onPick(e.target.value || null)}>
      <option value="">All projects</option>
      {state.projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}
