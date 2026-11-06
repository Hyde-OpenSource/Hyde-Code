import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clientTokenFile, loadClientTokens } from './clients.ts';
import { readHubInfo, writeHubInfo } from './home.ts';
import { createApi } from './http.ts';
import { answer, doWork, makeHarness, type Harness, type Turn } from './test-helpers.ts';
import { API_VERSION, HUB_VERSION } from './version.ts';

// The client API Hyde AI uses (docs/api.md): typed tasks, answers and decisions, the summary,
// health with versions, hub.json, and the narrower client token.

let h: Harness;
let open: Harness | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const OWNER = 'owner-secret';
const CLIENT = 'client-secret';
const bigPlan = {
  questions: [],
  tasks: [
    { key: 'api', title: 'API', doneWhen: 'GET /x returns 200', writeScope: ['src/api/**'], role: 'implement', dependsOn: [], size: 'L' },
    { key: 'ui', title: 'UI', doneWhen: 'page shows the list', writeScope: ['src/ui/**'], role: 'ui', dependsOn: ['api'], size: 'L' },
  ],
};

async function api(options: { turns?: Turn[]; planner?: boolean; roles?: string[]; projectName?: string } = {}) {
  h = await makeHarness({
    agents: [{ name: 'claude-1', vendor: 'anthropic', turns: options.turns ?? [], ...(options.roles && { roles: options.roles }) }],
    config: { planner: { enabled: options.planner ?? false, approvalOver: 3 } },
  });
  open = h;
  if (options.projectName) h.config.projects[0]!.name = options.projectName;
  const app = createApi({
    orchestrator: h.o,
    store: h.store,
    config: h.config,
    pool: (h.o as unknown as { deps: { pool: never } }).deps.pool,
    host: () => h.host,
    ownerToken: OWNER,
    clientTokens: new Map([[CLIENT, 'hyde-ai']]),
    detect: async () => [],
    reload: async () => undefined,
  });
  const req = (path: string, init: RequestInit & { token?: string | null; json?: unknown } = {}) => {
    const headers = new Headers(init.headers);
    if (init.token !== null) headers.set('authorization', `Bearer ${init.token ?? OWNER}`);
    if (init.json !== undefined) headers.set('content-type', 'application/json');
    return app.request(path, { ...init, headers, ...(init.json !== undefined && { method: init.method ?? 'POST', body: JSON.stringify(init.json) }) });
  };
  return req;
}

