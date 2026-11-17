import { Router } from 'express';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { getIntakeResponseSchema, submitIntakeRequestSchema, submitIntakeResponseSchema, type FailurePattern } from '@app/shared';
import type { Env } from '../../config/env.js';
import type { createDb } from '../../db/client.js';
import { createChatModel } from '../../agent/model.js';
import { INTAKE_CLASSIFIER_MODEL_ID } from '../../agent/registry.js';
import { classifyFailurePattern as defaultClassifyFailurePattern } from '../../agent/classify-failure-pattern.js';
import { evaluateUserMessage, defaultClassify, redactPii, type ClassifyText } from '../../agent/moderation.js';
import { getIntakeByUserId, upsertIntake } from '../../tools/plain/submit_intake.js';
import { createStrictRateLimiter } from '../middleware/rateLimit.js';

export interface IntakeRouterDeps {
  env: Pick<Env, 'RATE_LIMIT_WINDOW_MS' | 'OPENROUTER_API_KEY' | 'MISTRAL_API_KEY'>;
  db: ReturnType<typeof createDb>['db'];
  /** Test-only seam: replaces the real `INTAKE_CLASSIFIER_MODEL_ID`-backed
   * structured-output call with a fake — same DI precedent as
   * `CreatePlanDeps.createDraft` (`create_plan.ts`). */
  classifyFailurePattern?: (model: BaseChatModel, stoppedBeforeText: string, signal?: AbortSignal) => Promise<FailurePattern>;
  /** Test-only seam — same `ClassifyText` DI precedent as `moderation.ts`'s
   * own `createModerationMiddleware`. */
  classify?: ClassifyText;
}

/**
 * Story 2.10: `createIntakeRouter`: `GET /` (AC5 — plain prefill read, never
 * a LangChain tool) and `POST /` — a direct store, no `agent.invoke`.
 * `failurePattern` comes from one direct structured-output call
 * (`classifyFailurePattern`), run in parallel (`Promise.all`, never
 * sequenced) with one Mistral moderation call (`evaluateUserMessage`/
 * `defaultClassify`, reused as-is) over both free-text fields. Both routes
 * rely on the blanket `requireAuth` gate already applied in `app.ts` before
 * this router is mounted.
 */
export function createIntakeRouter({
  env,
  db,
  classifyFailurePattern: classifyFailurePatternOverride,
  classify: classifyOverride,
}: IntakeRouterDeps) {
  const router = Router();
  // Intent/Code Map: "intake's POST is LLM-backed like chat's; reuse the same
  // strict tier."
  const strictLimiter = createStrictRateLimiter(env);
  // Story 2.10: built once (same precedent as `ideas.ts`'s own
  // `translationModel`) — never user-selectable
  // (`INTAKE_CLASSIFIER_MODEL_ID` reuses `TRANSLATION_MODEL_ID`'s own
  // `category: 'translation'`), reuses the already-required
  // `OPENROUTER_API_KEY`, no new env var.
  const classifierModel = createChatModel(env, INTAKE_CLASSIFIER_MODEL_ID);
  const classifyStoppedBeforeText = classifyFailurePatternOverride ?? defaultClassifyFailurePattern;
  const classify = classifyOverride ?? defaultClassify(env);

  router.get('/', async (req, res) => {
    const userId = req.session.userId!;

    try {
      const record = await getIntakeByUserId(db, userId);
      res.json(getIntakeResponseSchema.parse({ intake: record ?? null }));
    } catch (error) {
      console.error('[intake] read failed:', { userId, error: (error as Error)?.message });
      res.status(503).json({ error: 'Service unavailable' });
    }
  });

  router.post('/', strictLimiter, async (req, res) => {
    const parseResult = submitIntakeRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      // I/O matrix: "Invalid/missing field" -> "Rejected at the Zod boundary
      // before any write or classify/moderate call" -> "400, generic error
      // body".
      res.status(400).json({ error: 'Bad request' });
      return;
    }

    const userId = req.session.userId!;
    const data = parseResult.data;

    // Same request-scoped abort-on-disconnect pattern as `ideas.ts`'s
    // `POST /generate`/`plans.ts`'s `POST /select/:ideaId` — stops the
    // classification call (the ~3s dominant cost) for a caller that's
    // already gone instead of letting it run to completion regardless.
    const abortController = new AbortController();
    const onClientDisconnect = () => abortController.abort(new Error('classify_failure_pattern: client disconnected'));
    req.on('close', onClientDisconnect);

    try {
      const before = await getIntakeByUserId(db, userId);

      // Round 10 fast path (kept exactly as-is, Boundary): an unchanged
      // `stoppedBeforeText` means there is nothing left to classify, and no
      // free text changed to re-moderate either — upsert directly, reusing
      // the stored classification, skipping both calls entirely. First-time
      // submission (`before` undefined) always takes the full path below,
      // since there's no stored classification to reuse yet.
      if (before && before.stoppedBeforeText === data.stoppedBeforeText) {
        const after = await upsertIntake(db, userId, { ...data, failurePattern: before.failurePattern });
        res.json(submitIntakeResponseSchema.parse({ intake: after }));
        return;
      }

      // AC2: one direct structured-output classify call, run concurrently
      // (`Promise.all`, never sequenced after moderation) with one Mistral
      // moderation call over both free-text fields combined into a single
      // message — the same combined shape the old agent-loop flow moderated
      // as one message (Design Notes: "why both free-text fields get one
      // combined moderation call, not just stoppedBeforeText").
      const combinedFreeText = `${data.skillsInterests}\n\n${data.stoppedBeforeText}`;
      const [failurePattern, verdict] = await Promise.all([
        classifyStoppedBeforeText(classifierModel, data.stoppedBeforeText, abortController.signal),
        evaluateUserMessage(combinedFreeText, classify, undefined),
      ]);

      if (verdict.action === 'reject') {
        // I/O matrix: "Jailbreak-flagged free text" -> no row written/
        // changed -> the same generic 502 the old "tool never called" path
        // already returned — no new message text.
        res.status(502).json({ error: 'Intake could not be saved' });
        return;
      }

      // I/O matrix: "PII-flagged free text" -> redacted fields stored (per-
      // field `redactPii`, Boundary) -> save continues, 200, redacted text
      // persisted.
      const skillsInterests = verdict.action === 'redact' ? redactPii(data.skillsInterests) : data.skillsInterests;
      const stoppedBeforeText = verdict.action === 'redact' ? redactPii(data.stoppedBeforeText) : data.stoppedBeforeText;

      const after = await upsertIntake(db, userId, { ...data, skillsInterests, stoppedBeforeText, failurePattern });
      res.json(submitIntakeResponseSchema.parse({ intake: after }));
    } catch (error) {
      // Boundary: "No log destination ... ever contains raw user message
      // text" — only the user id and error message are logged (same fields
      // as the GET handler's catch block above, for consistency).
      console.error('[intake] submission failed:', { userId, error: (error as Error)?.message });
      res.status(502).json({ error: 'Intake could not be saved' });
    } finally {
      req.off('close', onClientDisconnect);
    }
  });

  return router;
}
