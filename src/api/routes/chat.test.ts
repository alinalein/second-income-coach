import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { createChatRouter, type ChatRouterDeps } from './chat.js';
import { JAILBREAK_REJECTION_MESSAGE } from '../../agent/moderation.js';
import { MODEL_FAILURE_MESSAGE, MODEL_FAILURE_MESSAGE_DE } from '../../agent/resilience.js';

const testEnv: ChatRouterDeps['env'] = { RATE_LIMIT_WINDOW_MS: 60_000 };

type FakeAgent = ChatRouterDeps['agent'];

function fakeAgent(overrides: Partial<FakeAgent> = {}): FakeAgent {
  return {
    invoke: vi.fn(),
    getState: vi.fn().mockResolvedValue({ values: {} }),
    ...overrides,
  } as unknown as FakeAgent;
}

/** A minimal app with an in-memory session (same pattern as
 * `api/routes/auth.test.ts`) and a pre-authenticated session, since the chat
 * router relies entirely on the blanket `requireAuth` gate in `app.ts` and
 * doesn't re-check auth itself. */
function buildTestApp(agent: FakeAgent, userId = 'user-1') {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, _res, next) => {
    req.session.userId = userId;
    next();
  });
  app.use('/api/chat', createChatRouter({ env: testEnv, agent }));
  return app;
}

describe('createChatRouter POST /messages', () => {
  // I/O matrix: "Over-length message" -> "Rejected at the schema boundary
  // (4xx)" / "Never silently truncated" — the agent must never be invoked.
  it('rejects an over-length message with 400 and never invokes the agent', async () => {
    const agent = fakeAgent();
    const app = buildTestApp(agent);

    const res = await request(app)
      .post('/api/chat/messages')
      .send({ content: 'x'.repeat(4001) });

    expect(res.status).toBe(400);
    expect(agent.invoke).not.toHaveBeenCalled();
  });

  // I/O matrix: "Model call exhausts retries" -> "User sees the fixed generic
  // error message" / "App keeps running, no crash". AC2 extends this: the
  // fixed message's language is picked from the submitted content via
  // `detectReplyLanguage`, same as moderation's own DE/EN picks.
  it.each([
    ['English content', 'Hello there', MODEL_FAILURE_MESSAGE],
    ['German content', 'Hallo, ich brauche Hilfe bei meinem Nebeneinkommen', MODEL_FAILURE_MESSAGE_DE],
  ] as const)('returns the fixed %s error message when the agent invocation rejects', async (_label, content, expected) => {
    const agent = fakeAgent({ invoke: vi.fn().mockRejectedValue(new Error('retries exhausted')) });
    const app = buildTestApp(agent);

    const res = await request(app).post('/api/chat/messages').send({ content });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatchObject({ role: 'assistant', kind: 'error', content: expected });
  });

  // I/O matrix row 6 (AC2), distinct failure branch from the one above: the
  // agent resolves without throwing but produces nothing renderable (no
  // messages at all) — this is the *other* `MODEL_FAILURE_MESSAGE` use site
  // in `chat.ts` (the "no usable reply" branch), which must pick the same
  // way.
  it('returns the German fixed error message when the agent resolves with no usable reply, for German content', async () => {
    const agent = fakeAgent({ invoke: vi.fn().mockResolvedValue({ messages: [] }) });
    const app = buildTestApp(agent);

    const res = await request(app).post('/api/chat/messages').send({ content: 'Ich möchte etwas fragen' });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatchObject({ role: 'assistant', kind: 'error', content: MODEL_FAILURE_MESSAGE_DE });
  });

  // I/O matrix: "Second message, same session" -> "Same LangGraph thread
  // (derived from session), same Postgres checkpoint".
  it('derives the same thread id from the session across two messages', async () => {
    const invoke = vi.fn().mockResolvedValue({ messages: [new AIMessage('Sure, happy to help!')] });
    const agent = fakeAgent({ invoke });
    const app = buildTestApp(agent, 'user-42');

    await request(app).post('/api/chat/messages').send({ content: 'first message' });
    await request(app).post('/api/chat/messages').send({ content: 'second message' });

    expect(invoke).toHaveBeenCalledTimes(2);
    const [, firstConfig] = invoke.mock.calls[0]!;
    const [, secondConfig] = invoke.mock.calls[1]!;
    expect(firstConfig).toEqual({ configurable: { thread_id: 'discovery:user-42' } });
    expect(secondConfig).toEqual(firstConfig);
  });

  // AC: "the shared ChatThread/ChatMessage component ... error and
  // neutral-notice rendering" — classifies the reply's `kind` from the
  // agent's returned message text.
  it.each([
    ['a normal reply', 'Here are three ideas to get started.', 'message'],
    ['the fixed jailbreak-rejection text', JAILBREAK_REJECTION_MESSAGE, 'notice'],
  ] as const)('classifies %s as kind %j -> %s', async (_label, content, expectedKind) => {
    const agent = fakeAgent({ invoke: vi.fn().mockResolvedValue({ messages: [new AIMessage(content)] }) });
    const app = buildTestApp(agent);

    const res = await request(app).post('/api/chat/messages').send({ content: 'hi' });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatchObject({ role: 'assistant', kind: expectedKind, content });
  });
});

// AC: "GET /api/chat/messages reads history back from the checkpointer's own
// thread state" (Design Notes: "Checkpointer, not a messages table").
describe('createChatRouter GET /messages', () => {
  it("reads the thread's checkpointed messages back, mapped to the shared chat schema", async () => {
    const getState = vi.fn().mockResolvedValue({
      values: { messages: [new HumanMessage('hi there'), new AIMessage('hello! how can I help?')] },
    });
    const agent = fakeAgent({ getState });
    const app = buildTestApp(agent, 'user-7');

    const res = await request(app).get('/api/chat/messages');

    expect(res.status).toBe(200);
    expect(getState).toHaveBeenCalledWith({ configurable: { thread_id: 'discovery:user-7' } });
    expect(res.body.messages).toEqual([
      expect.objectContaining({ role: 'user', kind: 'message', content: 'hi there' }),
      expect.objectContaining({ role: 'assistant', kind: 'message', content: 'hello! how can I help?' }),
    ]);
  });

  it('returns an empty history for a brand-new thread with no checkpoint yet', async () => {
    const agent = fakeAgent({ getState: vi.fn().mockResolvedValue({ values: {} }) });
    const app = buildTestApp(agent);

    const res = await request(app).get('/api/chat/messages');

    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
  });
});
