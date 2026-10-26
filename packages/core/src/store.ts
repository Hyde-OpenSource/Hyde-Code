import { DatabaseSync } from 'node:sqlite';
import { parsePayload, type Actor, type EventPayloadInput, type EventType, type HarnessEventRecord } from './events.ts';

export interface AppendInput<T extends EventType> {
  type: T;
  actor: Actor;
  payload: EventPayloadInput<T>;
  projectId?: string;
  taskId?: string;
  runId?: string;
  commandId?: string;
}

type Row = {
  seq: number;
  ts: string;
  type: string;
  actor_kind: Actor['kind'];
  actor_id: string;
  project_id: string | null;
  task_id: string | null;
  run_id: string | null;
  command_id: string | null;
  payload: string;
};

/** Append-only event log in SQLite (WAL). Nothing is ever updated or deleted. */
export class EventStore {
  private readonly db: DatabaseSync;
  private readonly listeners = new Set<(record: HarnessEventRecord) => void>();

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS events (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        ts         TEXT NOT NULL,
        type       TEXT NOT NULL,
        actor_kind TEXT NOT NULL,
        actor_id   TEXT NOT NULL,
        project_id TEXT,
        task_id    TEXT,
        run_id     TEXT,
        command_id TEXT UNIQUE,
        payload    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_task ON events (task_id, seq);
      CREATE INDEX IF NOT EXISTS events_run ON events (run_id, seq);
    `);
  }

  /**
   * Validates and appends one event. Returns null when `commandId` was already used,
   * so a retried command never takes effect twice.
   */
  append<T extends EventType>(input: AppendInput<T>): HarnessEventRecord<T> | null {
    const payload = parsePayload(input.type, input.payload);
    if (input.commandId && this.hasCommand(input.commandId)) return null;
    const ts = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO events (ts, type, actor_kind, actor_id, project_id, task_id, run_id, command_id, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ts,
        input.type,
        input.actor.kind,
        input.actor.id,
        input.projectId ?? null,
        input.taskId ?? null,
        input.runId ?? null,
        input.commandId ?? null,
        JSON.stringify(payload),
      );
    const record = {
      seq: Number(result.lastInsertRowid),
      ts,
      type: input.type,
      actor: input.actor,
      ...(input.projectId && { projectId: input.projectId }),
      ...(input.taskId && { taskId: input.taskId }),
      ...(input.runId && { runId: input.runId }),
      ...(input.commandId && { commandId: input.commandId }),
      payload,
    } as HarnessEventRecord<T>;
    for (const listener of this.listeners) listener(record as HarnessEventRecord);
    return record;
  }

  hasCommand(commandId: string): boolean {
    return this.db.prepare('SELECT 1 FROM events WHERE command_id = ?').get(commandId) !== undefined;
  }

  /** All events in order, optionally after a sequence number or for one task. */
  list(filter: { afterSeq?: number; taskId?: string } = {}): HarnessEventRecord[] {
    const rows = filter.taskId
      ? this.db
          .prepare('SELECT * FROM events WHERE seq > ? AND task_id = ? ORDER BY seq')
          .all(filter.afterSeq ?? 0, filter.taskId)
      : this.db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq').all(filter.afterSeq ?? 0);
    return (rows as unknown as Row[]).map(toRecord);
  }

  subscribe(listener: (record: HarnessEventRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.db.close();
  }
}

function toRecord(row: Row): HarnessEventRecord {
  return {
    seq: row.seq,
    ts: row.ts,
    type: row.type as EventType,
    actor: { kind: row.actor_kind, id: row.actor_id },
    ...(row.project_id && { projectId: row.project_id }),
    ...(row.task_id && { taskId: row.task_id }),
    ...(row.run_id && { runId: row.run_id }),
    ...(row.command_id && { commandId: row.command_id }),
    payload: JSON.parse(row.payload),
  } as HarnessEventRecord;
}
