import { describe, expect, it } from 'vitest';
import { actionToCommand, decodeAction, encodeAction, normalizeCommandText, parseCommand } from './commands.ts';

describe('parseCommand', () => {
  it('parses /new with and without a project tag', () => {
    expect(parseCommand('/new Add a login page #shop')).toEqual({ kind: 'new', text: 'Add a login page', project: 'shop' });
    expect(parseCommand('/new@HydeBot fix the #3 bug in footer')).toEqual({ kind: 'new', text: 'fix the #3 bug in footer' });
    expect(parseCommand('/new   ')).toEqual({ kind: 'help' });
    expect(parseCommand('/new #shop')).toEqual({ kind: 'help' });
  });

  it('parses status, stop, answer and decisions', () => {
    expect(parseCommand('/status')).toEqual({ kind: 'status' });
    expect(parseCommand('/stop t-3')).toEqual({ kind: 'stop', target: 'T-3' });
    expect(parseCommand('/stop ALL')).toEqual({ kind: 'stop', target: 'all' });
    expect(parseCommand('/stop everything')).toEqual({ kind: 'help' });
    expect(parseCommand('/answer q-2 Use email login\nnot OAuth')).toEqual({ kind: 'answer', questionId: 'Q-2', text: 'Use email login\nnot OAuth' });
    expect(parseCommand('/approve A-1')).toEqual({ kind: 'decide', approvalId: 'A-1', approved: true });
    expect(parseCommand('/deny a-7')).toEqual({ kind: 'decide', approvalId: 'A-7', approved: false });
  });

  it('parses the Phase 1-3 commands and tags', () => {
    expect(parseCommand('/new Fix footer #shop @codex-1')).toEqual({ kind: 'new', text: 'Fix footer', project: 'shop', agent: 'codex-1' });
    expect(parseCommand('/new Fix footer @codex-1 #shop')).toEqual({ kind: 'new', text: 'Fix footer', project: 'shop', agent: 'codex-1' });
    expect(parseCommand('/client Please change the logo colour #shop')).toEqual({ kind: 'client', text: 'Please change the logo colour', project: 'shop' });
    expect(parseCommand('/merge t-4')).toEqual({ kind: 'merge', taskId: 'T-4' });
    expect(parseCommand('/logs T-4')).toEqual({ kind: 'logs', taskId: 'T-4' });
    expect(parseCommand('/retry T-4')).toEqual({ kind: 'retry', taskId: 'T-4' });
    expect(parseCommand('/promote #shop')).toEqual({ kind: 'promote', project: 'shop' });
    expect(parseCommand('/promote')).toEqual({ kind: 'promote' });
    expect(parseCommand('/approve L-2')).toEqual({ kind: 'lesson', lessonId: 'L-2', approved: true });
    expect(parseCommand('/agents')).toEqual({ kind: 'agents' });
    expect(parseCommand('/usage')).toEqual({ kind: 'usage' });
  });

  it('accepts ! and "hyde" prefixes and bot mentions', () => {
    expect(normalizeCommandText('!new Fix it #shop')).toBe('/new Fix it #shop');
    expect(normalizeCommandText('hyde status')).toBe('/status');
    expect(normalizeCommandText('<@U123> hyde merge T-2')).toBe('/merge T-2');
    expect(normalizeCommandText('hello')).toBe('hello');
  });

  it('returns null for plain text', () => {
    expect(parseCommand('hello there')).toBeNull();
  });
});

describe('signed callback data', () => {
  const secret = 'test-secret';

  it('round-trips and fits in 64 bytes', () => {
    const a = encodeAction(secret, { kind: 'answer', questionId: 'Q-123', option: 2 });
    const d = encodeAction(secret, { kind: 'decide', approvalId: 'A-99999', approved: true });
    expect(Buffer.byteLength(a)).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(d)).toBeLessThanOrEqual(64);
    expect(decodeAction(secret, a)).toEqual({ kind: 'answer', questionId: 'Q-123', option: 2 });
    expect(decodeAction(secret, d)).toEqual({ kind: 'decide', approvalId: 'A-99999', approved: true });
  });

  it('encodes merge and lesson buttons and maps them to commands', () => {
    const m = encodeAction(secret, { kind: 'merge', taskId: 'T-9' });
    expect(actionToCommand(decodeAction(secret, m)!)).toEqual({ kind: 'merge', taskId: 'T-9' });
    const l = encodeAction(secret, { kind: 'lesson', lessonId: 'L-3', approved: false });
    expect(actionToCommand(decodeAction(secret, l)!)).toEqual({ kind: 'lesson', lessonId: 'L-3', approved: false });
    expect(actionToCommand({ kind: 'answer', questionId: 'Q-1', option: 2 })).toEqual({ kind: 'answer', questionId: 'Q-1', text: '#option:2' });
  });

  it('rejects forged or tampered data', () => {
    const d = encodeAction(secret, { kind: 'decide', approvalId: 'A-1', approved: false });
    expect(decodeAction(secret, d.replace('|0|', '|1|'))).toBeNull();
    expect(decodeAction('other-secret', d)).toBeNull();
    expect(decodeAction(secret, 'd|A-1|1')).toBeNull();
    expect(decodeAction(secret, 'garbage')).toBeNull();
  });
});
