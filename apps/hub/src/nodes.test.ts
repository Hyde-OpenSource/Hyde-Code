import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { WorkerNode } from '@hyde/node';
import { git } from '@hyde/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeHub } from './nodes.ts';
import { doWork, makeHarness, ScriptedAdapter, TestHost, type Harness } from './test-helpers.ts';

let h: Harness;
let server: Server | undefined;
let node: WorkerNode | undefined;
afterEach(async () => {
  node?.close();
  server?.close();
  await h?.close();
});

describe('worker nodes (Phase 3 gate: a teammate runs on their own logins)', () => {
  it('refuses unknown nodes and runs a task end to end on a connected node', async () => {
    h = await makeHarness({ agents: [{ name: 'local-1', vendor: 'anthropic', turns: [] }] });
    // The teammate's agent lives on node "asha"; the hub only knows its profile.
    h.config.agents.push({ name: 'asha-claude', adapter: 'claude-code', enabled: true, roles: ['implement'], maxConcurrent: 1, account: 'asha', node: 'asha', isolation: 'worktree' });
    h.config.agents[0]!.enabled = false;
    const hub = new NodeHub(h.config, h.store, NodeHub.parseTokens('asha:tok-123'), () => {});
    expect(hub.authenticate('Bearer asha:tok-123')).toBe('asha');
    expect(hub.authenticate('Bearer asha:wrong')).toBeNull();
    expect(hub.authenticate('Bearer bob:tok-123')).toBeNull();

    server = createServer();
    hub.attach(server);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;

    // Wire the remote adapter and host into the harness's pool and orchestrator.
    const deps = (h.o as unknown as { deps: { pool: { adapter: (n: string) => unknown; usable: (n: string) => boolean }; host: (n: string) => unknown } }).deps;
    const origAdapter = deps.pool.adapter.bind(deps.pool);
    deps.pool.adapter = (name: string) => (name === 'asha-claude' ? hub.adapter(h.config.agents.find((a) => a.name === name)!) : origAdapter(name));
    const localHost = h.host;
    deps.host = (n: string) => (n === 'asha' ? hub.host('asha') : localHost);

    const remoteAgent = new ScriptedAdapter('anthropic', [doWork()]);
    remoteAgent.orchestrator = h.o;
    const nodeData = join(h.root, 'asha-data');
    node = new WorkerNode({
      hubUrl: `ws://127.0.0.1:${port}/api/nodes/connect`,
      nodeId: 'asha',
      token: 'tok-123',
      owner: 'asha',
      projects: { demo: h.repo }, // same machine in the test; a real node has its own clone
      dataDir: nodeData,
      tsxLoader: 'file:///tsx.mjs',
      adapters: () => remoteAgent,
      host: new TestHost(), // no GitHub in tests
      log: () => {},
    });
    await node.connect();
    await h.until(() => h.o.state.nodes.get('asha')?.online === true, 'node hello');
    expect(h.o.state.nodes.get('asha')!.owner).toBe('asha');

    await h.o.handle(h.inbound({ kind: 'new', text: 'Add a hello file' }));
    await h.until(() => h.o.state.approvals.has('A-1'), 'remote run verified');
    const task = h.o.state.tasks.get('T-1')!;
    expect(task.agent).toBe('asha-claude');
    expect(task.node).toBe('asha');
    expect(task.worktree).toBe(join(nodeData, 'worktrees', 'T-1'));
    // The node rewrote run paths to its own machine and kept the hub token for the MCP server.
    const spec = remoteAgent.calls[0]!.spec;
    expect(spec.runDir).toBe(join(nodeData, 'runs', 'run-1'));
    expect(spec.packetFile).toBe(join(nodeData, 'runs', 'run-1', 'packet.md'));
    expect(spec.mcp!.env.HYDE_RUN_TOKEN).toBeTruthy();
    expect(task.checks).toMatchObject({ ok: true });
    expect(await git(task.worktree!, ['log', '-1', '--format=%s'])).toBe('T-1: progress.md entry');

    await h.o.handle(h.inbound({ kind: 'decide', approvalId: 'A-1', approved: true }));
    await h.until(() => h.o.state.tasks.get('T-1')!.status === 'awaiting_merge', 'PR from node');
    expect(await git(h.remote, ['branch', '--list'])).toContain(task.branch!);
    expect(task.prUrl).toBe('https://github.test/pr/1');
    expect(h.o.state.incidents.size).toBe(0);

    node.close();
    await h.until(() => h.o.state.nodes.get('asha')?.online === false, 'disconnect');
  });
});