describe('client API', () => {
  it('reports the hub and API version on health, without auth', async () => {
    const req = await api();
    expect(await (await req('/api/health', { token: null })).json()).toEqual({ ok: true, version: HUB_VERSION, apiVersion: API_VERSION });
  });

  it('creates a task and returns its id, recording the client as the source', async () => {
    const req = await api({ planner: true });
    const res = await req('/api/tasks', { token: CLIENT, json: { text: 'add a dark mode toggle', project: 'demo' } });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: 'T-1', status: 'clarifying', projectId: 'demo', title: 'add a dark mode toggle' });
    const task = h.o.state.tasks.get('T-1')!;
    expect(task.source.kind).toBe('hyde-ai');
    const created = h.store.list({ taskId: 'T-1' }).find((e) => e.type === 'task.created')!;
    expect(created.actor).toEqual({ kind: 'user', id: 'client:hyde-ai' });
    // The audit log says where it came from.
    const audit = (await (await req('/api/audit')).json()) as { type: string; source?: string }[];
    expect(audit.find((r) => r.type === 'task.created')!.source).toBe('hyde-ai');
  });

  it('lets the owner pick the source, defaults it to api, and rejects bad bodies and unknown projects', async () => {
    const req = await api();
    await req('/api/tasks', { json: { text: 'one' } });
    await req('/api/tasks', { json: { text: 'two', source: 'hyde-ai' } });
    expect(h.o.state.tasks.get('T-1')!.source.kind).toBe('api');
    expect(h.o.state.tasks.get('T-2')!.source.kind).toBe('hyde-ai');
    expect((await req('/api/tasks', { json: { project: 'demo' } })).status).toBe(400);
    expect((await req('/api/tasks', { json: { text: 'x', source: 'telegram' } })).status).toBe(400);
    const unknown = await req('/api/tasks', { json: { text: 'x', project: 'nope' } });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ code: 'project', error: expect.stringContaining('Unknown project #nope') });
    const agent = await req('/api/tasks', { json: { text: 'x', agent: 'ghost-1' } });
    expect(await agent.json()).toMatchObject({ code: 'agent' });
  });

  it('creates nothing twice for the same requestId', async () => {
    const req = await api();
    expect((await req('/api/tasks', { token: CLIENT, json: { text: 'once', requestId: 'r-1' } })).status).toBe(201);
    const again = await req('/api/tasks', { token: CLIENT, json: { text: 'once', requestId: 'r-1' } });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'duplicate' });
    expect(h.o.state.tasks.size).toBe(1);
  });

  it('matches a project by name or id, ignoring case, spaces and dashes', async () => {
    const req = await api({ projectName: 'Gamify IAS LMS' });
    h.config.projects[0]!.id = 'gamify-ias-lms';
    for (const project of ['Gamify IAS LMS', 'gamify ias lms', 'GAMIFY-IAS-LMS', 'gamifyiaslms']) {
      expect((await req('/api/tasks', { json: { text: 'x', project } })).status).toBe(201);
    }
    // Chat tags too.
    expect(await h.o.handle(h.inbound({ kind: 'new', text: 'y', project: 'Gamify_IAS_LMS' }))).toMatch(/^T-5 accepted for #gamify-ias-lms/);
  });

  it('says when a loose project name matches more than one project', async () => {
    const req = await api();
    h.config.projects.push({ ...h.config.projects[0]!, id: 'my-app', name: 'My App' }, { ...h.config.projects[0]!, id: 'myapp' });
    const res = await req('/api/tasks', { json: { text: 'x', project: 'MY APP' } });
    expect(await res.json()).toMatchObject({ code: 'project', error: expect.stringContaining('more than one project') });
  });

  it('answers questions and decides approvals through typed endpoints', async () => {
    const req = await api({ planner: true, turns: [answer({ questions: [{ text: 'Paginate?', blocking: true, options: ['yes', 'no'] }], tasks: [] }), answer(bigPlan)] });
    await req('/api/tasks', { token: CLIENT, json: { text: 'build the list' } });
    await h.until(() => h.o.state.questions.has('Q-1'), 'planner question');

    expect((await req('/api/questions/Q-9/answer', { token: CLIENT, json: { text: 'x' } })).status).toBe(404);
    expect((await req('/api/questions/Q-1/answer', { token: CLIENT, json: { option: 5 } })).status).toBe(400);
    expect((await req('/api/questions/Q-1/answer', { token: CLIENT, json: {} })).status).toBe(400);
    const answered = await req('/api/questions/q-1/answer', { token: CLIENT, json: { option: 0 } });
    expect(await answered.json()).toMatchObject({ id: 'Q-1', status: 'answered', answer: 'yes' });
    expect((await req('/api/questions/Q-1/answer', { token: CLIENT, json: { text: 'no' } })).status).toBe(409);
    expect(h.store.list({}).find((e) => e.type === 'question.answered')!.payload).toMatchObject({ by: 'client:hyde-ai' });

    await h.until(() => h.o.state.approvals.has('A-1'), 'plan approval');
    expect((await req('/api/approvals/A-1', { token: CLIENT, json: { decision: 'maybe' } })).status).toBe(400);
    const decided = await req('/api/approvals/A-1', { token: CLIENT, json: { decision: 'deny' } });
    expect(await decided.json()).toMatchObject({ id: 'A-1', status: 'denied' });
    expect((await req('/api/approvals/A-1', { token: CLIENT, json: { decision: 'approve' } })).status).toBe(409);
    expect(h.o.state.tasks.get('T-1')!.status).toBe('cancelled');
  });

  it('sums up counts, what needs the owner and quota headroom', async () => {
    const req = await api({ planner: true, turns: [answer({ questions: [{ text: 'Paginate?', blocking: true, options: ['yes', 'no'] }], tasks: [] })] });
    await req('/api/tasks', { token: CLIENT, json: { text: 'build the list' } });
    await h.until(() => h.o.state.questions.has('Q-1'), 'planner question');
    h.store.append({ type: 'quota.updated', actor: { kind: 'harness', id: 'hub' }, payload: { account: 'claude-1', window: 'five_hour', status: 'warning', utilization: 0.92, resetsAt: Math.floor(Date.now() / 1000) + 3600 } });

    const summary = (await (await req('/api/summary', { token: CLIENT })).json()) as Record<string, any>;
    expect(summary).toMatchObject({
      apiVersion: API_VERSION,
      counts: { tasks: { blocked: 1 }, active: 1, questions: 1, approvals: 0, merges: 0, needsYou: 1 },
      needsYou: [{ kind: 'question', id: 'Q-1', taskId: 'T-1', taskTitle: 'build the list', projectId: 'demo', text: 'Paginate?', options: ['yes', 'no'], blocking: true }],
      agents: [{ name: 'claude-1', adapter: 'claude-code', usable: true, utilization: 0.92, percent: 92, nearCeiling: true, resetsAt: expect.any(Number) }],
      quotaSoftCeiling: 0.8,
    });
    expect(((await (await req('/api/summary?project=DEMO', { token: CLIENT })).json()) as { counts: { active: number } }).counts.active).toBe(1);
    expect((await req('/api/summary?project=nope', { token: CLIENT })).status).toBe(404);
  });
});

