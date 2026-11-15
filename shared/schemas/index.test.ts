import { describe, expect, it } from 'vitest';
import { authSessionSchema, healthStatusSchema, sendMessageRequestSchema, CHAT_MESSAGE_MAX_LENGTH } from './index.js';

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

// I/O matrix: "Returning user, existing settings" / "authenticated view
// renders" — the frontend's useAuthStatus() hook parses GET /api/auth/session
// against this exact schema to decide whether to render the authenticated shell.
describe('authSessionSchema (I/O matrix: authenticated view renders)', () => {
  it('accepts a well-formed session payload', () => {
    const result = authSessionSchema.safeParse({
      user: { id: 'user-1', email: 'a@example.com', name: 'Ada', picture: null },
    });

    expect(result.success).toBe(true);
  });

  it('rejects a payload missing the user', () => {
    const result = authSessionSchema.safeParse({});

    expect(result.success).toBe(false);
  });
});

// I/O matrix: "Over-length message" -> "Rejected at the schema boundary
// (4xx)" / "Never silently truncated" — `POST /api/chat/messages` validates
// against this exact schema before the agent is ever invoked.
describe('sendMessageRequestSchema (I/O matrix: over-length message)', () => {
  it('accepts a message at or under the 4000-char max', () => {
    const result = sendMessageRequestSchema.safeParse({ content: 'x'.repeat(CHAT_MESSAGE_MAX_LENGTH) });

    expect(result.success).toBe(true);
  });

  it('rejects a message over the 4000-char max, instead of truncating it', () => {
    const result = sendMessageRequestSchema.safeParse({ content: 'x'.repeat(CHAT_MESSAGE_MAX_LENGTH + 1) });

    expect(result.success).toBe(false);
  });
});
