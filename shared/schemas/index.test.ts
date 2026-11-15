import { describe, expect, it } from 'vitest';
import { healthStatusSchema } from './index.js';

// AC: "the Express backend and React frontend both start successfully with
// TypeScript, Zod, and the shared schema package wired" (spec-1-1) — this
// confirms the one shared schema parses valid data and rejects invalid data,
// which is the behavior both sides of the app depend on.
describe('healthStatusSchema (AC: shared schema wired)', () => {
  it('accepts a well-formed health status payload', () => {
    const result = healthStatusSchema.safeParse({
      status: 'ok',
      service: 'api',
      timestamp: new Date().toISOString(),
    });

    expect(result.success).toBe(true);
  });

  it('rejects a payload with an invalid status value', () => {
    const result = healthStatusSchema.safeParse({
      status: 'nope',
      service: 'api',
      timestamp: new Date().toISOString(),
    });

    expect(result.success).toBe(false);
  });

  it('rejects a payload missing required fields', () => {
    const result = healthStatusSchema.safeParse({ status: 'ok' });

    expect(result.success).toBe(false);
  });
});
