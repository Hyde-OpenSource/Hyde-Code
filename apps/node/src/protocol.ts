import type { AgentProfile, DetectResult, HarnessEvent, RunSpec } from '@hyde/core';

// Hub ↔ worker node protocol over one WebSocket the node opens to the hub (docs/plan.md
// "Reference architecture"). The hub sends tasks and file operations; the node never sends
// credentials, only which CLIs are installed and signed in.

export interface Hello {
  type: 'hello';
  nodeId: string;
  owner: string;
  host: string;
  clis: ({ kind: string } & DetectResult)[];
}

export interface RpcRequest {
  id: number;
  method: string;
  params: unknown;
}

export interface RpcResponse {
  id: number;
  result?: unknown;
  error?: string;
}

export interface RunEventMessage {
  type: 'event';
  runId: string;
  event: HarnessEvent;
}

export interface RunExitMessage {
  type: 'exit';
  runId: string;
  exit: { code: number | null; signal: string | null };
}

export type NodeToHub = Hello | RpcResponse | RunEventMessage | RunExitMessage;

export interface StartParams {
  runId: string;
  profile: AgentProfile;
  spec: RunSpec;
  /** Task packet text (the hub's packet file doesn't exist on the node). */
  packet?: string;
  resume?: string;
}

/** Repo paths cross the wire as `project:<id>`; each side maps them to its own clone. */
export const PROJECT_PREFIX = 'project:';
