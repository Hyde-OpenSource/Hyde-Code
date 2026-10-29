import { decodeAction } from '@hyde/core';
import { describe, expect, it } from 'vitest';
import { toBlocks } from './index.ts';

describe('Slack blocks', () => {
  it('renders text and signed buttons', () => {
    const blocks = toBlocks(
      { text: 'A-1: push?', buttons: [[{ label: 'Push', action: { kind: 'decide', approvalId: 'A-1', approved: true } }]] },
      'secret',
    ) as { type: string; elements?: { value: string; action_id: string }[] }[];
    expect(blocks[0]).toEqual({ type: 'section', text: { type: 'mrkdwn', text: 'A-1: push?' } });
    const button = blocks[1]!.elements![0]!;
    expect(button.action_id).toMatch(/^hyde_0_/);
    expect(decodeAction('secret', button.value)).toEqual({ kind: 'decide', approvalId: 'A-1', approved: true });
  });
});
