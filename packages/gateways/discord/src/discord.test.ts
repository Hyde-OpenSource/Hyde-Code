import { decodeAction } from '@hyde/core';
import { describe, expect, it } from 'vitest';
import { toComponents } from './index.ts';

describe('Discord components', () => {
  it('turns buttons into signed, size-limited components', () => {
    const rows = toComponents({ text: 'x', buttons: [[{ label: 'Merge', action: { kind: 'merge', taskId: 'T-3' } }]] }, 's');
    const json = rows[0]!.toJSON() as { components: { custom_id: string; label: string }[] };
    expect(json.components[0]!.label).toBe('Merge');
    expect(json.components[0]!.custom_id.length).toBeLessThanOrEqual(100);
    expect(decodeAction('s', json.components[0]!.custom_id)).toEqual({ kind: 'merge', taskId: 'T-3' });
  });
});
