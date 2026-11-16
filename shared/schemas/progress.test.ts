import { describe, expect, it } from 'vitest';
import { progressEventSchema, resultEventSchema } from './progress.js';

// AC6: "progress events for one turn ... arrive over one turn-scoped SSE
// connection" — this schema is the wire contract every `event: progress`
// frame must validate against (Code Map).
describe('progressEventSchema (AC6: progress wire contract)', () => {
  it.each([
    ['a well-formed progress event', { type: 'progress', step: 'checking_message' }, true],
    ['an empty step key', { type: 'progress', step: '' }, false],
    ['a non-progress type', { type: 'result', step: 'checking_message' }, false],
  ] as const)('%s -> valid: %s', (_label, payload, expectedValid) => {
    expect(progressEventSchema.safeParse(payload).success).toBe(expectedValid);
  });
});

// AC4/AC6: the terminal frame wraps the exact same `chatMessageSchema` every
// other chat route already validates against — asserted here since
// `resultEventSchema` references it via `z.lazy` to avoid an ESM import
// cycle with `index.ts` (see progress.ts), not a literal inline reference.
describe('resultEventSchema (AC4: terminal frame wraps a valid ChatMessage)', () => {
  it('accepts a result event wrapping a well-formed chat message', () => {
    const result = resultEventSchema.safeParse({
      type: 'result',
      message: {
        id: 'msg-1',
        role: 'assistant',
        kind: 'message',
        content: 'Here are three ideas to get started.',
        createdAt: new Date().toISOString(),
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects a result event whose message fails chatMessageSchema', () => {
    const result = resultEventSchema.safeParse({ type: 'result', message: { role: 'assistant' } });

    expect(result.success).toBe(false);
  });
});