describe('client API v2: complexity tiers', () => {
  it('takes a complexity hint, lets the client change the level, and reports tiers in the summary', async () => {
    const req = await api({ turns: [doWork()] });
    // The rules decide when they can ("rename" is trivial); the hint only settles unsure requests.
    const sure = (await (await req('/api/tasks', { token: CLIENT, json: { text: 'Rename hello to hi in hello.txt', complexity: 'high', requestId: 'a' } })).json()) as Record<string, any>;
    expect(sure.complexity).toMatchObject({ level: 'trivial', by: 'rules' });
    const unsure = (await (await req('/api/tasks', { token: CLIENT, json: { text: 'hmm the thing', complexity: 'low', requestId: 'b' } })).json()) as Record<string, any>;
    expect(unsure.complexity).toMatchObject({ level: 'low', by: 'client' });
    expect((await req('/api/tasks', { token: CLIENT, json: { text: 'x', complexity: 'huge' } })).status).toBe(400);

    const set = await req('/api/tasks/T-2/level', { token: CLIENT, json: { level: 'medium' } });
    expect(await set.json()).toMatchObject({ id: 'T-2', complexity: { level: 'medium', by: 'owner' } });
    expect((await req('/api/tasks/T-9/level', { token: CLIENT, json: { level: 'low' } })).status).toBe(404);
    expect((await req('/api/tasks/T-2/level', { token: CLIENT, json: { level: 'big' } })).status).toBe(400);

    await h.until(() => h.o.state.runs.size >= 1, 'a run');
    const summary = (await (await req('/api/summary', { token: CLIENT })).json()) as Record<string, any>;
    expect(summary.routing).toEqual({ mode: 'balanced', effort: 'balanced' });
    const t1 = summary.tasks.find((t: { id: string }) => t.id === 'T-1');
    // Voice requests are clarified first: the planner runs one tier up (medium for trivial work).
    expect(t1).toMatchObject({ complexity: { level: 'trivial' }, run: { agent: 'claude-1', mode: 'plan', tier: 'medium', requestedModel: 'sonnet', effort: 'medium' } });
  });

  it('lists a question once, with who else asked it', async () => {
    const ask = (question: string): Turn => async ({ runId, o }) => {
      await o.agentCall(runId, 'ask_question', { question, blocking: true });
      return [{ type: 'run.completed', summary: 'waiting' }];
    };
    const req = await api({ turns: [ask('Which database should I use for the cache?'), ask('Which database should we use for the cache?')] });
    h.config.maxConcurrentRuns = 1;
    await req('/api/tasks', { token: CLIENT, json: { text: 'Add a cache layer' } });
    await h.until(() => h.o.state.tasks.get('T-1')!.status === 'blocked', 'T-1 asks');
    await req('/api/tasks', { token: CLIENT, json: { text: 'Add cache metrics' } });
    await h.until(() => h.o.state.tasks.get('T-2')!.status === 'blocked', 'T-2 asks');
    const summary = (await (await req('/api/summary', { token: CLIENT })).json()) as Record<string, any>;
    expect(summary.needsYou).toEqual([expect.objectContaining({ kind: 'question', id: 'Q-1', alsoAskedBy: [{ by: 'claude-1', taskId: 'T-2' }] })]);
  });

  it('assistant-plans: Hyde AI requests skip the hub planner', async () => {
    const req = await api({ planner: true, turns: [doWork()] });
    h.config.routing.mode = 'assistant-plans';
    await req('/api/tasks', { token: CLIENT, json: { text: 'Add a hello file' } });
    await h.until(() => h.o.state.approvals.has('A-1'), 'done without planning');
    expect([...h.o.state.runs.values()].map((r) => r.mode)).toEqual(['start']);
  });
});

