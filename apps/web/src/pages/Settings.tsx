import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { PageProps } from '../ui.tsx';

type Detected = Awaited<ReturnType<typeof api.detect>>[number];
type Raw = Record<string, any>;

const STAGES: [string, string, string][] = [
  ['planner', 'Plan first', 'Questions and a task graph before any code.'],
  ['review', 'Cross-vendor review', "A different vendor's agent reviews every diff."],
  ['browser', 'Browser verify', 'Open UI changes in Chromium; screenshots as proof of work.'],
  ['policy', 'Policy checks', 'Protected branches, write scope and approvals on agent tool calls.'],
];

const GATEWAYS: [string, string][] = [
  ['telegram', 'Telegram (TELEGRAM_BOT_TOKEN)'],
  ['slack', 'Slack (SLACK_BOT_TOKEN, SLACK_APP_TOKEN)'],
  ['discord', 'Discord (DISCORD_BOT_TOKEN)'],
  ['whatsapp', 'WhatsApp client intake (WHATSAPP_*)'],
];

/** Pick what to use. Nothing is compulsory: agents, stages and chat apps are all choices. */
export function Settings({ notify, refresh }: PageProps) {
  const [raw, setRaw] = useState<Raw | null>(null);
  const [detected, setDetected] = useState<Detected[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.config().then(setRaw, (e: Error) => notify(e.message));
    api.detect().then(setDetected, (e: Error) => notify(e.message));
  }, []);
  if (!raw) return <p>Loading settings…</p>;

  const agents: Raw[] = raw.agents?.length ? raw.agents : raw.agent ? [{ name: raw.agent.name ?? 'claude-1', adapter: 'claude-code', model: raw.agent.model }] : [];
  const update = (next: Raw) => setRaw({ ...next });
  const setAgent = (i: number, patch: Raw) => {
    const list = agents.map((a, j) => (j === i ? { ...a, ...patch } : a));
    const { agent: _legacy, ...rest } = raw;
    update({ ...rest, agents: list });
  };
  const addAgent = (d: Detected) => {
    const s = d.suggest!;
    let name = s.name as string;
    for (let n = 2; agents.some((a) => a.name === name); n++) name = `${(s.name as string).replace(/-\d+$/, '')}-${n}`;
    const { agent: _legacy, ...rest } = raw;
    update({ ...rest, agents: [...agents, { name, adapter: s.adapter, roles: s.roles, ...(s.command && { command: s.command }), ...(s.vendor && { vendor: s.vendor }), ...(s.model && { model: s.model }) }] });
  };
  const save = async () => {
    setSaving(true);
    try {
      await api.saveConfig(raw);
      notify('Saved. The hub reloaded its settings.');
      refresh();
    } catch (err) {
      notify(`Not saved: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="spread">
        <div>
          <h1>Settings</h1>
          <p className="sub">Pick what you use. Every agent runs under your own login on its machine; tokens stay in .env.</p>
        </div>
        <button className="btn primary" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>

      <h2>Agents</h2>
      <div className="grid">
        {agents.map((a, i) => (
          <div className="card stack" key={a.name}>
            <h3>
              {a.name}
              <label className="row" style={{ margin: 0 }}>
                <input type="checkbox" checked={a.enabled !== false} onChange={(e) => setAgent(i, { enabled: e.target.checked })} style={{ width: 'auto' }} /> enabled
              </label>
            </h3>
            <div className="meta">
              {a.adapter}
              {a.command ? ` · ${a.command.join(' ')}` : ''}
              {a.node && a.node !== 'local' ? ` · node ${a.node}` : ''}
            </div>
            <div>
              <label htmlFor={`model-${i}`}>Model (empty = CLI default)</label>
              <input id={`model-${i}`} value={a.model ?? ''} onChange={(e) => setAgent(i, { model: e.target.value || undefined })} />
            </div>
            <div>
              <label htmlFor={`roles-${i}`}>Roles (plan, implement, review, ui, bulk, triage)</label>
              <input id={`roles-${i}`} value={(a.roles ?? ['plan', 'implement', 'review', 'ui']).join(', ')} onChange={(e) => setAgent(i, { roles: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
            </div>
            <div>
              <label htmlFor={`conc-${i}`}>Runs at once on this login</label>
              <input id={`conc-${i}`} type="number" min={1} max={5} value={a.maxConcurrent ?? 1} onChange={(e) => setAgent(i, { maxConcurrent: Number(e.target.value) })} />
            </div>
          </div>
        ))}
      </div>

      <h2>Available on this machine</h2>
      {!detected ? (
        <p className="meta">Checking installed CLIs…</p>
      ) : (
        <div className="card scroll">
          <table>
            <tbody>
              {detected.map((d) => (
                <tr key={d.id}>
                  <td>
                    <strong>{d.label}</strong>
                    <div className="meta">
                      {d.version ?? ''} {d.account ?? ''}
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${d.installed && d.signedIn ? 'ok' : d.installed ? 'warn' : ''}`}>
                      {d.installed && d.signedIn ? 'ready' : d.installed ? 'not signed in' : 'not installed'}
                    </span>
                  </td>
                  <td className="meta">{d.problem ?? ''} {!d.installed || !d.signedIn ? d.howTo ?? '' : ''}</td>
                  <td>
                    {d.kind === 'agent' && d.installed && d.signedIn && (
                      <button className="btn" onClick={() => addAgent(d)}>
                        Add agent
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Stages</h2>
      <div className="grid">
        {STAGES.map(([key, title, help]) => (
          <label className="card row" key={key} style={{ alignItems: 'flex-start', color: 'var(--text)', fontSize: 15 }}>
            <input type="checkbox" style={{ width: 'auto', marginTop: 4 }} checked={Boolean(raw[key]?.enabled ?? (key === 'policy'))} onChange={(e) => update({ ...raw, [key]: { ...raw[key], enabled: e.target.checked } })} />
            <span>
              <strong>{title}</strong>
              <div className="meta">{help}</div>
            </span>
          </label>
        ))}
      </div>

      <h2>Chat apps</h2>
      <div className="grid">
        {GATEWAYS.map(([key, title]) => (
          <label className="card row" key={key} style={{ color: 'var(--text)', fontSize: 15 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={Boolean(raw.gateways?.[key] ?? key === 'telegram')} onChange={(e) => update({ ...raw, gateways: { telegram: true, ...raw.gateways, [key]: e.target.checked } })} />
            {title}
          </label>
        ))}
      </div>

      <h2>Notifications</h2>
      <div className="grid">
        <div className="card stack">
          <div>
            <label htmlFor="quiet-start">Quiet hours start (HH:MM, empty for none)</label>
            <input id="quiet-start" value={raw.notifications?.quietHours?.start ?? ''} onChange={(e) => update({ ...raw, notifications: { ...raw.notifications, quietHours: e.target.value ? { start: e.target.value, end: raw.notifications?.quietHours?.end ?? '08:00' } : undefined } })} />
          </div>
          <div>
            <label htmlFor="quiet-end">Quiet hours end</label>
            <input id="quiet-end" value={raw.notifications?.quietHours?.end ?? ''} onChange={(e) => update({ ...raw, notifications: { ...raw.notifications, quietHours: { start: raw.notifications?.quietHours?.start ?? '23:00', end: e.target.value } } })} />
          </div>
        </div>
        <div className="card stack">
          <div>
            <label htmlFor="owner-chat">Owner chat for CLI, web and scheduled tasks (e.g. telegram:12345)</label>
            <input id="owner-chat" value={raw.notifications?.ownerChat ?? ''} onChange={(e) => update({ ...raw, notifications: { ...raw.notifications, ownerChat: e.target.value || undefined } })} />
          </div>
          <div>
            <label htmlFor="ceiling">Quota soft ceiling (0–1)</label>
            <input id="ceiling" type="number" step="0.05" min={0} max={1} value={raw.quotaSoftCeiling ?? 0.8} onChange={(e) => update({ ...raw, quotaSoftCeiling: Number(e.target.value) })} />
          </div>
        </div>
      </div>
    </>
  );
}
