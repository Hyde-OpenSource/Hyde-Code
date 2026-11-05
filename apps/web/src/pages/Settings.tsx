import { useEffect, useState } from 'react';
import { BUILTIN_TIERS, EFFORT_LEVELS, HYDE_EFFORTS, ROUTING_MODES } from '@hyde/core/routing';
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

const MODE_HELP: Record<string, string> = {
  balanced: 'A strong model plans and reviews; code goes to the tier its complexity needs.',
  'claude-only': 'Claude models only, by complexity (opus, sonnet, haiku).',
  'free-first': 'Free models for trivial and low work, Claude for everything else.',
  'assistant-plans': 'The Hyde AI desktop assistant plans its own requests; the CLIs code.',
};
const EFFORT_HELP: Record<string, string> = {
  saver: 'Every tier thinks one step less (saves quota).',
  balanced: 'Each tier uses its own effort.',
  max: 'Every tier thinks one step more.',
  auto: 'Balanced, but saver for a login above 60% of its 5-hour window.',
};
const TIER_LEVELS = ['high', 'medium', 'low', 'trivial'] as const;

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
              <label htmlFor={`model-${i}`}>Model for every tier when no tiers are set (empty = CLI default)</label>
              <input id={`model-${i}`} value={a.model ?? ''} onChange={(e) => setAgent(i, { model: e.target.value || undefined })} />
            </div>
            <fieldset className="tiers">
              <legend>Model and effort by complexity{BUILTIN_TIERS[a.adapter] && !a.tiers ? ' (built-in)' : ''}</legend>
              {TIER_LEVELS.map((level) => {
                const own = a.tiers?.[level] ?? {};
                const builtin = BUILTIN_TIERS[a.adapter]?.[level];
                const setTier = (patch: Raw) => {
                  const next = { ...own, ...patch };
                  for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === '') delete next[k];
                  const tiers = { ...a.tiers, [level]: next };
                  if (!Object.keys(next).length) delete tiers[level];
                  setAgent(i, { tiers: Object.keys(tiers).length ? tiers : undefined });
                };
                return (
                  <div className="tier-row" key={level}>
                    <span className="tier-name">{level}</span>
                    <input aria-label={`${a.name} ${level} model`} placeholder={builtin?.model ?? a.model ?? 'CLI default'} value={own.model ?? ''} onChange={(e) => setTier({ model: e.target.value || undefined })} />
                    <select aria-label={`${a.name} ${level} effort`} value={own.effort ?? ''} onChange={(e) => setTier({ effort: e.target.value || undefined })}>
                      <option value="">{builtin?.effort ? `${builtin.effort} (built-in)` : 'effort: default'}</option>
                      {EFFORT_LEVELS.map((x) => (
                        <option key={x} value={x}>
                          {x}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </fieldset>
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

      <h2>Models and effort</h2>
      <div className="grid">
        <div className="card stack">
          <div>
            <label htmlFor="routing-mode">Mode</label>
            <select id="routing-mode" value={raw.routing?.mode ?? 'balanced'} onChange={(e) => update({ ...raw, routing: { ...raw.routing, mode: e.target.value } })}>
              {ROUTING_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <div className="meta">{MODE_HELP[raw.routing?.mode ?? 'balanced']}</div>
          </div>
          <div>
            <label htmlFor="routing-effort">Hyde effort</label>
            <select id="routing-effort" value={raw.routing?.effort ?? 'balanced'} onChange={(e) => update({ ...raw, routing: { ...raw.routing, effort: e.target.value } })}>
              {HYDE_EFFORTS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <div className="meta">{EFFORT_HELP[raw.routing?.effort ?? 'balanced']}</div>
          </div>
        </div>
        <div className="card stack">
          <label className="row" style={{ color: 'var(--text)', fontSize: 15 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={raw.routing?.classifier !== false} onChange={(e) => update({ ...raw, routing: { ...raw.routing, classifier: e.target.checked } })} />
            Ask a cheap model when the rules can't tell a task's complexity
          </label>
          <div>
            <label htmlFor="max-questions">Most questions per plan (the rest become assumptions)</label>
            <input id="max-questions" type="number" min={0} max={10} value={raw.planner?.maxQuestions ?? 3} onChange={(e) => update({ ...raw, planner: { ...raw.planner, maxQuestions: Number(e.target.value) } })} />
          </div>
          <div className="meta">Planning, review and high-complexity code never run on a free model. A task whose tier is out of quota waits instead of moving to a weaker model.</div>
        </div>
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
