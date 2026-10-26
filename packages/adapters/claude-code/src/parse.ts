import type { HarnessEvent, RateLimitStatus, RunFailureReason } from '@hyde/core';

// Turns `claude -p --output-format stream-json --verbose` lines into normalized events.
// Unknown line types are ignored on purpose: the CLI ships weekly and adds new ones.

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; is_error?: boolean }
  | { type: string };

export class StreamParser {
  private readonly toolNames = new Map<string, string>();
  /** True once a `result` line has been seen for the current turn. */
  sawResult = false;
  /** MCP servers the init line reported as failed to connect. */
  failedMcpServers: string[] = [];

  parseLine(line: string): HarnessEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return [];
    }
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          this.failedMcpServers = (Array.isArray(msg.mcp_servers) ? msg.mcp_servers : [])
            .filter((m: { status?: string }) => m?.status === 'failed')
            .map((m: { name?: string }) => String(m.name));
          return [{ type: 'run.started', sessionRef: String(msg.session_id), model: String(msg.model ?? 'unknown') }];
        }
        return [];
      case 'assistant':
        return this.assistant(msg.message?.content ?? []);
      case 'user':
        return this.toolResults(msg.message?.content ?? []);
      case 'rate_limit_event':
        return rateLimit(msg.rate_limit_info ?? {});
      case 'result':
        this.sawResult = true;
        return result(msg);
      default:
        return [];
    }
  }

  private assistant(content: Block[]): HarnessEvent[] {
    if (!Array.isArray(content)) return [];
    const out: HarnessEvent[] = [];
    for (const block of content) {
      if (block.type === 'text' && 'text' in block && block.text) {
        out.push({ type: 'text.delta', text: block.text });
      } else if (block.type === 'tool_use' && 'name' in block) {
        this.toolNames.set(block.id, block.name);
        out.push({ type: 'tool.started', tool: block.name, summary: summarize(block.name, block.input ?? {}) });
        const path = block.input?.file_path ?? block.input?.notebook_path;
        if (FILE_TOOLS.has(block.name) && typeof path === 'string') out.push({ type: 'file.changed', path });
      }
    }
    return out;
  }

  private toolResults(content: Block[]): HarnessEvent[] {
    if (!Array.isArray(content)) return [];
    const out: HarnessEvent[] = [];
    for (const block of content) {
      if (block.type !== 'tool_result' || !('tool_use_id' in block)) continue;
      const tool = this.toolNames.get(block.tool_use_id) ?? 'unknown';
      out.push({ type: 'tool.finished', tool, summary: block.is_error ? 'error' : 'ok' });
    }
    return out;
  }
}

function summarize(tool: string, input: Record<string, unknown>): string {
  const pick = input.command ?? input.file_path ?? input.notebook_path ?? input.pattern ?? input.url;
  const text = typeof pick === 'string' ? pick : JSON.stringify(input);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function rateStatus(raw: unknown): RateLimitStatus {
  if (raw === 'rejected') return 'rejected';
  if (raw === 'allowed') return 'allowed';
  return 'warning'; // allowed_warning and anything new
}

function rateLimit(info: Record<string, any>): HarnessEvent[] {
  const windows = info.unifiedWindows;
  if (windows && typeof windows === 'object') {
    return Object.entries(windows as Record<string, any>).map(([window, w]) => ({
      type: 'rate_limit' as const,
      status: rateStatus(w?.status),
      window,
      ...(typeof w?.resetsAt === 'number' && { resetsAt: w.resetsAt }),
      ...(typeof w?.utilization === 'number' && { utilization: w.utilization }),
    }));
  }
  return [
    {
      type: 'rate_limit',
      status: rateStatus(info.status),
      window: String(info.rateLimitType ?? 'unknown'),
      ...(typeof info.resetsAt === 'number' && { resetsAt: info.resetsAt }),
      ...(typeof info.utilization === 'number' && { utilization: info.utilization }),
    },
  ];
}

function result(msg: Record<string, any>): HarnessEvent[] {
  const out: HarnessEvent[] = [];
  const usage = msg.usage ?? {};
  out.push({
    type: 'usage',
    inputTokens:
      (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
    outputTokens: usage.output_tokens ?? 0,
    ...(typeof msg.total_cost_usd === 'number' && { costUsd: msg.total_cost_usd }),
  });
  if (msg.subtype === 'success' && !msg.is_error) {
    out.push({
      type: 'run.completed',
      summary: typeof msg.result === 'string' ? msg.result : '',
      ...(msg.structured_output !== undefined && { structured: msg.structured_output }),
    });
  } else {
    out.push({ type: 'run.failed', reason: failureReason(msg), detail: String(msg.result ?? msg.subtype ?? 'error') });
  }
  return out;
}

function failureReason(msg: Record<string, any>): RunFailureReason {
  const status = msg.api_error_status;
  const text = String(msg.result ?? '').toLowerCase();
  if (status === 401 || status === 403 || text.includes('login') || text.includes('authenticat')) return 'auth';
  if (status === 429 || text.includes('rate limit') || text.includes('usage limit')) return 'rate_limit';
  return 'crashed';
}
