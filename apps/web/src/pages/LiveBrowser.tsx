import { useEffect, useMemo, useRef, useState } from 'react';
import { CommandButton, type PageProps } from '../ui.tsx';

// Live view of the agent's browser (docs/roadmap-v2.md section 3). Frames come over SSE and are
// never stored; the overlay (cursor, ripple, box, caption) is drawn here, not burned into frames.

interface Step {
  step: number;
  op: string;
  label: string;
  url: string;
  ok: boolean;
  text?: string;
  box?: { x: number; y: number; width: number; height: number };
  x?: number;
  y?: number;
  viewport: { width: number; height: number };
  artifactId?: string;
}

async function control(taskId: string, body: unknown): Promise<{ paused: boolean }> {
  const res = await fetch(`/api/tasks/${taskId}/live`, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function LiveBrowser({ taskId, steps, running, refresh, notify }: { taskId: string; steps: Step[]; running: boolean } & Pick<PageProps, 'refresh' | 'notify'>) {
  const [frame, setFrame] = useState<{ src: string; width: number; height: number; url: string } | null>(null);
  const [live, setLive] = useState<Step[]>([]);
  const [paused, setPaused] = useState(false);
  const [preview, setPreview] = useState<string | undefined>();
  const [takeOver, setTakeOver] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const img = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const es = new EventSource(`/api/tasks/${taskId}/live`);
    es.addEventListener('frame', (e) => {
      const m = JSON.parse((e as MessageEvent).data);
      setFrame({ src: `data:image/jpeg;base64,${m.jpeg}`, width: m.width, height: m.height, url: m.url });
    });
    es.addEventListener('action', (e) => setLive((l) => [...l.filter((s) => s.step !== JSON.parse((e as MessageEvent).data).step), JSON.parse((e as MessageEvent).data)]));
    es.addEventListener('state', (e) => {
      const m = JSON.parse((e as MessageEvent).data);
      setPaused(m.paused);
      if (m.previewUrl) setPreview(m.previewUrl);
    });
    return () => es.close();
  }, [taskId]);

  const all = useMemo(() => {
    const byStep = new Map<number, Step>();
    for (const s of [...steps, ...live]) byStep.set(s.step, s);
    return [...byStep.values()].sort((a, b) => a.step - b.step);
  }, [steps, live]);
  const shown = picked !== null ? all.find((s) => s.step === picked) : all.at(-1);
  if (!all.length && !frame) return null;

  const vp = shown?.viewport ?? { width: frame?.width || 1280, height: frame?.height || 800 };
  const pct = (v: number, of: number) => `${Math.max(0, Math.min(100, (v / (of || 1)) * 100))}%`;
  const image = picked !== null && shown?.artifactId ? `/api/artifacts/${shown.artifactId}` : (frame?.src ?? (shown?.artifactId ? `/api/artifacts/${shown.artifactId}` : undefined));

  const onClick = async (e: React.MouseEvent<HTMLDivElement>) => {
    if (!takeOver || !img.current) return;
    const r = img.current.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * vp.width;
    const y = ((e.clientY - r.top) / r.height) * vp.height;
    try {
      await control(taskId, { action: 'click', x, y });
      notify(`Clicked at ${Math.round(x)}, ${Math.round(y)}; the agent is told before its next step.`);
    } catch (err) {
      notify(`Failed: ${(err as Error).message}`);
    }
  };

  return (
    <div className="card stack live-browser">
      <div className="spread">
        <strong>Live browser {picked !== null ? `(step ${picked})` : running ? '' : '(last step)'}</strong>
        <div className="row">
          {preview && (
            <a className="btn" href={preview} target="_blank" rel="noreferrer">
              Preview
            </a>
          )}
          <button
            type="button"
            className="btn"
            onClick={() => control(taskId, { action: paused ? 'resume' : 'pause' }).then((r) => setPaused(r.paused), (err: Error) => notify(err.message))}
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button type="button" className={`btn ${takeOver ? 'primary' : ''}`} aria-pressed={takeOver} onClick={() => setTakeOver(!takeOver)}>
            {takeOver ? 'Taking over: click the page' : 'Take over'}
          </button>
          {running && <CommandButton command={{ kind: 'stop', target: taskId }} label="Stop" kind="danger" refresh={refresh} notify={notify} />}
        </div>
      </div>
      <div className="live-url mono">{frame?.url ?? shown?.url}</div>
      <div className={`live-stage ${takeOver ? 'taking-over' : ''}`} onClick={onClick} style={{ aspectRatio: `${vp.width} / ${vp.height}` }}>
        {image && <img ref={img} src={image} alt={`Agent browser: ${shown?.label ?? 'live view'}`} />}
        {shown?.box && <div className="live-box" style={{ left: pct(shown.box.x, vp.width), top: pct(shown.box.y, vp.height), width: pct(shown.box.width, vp.width), height: pct(shown.box.height, vp.height) }} />}
        {shown?.x !== undefined && shown.y !== undefined && (
          <>
            <div key={`r${shown.step}`} className="live-ripple" style={{ left: pct(shown.x, vp.width), top: pct(shown.y, vp.height) }} />
            <svg className="live-cursor" viewBox="0 0 16 24" style={{ left: pct(shown.x, vp.width), top: pct(shown.y, vp.height) }} aria-hidden="true">
              <path d="M1 1 L1 19 L5.5 14.5 L9 22 L12 20.5 L8.5 13.5 L15 13.5 Z" />
            </svg>
          </>
        )}
        {shown && (
          <div className="live-caption">
            {shown.step}. {shown.label}
            {shown.text ? `: “${shown.text}”` : ''}
            {shown.ok ? '' : ' (failed)'}
          </div>
        )}
        {paused && <div className="live-paused">Paused</div>}
      </div>
      <ol className="live-steps" aria-label="Browser steps">
        {all.map((s) => (
          <li key={s.step}>
            <button type="button" className={`live-step ${shown?.step === s.step ? 'on' : ''} ${s.ok ? '' : 'bad'}`} onClick={() => setPicked(picked === s.step ? null : s.step)}>
              {s.artifactId && <img src={`/api/artifacts/${s.artifactId}`} alt="" loading="lazy" />}
              <span>
                {s.step}. {s.label}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
