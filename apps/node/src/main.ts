import { WorkerNode } from './index.ts';

// A teammate's worker node: `pnpm --filter @hyde/node start` on their machine, with their own
// signed-in CLIs. Settings come from the environment (.env):
//   HYDE_HUB_WS=wss://hub.tailnet:7420/api/nodes/connect
//   HYDE_NODE_ID=asha-laptop  HYDE_NODE_TOKEN=<from the hub owner>  HYDE_NODE_OWNER=asha
//   HYDE_NODE_PROJECTS=demo=/home/asha/code/demo,shop=/home/asha/code/shop
//   HYDE_NODE_DATA=/home/asha/.hyde-node

const env = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
};

const projects = Object.fromEntries(
  (process.env.HYDE_NODE_PROJECTS ?? '')
    .split(',')
    .filter(Boolean)
    .map((pair) => pair.split('=') as [string, string]),
);

const node = new WorkerNode({
  hubUrl: env('HYDE_HUB_WS'),
  nodeId: env('HYDE_NODE_ID'),
  token: env('HYDE_NODE_TOKEN'),
  owner: process.env.HYDE_NODE_OWNER ?? env('HYDE_NODE_ID'),
  projects,
  dataDir: process.env.HYDE_NODE_DATA ?? '.hyde-node',
  tsxLoader: import.meta.resolve('tsx/esm'),
});
await node.connect();
process.on('SIGINT', () => {
  node.close();
  process.exit(0);
});
