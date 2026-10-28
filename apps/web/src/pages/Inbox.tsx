import { useState } from 'react';
import { ago, api, type HubState } from '../api.ts';
import { CommandButton, type PageProps } from '../ui.tsx';

/** Open items whose task is still in play (cancelled and finished tasks need nobody). */
export function openItems(s: HubState) {
  const live = (taskId: string) => !['done', 'cancelled'].includes(s.tasks.find((t) => t.id === taskId)?.status ?? 'done');
  return {
    questions: s.questions.filter((q) => q.status === 'open' && live(q.taskId)),
    approvals: s.approvals.filter((a) => a.status === 'open' && live(a.taskId)),
    lessons: s.lessons.filter((l) => l.status === 'proposed'),
  };
}

export function inboxCount(s: HubState): number {
  const o = openItems(s);
  return o.questions.length + o.approvals.length + o.lessons.length;
}

function Answer({ id, options, refresh, notify }: { id: string; options: string[] } & Pick<PageProps, 'refresh' | 'notify'>) {
  const [text, setText] = useState('');
  const send = async (answer: string) => {
    try {
      notify((await api.command({ kind: 'answer', questionId: id, text: answer })).text);
      setText('');
      refresh();
    } catch (err) {
      notify(`Failed: ${(err as Error).message}`);
    }
  };
  return (
    <div className="stack">
      {options.length > 0 && (
        <div className="row">
          {options.map((o, i) => (
            <button key={o} className="btn" onClick={() => void send(`#option:${i}`)}>
              {o}
            </button>
          ))}
        </div>
      )}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) void send(text.trim());
        }}
      >
        <input aria-label={`Answer ${id}`} placeholder="Type an answer…" value={text} onChange={(e) => setText(e.target.value)} style={{ flex: 1 }} />
        <button className="btn primary" disabled={!text.trim()}>
          Send answer
        </button>
      </form>
    </div>
  );
}

/** Everything that needs the owner, most urgent first; the same items appear in chat. */
export function Inbox({ state, refresh, notify }: PageProps) {
  const { questions, approvals, lessons } = openItems(state);
  const incidents = [...state.incidents].reverse().slice(0, 10);
  const merges = state.tasks.filter((t) => t.status === 'awaiting_merge' && t.prUrl && !t.children.length);
  const task = (id: string) => state.tasks.find((t) => t.id === id);

  return (
    <>
      <h1>Inbox</h1>
      <p className="sub">Questions, approvals and incidents. Answer here or in chat.</p>
      {!questions.length && !approvals.length && !lessons.length && !merges.length && <div className="empty">Nothing is waiting for you.</div>}

      {approvals.map((a) => (
        <div className="card stack" key={a.id} style={{ marginBottom: 12 }}>
          <div className="spread">
            <strong>
              {a.id} · {a.kind.replace('-', ' ')}
            </strong>
            <span className="meta">
              <a href={`#task/${a.taskId}`}>{a.taskId}</a> · {ago(a.requestedTs)}
            </span>
          </div>
          <div>{a.summary}</div>
          {typeof a.data?.command === 'string' && <div className="mono">$ {a.data.command}</div>}
          {typeof a.data?.url === 'string' && <a href={a.data.url}>{a.data.url}</a>}
          <div className="row">
            <CommandButton command={{ kind: 'decide', approvalId: a.id, approved: true }} label="Approve" kind="primary" refresh={refresh} notify={notify} />
            <CommandButton command={{ kind: 'decide', approvalId: a.id, approved: false }} label="Deny" refresh={refresh} notify={notify} />
          </div>
        </div>
      ))}

      {questions.map((q) => (
        <div className="card stack" key={q.id} style={{ marginBottom: 12 }}>
          <div className="spread">
            <strong>
              {q.id} {q.blocking ? '' : '(not blocking)'}
            </strong>
            <span className="meta">
              <a href={`#task/${q.taskId}`}>{q.taskId}</a> {task(q.taskId)?.title} · {ago(q.askedTs)}
            </span>
          </div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{q.text}</div>
          <Answer id={q.id} options={q.options} refresh={refresh} notify={notify} />
        </div>
      ))}

      {merges.map((t) => (
        <div className="card spread" key={t.id} style={{ marginBottom: 12 }}>
          <div>
            <strong>{t.id}</strong> ready to merge: <a href={`#task/${t.id}`}>{t.title}</a>
            <div className="meta">
              <a href={t.prUrl}>{t.prUrl}</a>
            </div>
          </div>
          <CommandButton command={{ kind: 'merge', taskId: t.id }} label={`Merge into ${t.baseBranch}`} kind="primary" refresh={refresh} notify={notify} />
        </div>
      ))}

      {lessons.map((l) => (
        <div className="card spread" key={l.id} style={{ marginBottom: 12 }}>
          <div>
            <strong>{l.id}</strong> lesson from {l.by}: {l.text}
          </div>
          <div className="row">
            <CommandButton command={{ kind: 'lesson', lessonId: l.id, approved: true }} label="Keep it" kind="primary" refresh={refresh} notify={notify} />
            <CommandButton command={{ kind: 'lesson', lessonId: l.id, approved: false }} label="Discard" refresh={refresh} notify={notify} />
          </div>
        </div>
      ))}

      {incidents.length > 0 && (
        <>
          <h2>Recent incidents</h2>
          <div className="card scroll">
            <table>
              <tbody>
                {incidents.map((i) => (
                  <tr key={i.id}>
                    <td className="mono">{i.id}</td>
                    <td>
                      {i.about}
                      <div className="meta" style={{ whiteSpace: 'pre-wrap' }}>{i.evidence.slice(0, 300)}</div>
                    </td>
                    <td className="meta">{i.taskId && <a href={`#task/${i.taskId}`}>{i.taskId}</a>}</td>
                    <td className="meta">{ago(i.ts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