describe('client token', () => {
  it('reads state and events but never config, projects, metrics or the dashboard login', async () => {
    const req = await api();
    for (const path of ['/api/state', '/api/summary', '/api/feed', '/api/tasks/T-1/events']) expect((await req(path, { token: CLIENT })).status, path).toBe(200);
    for (const path of ['/api/config', '/api/projects', '/metrics', '/api/audit', '/api/setup/detect']) expect((await req(path, { token: CLIENT })).status, path).toBe(401);
    expect((await req('/api/config', { token: CLIENT, method: 'PUT', json: {} })).status).toBe(401);
    expect((await req('/api/projects', { token: CLIENT, json: { path: '/tmp', trust: true } })).status).toBe(401);
    expect((await req(`/login?token=${CLIENT}`, { token: null })).status).toBe(401);
    expect((await req('/api/state', { token: 'guess' })).status).toBe(401);
  });

  it('runs task commands but not promote, lessons or client intake', async () => {
    const req = await api();
    const run = async (text: string) => req('/api/commands', { token: CLIENT, json: { text } });
    expect(await (await run('/status')).json()).toEqual({ text: 'No active tasks.' });
    expect((await run('/new add a file #demo')).status).toBe(200);
    expect(h.o.state.tasks.get('T-1')!.source.kind).toBe('hyde-ai');
    for (const text of ['/stop T-1', '/retry T-1', '/merge T-1', '/answer Q-1 yes', '/approve A-1', '/deny A-1']) expect((await run(text)).status, text).toBe(200);
    for (const text of ['/promote #demo', '/approve L-1', '/client hello #demo']) expect((await run(text)).status, text).toBe(403);
  });

  it('cannot decide a promote approval', async () => {
    const req = await api({ turns: [doWork()] });
    await req('/api/tasks', { json: { text: 'x' } });
    h.store.append({ type: 'approval.requested', actor: { kind: 'harness', id: 'hub' }, taskId: 'T-1', payload: { approvalId: 'A-7', taskId: 'T-1', kind: 'promote', summary: 'Promote staging to main?' } });
    expect((await req('/api/approvals/A-7', { token: CLIENT, json: { decision: 'approve' } })).status).toBe(403);
    expect((await req('/api/commands', { token: CLIENT, json: { text: '/approve A-7' } })).status).toBe(403);
    expect(h.o.state.approvals.get('A-7')!.status).toBe('open');
  });

  it('is created once per client in the data dir, private to the owner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hyde-clients-'));
    try {
      const first = loadClientTokens(dir);
      expect([...first.values()]).toEqual(['hyde-ai']);
      expect(statSync(clientTokenFile(dir, 'hyde-ai')).mode & 0o777).toBe(0o600);
      expect([...loadClientTokens(dir).keys()]).toEqual([...first.keys()]);
      expect(readFileSync(clientTokenFile(dir, 'hyde-ai'), 'utf8')).toBe([...first.keys()][0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('voice tasks', () => {
  it('go through the planner even when it is off, if an agent can plan', async () => {
    const req = await api({ planner: false });
    expect(await (await req('/api/tasks', { token: CLIENT, json: { text: 'x' } })).json()).toMatchObject({ status: 'clarifying' });
    // Other sources follow the switch.
    expect(await (await req('/api/tasks', { json: { text: 'y' } })).json()).toMatchObject({ status: 'ready' });
  });

  it('start normally, and say so, when no agent has the plan role', async () => {
    const req = await api({ planner: false, roles: ['implement'] });
    const body = (await (await req('/api/tasks', { token: CLIENT, json: { text: 'x' } })).json()) as { status: string; text: string };
    expect(body.status).toBe('ready');
    expect(body.text).toContain('no agent with the plan role');
  });
});

describe('hub.json', () => {
  it('describes the running hub and is ignored once its process is gone', () => {
    const home = mkdtempSync(join(tmpdir(), 'hyde-home-'));
    try {
      expect(readHubInfo(home)).toBeNull();
      const info = { url: 'http://127.0.0.1:7420', pid: process.pid, version: HUB_VERSION, apiVersion: API_VERSION, dataDir: join(home, 'data'), startedAt: new Date().toISOString() };
      writeHubInfo(info, home);
      expect(readHubInfo(home)).toEqual(info);
      writeHubInfo({ ...info, pid: 2 ** 22 + 12345 }, home);
      expect(readHubInfo(home)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
