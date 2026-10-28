// What any chat gateway (Telegram, Slack, Discord, WhatsApp, the web dashboard) exchanges with the hub.

export type Command =
  | { kind: 'new'; text: string; project?: string; agent?: string }
  | { kind: 'client'; text: string; project?: string }
  | { kind: 'status' }
  | { kind: 'agents' }
  | { kind: 'usage' }
  | { kind: 'projects' }
  | { kind: 'logs'; taskId: string }
  | { kind: 'stop'; target: string | 'all' }
  | { kind: 'answer'; questionId: string; text: string }
  | { kind: 'decide'; approvalId: string; approved: boolean }
  | { kind: 'merge'; taskId: string }
  | { kind: 'promote'; project?: string }
  | { kind: 'retry'; taskId: string }
  | { kind: 'lesson'; lessonId: string; approved: boolean }
  | { kind: 'help' };

export interface Inbound {
  command: Command;
  /** Gateway-qualified user id, e.g. `tg:12345`. */
  userId: string;
  /** Which gateway it came from, so replies and later updates go back there. */
  gateway: string;
  chatId: string;
  /** Unique per delivery, so a retried update is ignored by the event store. */
  commandId: string;
}

export type ButtonAction =
  | { kind: 'answer'; questionId: string; option: number }
  | { kind: 'decide'; approvalId: string; approved: boolean }
  | { kind: 'merge'; taskId: string }
  | { kind: 'lesson'; lessonId: string; approved: boolean };

export interface OutboundMessage {
  text: string;
  buttons?: { label: string; action: ButtonAction }[][];
  /** Lets a plain-text reply to this message answer the question. */
  questionId?: string;
  /** Image files (proof of work) to attach. */
  images?: { path: string; caption?: string }[];
  /** Low-priority messages are batched into digests and held during quiet hours. */
  priority?: 'urgent' | 'normal' | 'digest';
}

export interface ChatGateway {
  readonly name: string;
  start(onInbound: (inbound: Inbound) => Promise<string | void>): Promise<void>;
  send(chatId: string, message: OutboundMessage): Promise<void>;
  stop(): Promise<void>;
}

/** The harness MCP tools agents may call through POST /api/agent/:tool. */
export const TOOLS_NAMES = ['ask_question', 'report_progress', 'complete_task', 'request_approval', 'propose_lesson'] as const;
