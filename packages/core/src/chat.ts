// What any chat gateway (Telegram first; Slack and Discord later) exchanges with the hub.

export type Command =
  | { kind: 'new'; text: string; project?: string }
  | { kind: 'status' }
  | { kind: 'projects' }
  | { kind: 'stop'; target: string | 'all' }
  | { kind: 'answer'; questionId: string; text: string }
  | { kind: 'decide'; approvalId: string; approved: boolean }
  | { kind: 'help' };

export interface Inbound {
  command: Command;
  /** Gateway-qualified user id, e.g. `tg:12345`. */
  userId: string;
  chatId: string;
  /** Unique per delivery, so a retried update is ignored by the event store. */
  commandId: string;
}

export type ButtonAction =
  | { kind: 'answer'; questionId: string; option: number }
  | { kind: 'decide'; approvalId: string; approved: boolean };

export interface OutboundMessage {
  text: string;
  buttons?: { label: string; action: ButtonAction }[][];
  /** Lets a plain-text reply to this message answer the question. */
  questionId?: string;
}

export interface ChatGateway {
  readonly name: string;
  start(onInbound: (inbound: Inbound) => Promise<string | void>): Promise<void>;
  send(chatId: string, message: OutboundMessage): Promise<void>;
  stop(): Promise<void>;
}
