import { useEffect, useState } from 'react';
import { api, type SkillsInfo } from '../api.ts';
import { CommandButton, type PageProps } from '../ui.tsx';

const SOURCE: Record<string, string> = { builtin: 'built in', user: 'yours (~/.hyde/skills)', project: 'project (.hyde/skills)', folder: 'linked folder' };

/** Skills: SKILL.md folders every agent CLI can load. List, enable, read, link folders, approve proposals. */
export function Skills({ notify, refresh, state }: PageProps) {
  const [info, setInfo] = useState<SkillsInfo | null>(null);
  const [open, setOpen] = useState<{ name: string; text: string; files: string[] } | null>(null);
  const [folder, setFolder] = useState('');
  const load = () => api.skills().then(setInfo, (e: Error) => notify(e.message));
  useEffect(() => void load(), [state.lastSeq]);
  if (!info) return <p>Loading skills…</p>;

  const saveSkills = async (patch: { disabled?: string[]; folders?: string[] }) => {
    try {
      const raw = await api.config();
      await api.saveConfig({ ...raw, skills: { disabled: info.disabled, folders: info.folders, ...raw.skills, ...patch } });
      notify('Saved. Agents get the change from their next run.');
      refresh();
      void load();
    } catch (err) {
      notify(`Not saved: ${(err as Error).message}`);
    }
  };
  const proposals = info.proposals.filter((p) => p.status === 'proposed');

  return (
    <>
      <h1>Skills</h1>
      <p className="sub">
        Folders with a SKILL.md that Claude Code, Codex and OpenCode load when the description fits. Hyde copies the skills a task needs into its worktree for each run (
        {Object.entries(info.clis)
          .map(([cli, dir]) => `${cli}: ${dir}`)
          .join(', ')}
        ). Your own skill folders are never changed.
      </p>

      {proposals.length > 0 && (
        <>
          <h2>Proposed by agents</h2>
          {proposals.map((p) => (
            <div className="card stack item" key={p.id}>
              <div className="spread">
                <strong>
                  {p.id}: {p.name}
                </strong>
                <span className="meta">
                  by {p.by}
                  {p.taskId ? ` on ${p.taskId}` : ''}
                </span>
              </div>
              <div className="meta">{p.description}</div>
              <pre className="diff skill-text">{p.body}</pre>
              <div className="row">
                <CommandButton command={{ kind: 'skill', skillId: p.id, approved: true }} label="Save skill" kind="primary" refresh={() => void load()} notify={notify} />
                <CommandButton command={{ kind: 'skill', skillId: p.id, approved: false }} label="Discard" refresh={() => void load()} notify={notify} />
              </div>
            </div>
          ))}
        </>
      )}

      <h2>Installed</h2>
      {info.skills.length === 0 ? (
        <div className="empty">No skills yet.</div>
      ) : (
        <div className="grid">
          {info.skills.map((s) => (
            <div className="card stack" key={s.name}>
              <div className="spread">
                <strong className="mono">{s.name}</strong>
                <label className="row" style={{ margin: 0 }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={s.enabled}
                    onChange={(e) => void saveSkills({ disabled: e.target.checked ? info.disabled.filter((n) => n !== s.name) : [...info.disabled, s.name] })}
                  />{' '}
                  enabled
                </label>
              </div>
              <div>{s.description}</div>
              <div className="meta">
                {SOURCE[s.source] ?? s.source} · {s.files.length} file{s.files.length === 1 ? '' : 's'} · #{s.projects.join(', #')}
              </div>
              <div>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    open?.name === s.name ? setOpen(null) : api.skill(s.name).then((x) => setOpen({ name: x.name, text: x.text, files: x.files }), (e: Error) => notify(e.message))
                  }
                >
                  {open?.name === s.name ? 'Hide SKILL.md' : 'View SKILL.md'}
                </button>
              </div>
              {open?.name === s.name && <pre className="diff skill-text">{open.text}</pre>}
            </div>
          ))}
        </div>
      )}

      <h2>Linked folders</h2>
      <div className="card stack">
        <div className="meta">A folder whose sub-folders each hold a SKILL.md, for example the skills/ folder of a devflow-skills clone. Project skills win over linked ones, which win over yours and the built-in ones.</div>
        {info.folders.map((f) => (
          <div className="spread" key={f}>
            <span className="mono">{f}</span>
            <button type="button" className="btn" onClick={() => void saveSkills({ folders: info.folders.filter((x) => x !== f) })}>
              Unlink
            </button>
          </div>
        ))}
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (folder.trim()) void saveSkills({ folders: [...info.folders, folder.trim()] }).then(() => setFolder(''));
          }}
        >
          <input aria-label="Folder to link" placeholder="/absolute/path/to/skills" value={folder} onChange={(e) => setFolder(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
          <button type="submit" className="btn">
            Link folder
          </button>
        </form>
      </div>
    </>
  );
}
