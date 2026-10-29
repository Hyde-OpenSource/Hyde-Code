import { QuotaBar, type PageProps } from '../ui.tsx';

/** Quota per account and window, plus per-agent metrics (Paperclip-style budgets). */
export function Usage({ state }: PageProps) {
  const accounts = [...new Set(state.agents.map((a) => a.account))];
  return (
    <>
      <h1>Usage</h1>
      <p className="sub">Subscription windows reported by each CLI. New runs on an account wait above its soft ceiling.</p>
      <div className="grid">
        {accounts.map((account) => {
          const quotas = state.quotas.filter((q) => q.account === account);
          const agents = state.agents.filter((a) => a.account === account).map((a) => a.name);
          return (
            <div className="card stack" key={account}>
              <h3>
                {account} <span className="meta">{agents.join(', ')}</span>
              </h3>
              {quotas.length === 0 && <div className="meta">No quota data yet (reported during runs).</div>}
              {quotas.map((q) => (
                <div key={q.window}>
                  <div className="spread meta">
                    <span>{q.window.replace('_', ' ')}</span>
                    <span>
                      {q.utilization !== undefined ? `${Math.round(q.utilization * 100)}%` : q.status}
                      {q.resetsAt ? ` · resets ${new Date(q.resetsAt * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}
                    </span>
                  </div>
                  <QuotaBar value={q.utilization ?? (q.status === 'rejected' ? 1 : 0)} />
                </div>
              ))}
            </div>
          );
        })}
      </div>

      <h2>Agents</h2>
      <div className="card scroll">
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Runs</th>
              <th>Success</th>
              <th>Avg run</th>
              <th>Tasks merged</th>
              <th>Tokens in / out</th>
              <th>List-price cost</th>
            </tr>
          </thead>
          <tbody>
            {state.metrics.map((m) => (
              <tr key={m.agent}>
                <td>{m.agent}</td>
                <td>
                  {m.runs}
                  {m.running ? ` (${m.running} running)` : ''}
                </td>
                <td>{Math.round(m.successRate * 100)}%</td>
                <td>{m.avgMinutes.toFixed(1)} min</td>
                <td>{m.tasksDone}</td>
                <td className="meta">
                  {m.inputTokens.toLocaleString()} / {m.outputTokens.toLocaleString()}
                </td>
                <td className="meta">${m.costUsd.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {state.metrics.length === 0 && <div className="empty">No runs yet.</div>}
      </div>
      <p className="meta">Costs are what the CLIs report at list price; on a subscription you pay the plan, not this. Prometheus metrics: /metrics.</p>
    </>
  );
}
