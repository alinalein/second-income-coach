import { randomUUID } from 'node:crypto';
import { and, desc, eq, ne } from 'drizzle-orm';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Command } from '@langchain/langgraph';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  planResponseSchema,
  planListResponseSchema,
  currentStepResponseSchema,
  activatePlanDecisionSchema,
  recordCheckInRequestSchema,
  checkInResponseSchema,
  startStepResponseSchema,
  startStepAckResponseSchema,
  completeStepResponseSchema,
  completeStepAckResponseSchema,
  chatMessageSchema,
  projectionResponseSchema,
  checkInStatusResponseSchema,
  resolveCurrency,
  type PlanResponse,
  type ChatMessage,
} from '@app/shared';
import type { Env } from '../../config/env.js';
import type { createDb } from '../../db/client.js';
import type { CoachAgent } from '../../agent/index.js';
import { buildPlanThreadId, buildDiscoveryThreadId, buildPlanActivationThreadId } from '../../agent/index.js';
import { evaluateUserMessage, evaluateAssistantMessage, defaultClassify, type ClassifyText } from '../../agent/moderation.js';
import { containsGuiltLanguage } from '../../agent/guilt-language.js';
import { handleCreatePlan, type CreatePlanDeps } from '../../tools/llm/create_plan.js';
import { getCurrentStep } from '../../tools/plain/get_current_step.js';
import { recordCheckIn, getCheckInStatus } from '../../tools/plain/record_check_in.js';
import { startStep } from '../../tools/plain/start_step.js';
import { completeStep } from '../../tools/plain/complete_step.js';
import { getProjection } from '../../tools/plain/get_projection.js';
import { StepNotCurrentError, PlanNotActiveError } from '../../tools/plain/step-state.js';
import { getUserSettings } from '../../db/settings-repository.js';
import {
  getPendingReview,
  resumePausedPlan,
  PlanNotFoundError,
  PlanNotDraftError,
  type ActivatePlanGraph,
} from '../../tools/plain/activate_plan.js';
import { ideas, plans, planSteps } from '../../db/schema/index.js';
import { createStrictRateLimiter } from '../middleware/rateLimit.js';
import { detectUserReplyLanguage } from './ideas.js';

export interface PlansRouterDeps {
  env: Pick<Env, 'RATE_LIMIT_WINDOW_MS' | 'MISTRAL_API_KEY'>;
  db: ReturnType<typeof createDb>['db'];
  /** The plans-only compiled agent (`plansAgent`, `src/api/index.ts`) —
   * Story 2.10: `create_plan` itself is no longer invoked through it
   * (`handleCreatePlan` is called directly below); still used for
   * `detectUserReplyLanguage` (`.getState`) and seeding the plan thread's
   * welcome message (`.updateState`). */
  agent: CoachAgent;
  /** Story 2.10: the shared chat model `handleCreatePlan` calls directly —
   * same `Deps`/`Config`/`Args` shape `create_plan.ts`'s own tool wrapper
   * (`createCreatePlanTool`) already used. */
  model: BaseChatModel;
  /** Test-only seam: same DI precedent as `CreatePlanDeps.createDraft`
   * (`create_plan.ts`) — replaces the real model-backed draft call with a
   * fake. */
  createDraft?: CreatePlanDeps['createDraft'];
  /** Story 3.2 (AD-14): the dedicated, checkpointed `activate_plan` graph —
   * backs the `/:planId/activate*` routes below. */
  activatePlanGraph: ActivatePlanGraph;
  /** Test-only seam — same `ClassifyText` DI precedent as `intake.ts`'s own
   * `createIntakeRouter`. AD-11: the reject-feedback free text (the one new
   * user-authored free text this story introduces) is moderated the same
   * direct way `intake.ts` moderates its free-text fields — jailbreak ->
   * reject, PII -> redact-and-continue — before it ever reaches
   * `create_plan`'s nested model prompt. */
  classify?: ClassifyText;
}

type PlanRow = typeof plans.$inferSelect;

/**
 * Review fix: two concurrent `POST /select/:ideaId` requests for the same
 * idea with no existing plan can both pass the "no existing plan" check
 * above and both invoke `create_plan` — the loser's insert hits the
 * `plans_idea_id_unique` constraint (Postgres error code `23505`) and
 * throws. That's not a real failure (a plan *was* created, by the winner),
 * so it's detected here rather than falling through to the generic 502 the
 * `catch` block below reports for every other failure.
 */
/**
 * Bug fix (user-reported, live): Drizzle's `node-postgres` driver wraps the
 * real `pg` error — the underlying Postgres error (with `.code`) lives at
 * `error.cause`, never copied to the wrapper's own top level. Checking only
 * `error.code` (the original version of this function) was always
 * `undefined` for a real DB error, so this recovery path never actually
 * fired in production; every genuine race fell through to the generic 502
 * below instead. Confirmed live: a real unique-violation's `error.cause.code`
 * is `'23505'`, `error.code` is `undefined`.
 */
export function isUniqueViolationError(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } } | undefined)?.code;
  const causeCode = (error as { cause?: { code?: string } } | undefined)?.cause?.code;
  return code === '23505' || causeCode === '23505';
}

/**
 * Story 3.2: shared ownership check for the `/:planId/activate*` routes —
 * same `db.select({ userId: plans.userId })` pattern `/:planId/current-step`
 * already used, factored out since three more routes below need it too.
 */
async function isPlanOwnedByUser(db: PlansRouterDeps['db'], planId: string, userId: string): Promise<boolean> {
  const [plan] = await db.select({ userId: plans.userId }).from(plans).where(eq(plans.id, planId)).limit(1);
  return plan?.userId === userId;
}

function toPlanResponse(row: PlanRow): PlanResponse {
  return planResponseSchema.parse({
    id: row.id,
    ideaId: row.ideaId,
    status: row.status,
    threadId: row.threadId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/**
 * Bug fix (user-reported): the real plan thread must never show the raw
 * creation trigger as if the user had typed it. Once the plan actually
 * exists, this fixed (not model-generated — keeps the `returnDirect` speed
 * win) welcome message is the thread's first visible entry instead,
 * orienting the user at the one thing 3.1 actually renders: the current
 * step in `StatusPanel`, on the left.
 */
const PLAN_READY_MESSAGE_EN =
  "Your plan is ready — you can see your first step on the left. Once you've done it, let me know here and the next step will unlock.";
const PLAN_READY_MESSAGE_DE =
  'Dein Plan ist fertig — deinen ersten Schritt siehst du links. Sag mir hier Bescheid, sobald du ihn erledigt hast, dann wird der nächste Schritt freigeschaltet.';

/**
 * Spec 2.12 AC8: one direct, non-agentic model call produces a short
 * start-of-step acknowledgment — a single bounded attempt, no retry (same
 * "one attempt" precedent as `translate-idea-cards.ts`'s own
 * `TRANSLATE_TIMEOUT_MS`), scaled down since this is a much smaller prompt
 * with no structured output. Any failure/flag/timeout fails open to no chat
 * message at all (AC: "the step start still succeeds and no chat message or
 * error appears") — never a retry loop, never an error surfaced to the
 * caller. Review fix: kept short (not `TRANSLATE_TIMEOUT_MS`'s 30s) —
 * `chatMessage` is included in the same HTTP response as the step-start
 * result itself (Code Map), so this budget is also the worst-case extra
 * wait a "Start this step" click can add; a plain one-or-two-sentence
 * completion with no structured output has no real need for a long one.
 */
const START_STEP_ACK_TIMEOUT_MS = 10_000;

/** Bug fix (user-reported, live): marks a persisted `AIMessage` as this
 * route's own start-of-step acknowledgment — never any other assistant
 * message in the same plan thread (a genuine chat reply is never mistaken
 * for one when `getRecentAckTexts` below re-reads the thread). */
const STEP_START_ACK_KWARG = 'stepStartAck';

/** Bug fix (user-reported, live): "consecutive start messages must not
 * repeat each other" — how many of this thread's own previous start
 * acknowledgments to show the model so it can avoid reusing their opener/
 * wording. 3 is enough to break an emerging pattern without bloating the
 * prompt. */
const START_STEP_ACK_HISTORY_LIMIT = 3;

/** Bug fix (user-reported, live): a short style nudge picked at random per
 * call — on top of the no-repeat rule below, this is what actually varies
 * a run that happens to have no prior history yet (the very first start in
 * a thread) instead of always converging on the same "default" voice. */
const START_STEP_ACK_STYLE_HINTS: Record<'de' | 'en', readonly string[]> = {
  en: [
    'Write in a practical, matter-of-fact tone.',
    'Write in a light, casual tone.',
    'Write in a direct, no-fuss tone.',
  ],
  de: [
    'Schreibe in einem sachlichen, praktischen Ton.',
    'Schreibe in einem lockeren, beiläufigen Ton.',
    'Schreibe in einem direkten, knappen Ton.',
  ],
};

/** Test-only seam precedent (`random: () => number`, same shape as other
 * DI seams in this codebase) — defaults to `Math.random` so a test can pass
 * a fixed value for a deterministic style hint. */
function pickStartStepAckStyleHint(language: 'de' | 'en', random: () => number = Math.random): string {
  const hints = START_STEP_ACK_STYLE_HINTS[language];
  return hints[Math.floor(random() * hints.length)]!;
}

/**
 * Bug fix (user-reported, live): "the model-written start messages repeat
 * the same pattern" — `recentMessages` (this thread's own last
 * `START_STEP_ACK_HISTORY_LIMIT` start acknowledgments, oldest first) are
 * quoted back with an explicit no-repeat instruction, and the prompt now
 * spells out variety rules directly (vary the opener, vary length, no stock
 * phrases, name the concrete action, a randomly-picked tone hint) instead
 * of leaving the model to find its own voice, which is what converged on
 * the same "that's a meaningful step ... keep going at your own pace"
 * phrasing every time.
 */
export function buildStartStepAckPrompt(
  language: 'de' | 'en',
  stepTitle: string,
  recentMessages: readonly string[],
  styleHint: string,
): string {
  const noRepeatLines =
    recentMessages.length > 0
      ? language === 'de'
        ? [
            'Deine letzten Start-Bestätigungen in diesem Chat waren:',
            ...recentMessages.map((message) => `- "${message}"`),
            'Verwende weder denselben Satzanfang noch dieselbe Formulierung wie diese — jede Bestätigung muss anders klingen.',
          ]
        : [
            'Your last start acknowledgments in this chat were:',
            ...recentMessages.map((message) => `- "${message}"`),
            'Do not reuse their opener or wording — each acknowledgment must sound different from all of these.',
          ]
      : [];

  const lines =
    language === 'de'
      ? [
          `Die Person hat gerade mit dem Plan-Schritt "${stepTitle}" begonnen.`,
          'Schreibe eine kurze, motivierende und nicht-belehrende Bestätigung auf Deutsch, die diesen Start anerkennt.',
          'Variiere den Satzanfang jedes Mal — beginne nicht immer gleich (z. B. nicht immer mit "Du hast ... begonnen").',
          'Variiere die Länge: oft nur ein kurzer Satz, manchmal zwei — nie mehr.',
          'Keine Floskeln wie "das ist ein bedeutender Schritt", "bleib in deinem eigenen Tempo" oder "toller Einsatz".',
          'Benenne die konkrete Handlung in einfachen, eigenen Worten statt einer generischen Floskel.',
          styleHint,
          ...noRepeatLines,
          'Erwähne nichts Verpasstes, keine Verzögerung und keine frühere Pause — nur diesen Start selbst.',
          // User-reported (live): "add some emojis to messages after the
          // user clicks start" — one, occasionally two, never more; never a
          // substitute for the actual words. User-reported follow-up: no
          // thumbs-up — a smiley or confetti-style emoji instead.
          'Du darfst ein passendes Emoji einbauen (z. B. 😊, 🎉, 💪) — kein Daumen-hoch-Emoji — höchstens eins, gelegentlich zwei, nie mehr, und nie anstelle echter Worte.',
          'Antworte nur mit der Bestätigung selbst, ohne Anführungszeichen oder zusätzlichen Text.',
        ]
      : [
          `The person just started the plan step "${stepTitle}".`,
          'Write a short, motivating, non-judgmental acknowledgment in English that recognizes this start.',
          'Vary the opener every time — never always start the same way (e.g. not always "You\'ve started...").',
          'Vary the length: often just one short sentence, sometimes two — never more.',
          'No stock phrases such as "that\'s a meaningful step", "keep going at your own pace", or "great work".',
          'Name the concrete action in plain words of your own, not a generic stock phrase.',
          styleHint,
          ...noRepeatLines,
          'Never mention anything missed, any delay, or a past pause — only this start itself.',
          // User-reported (live): "add some emojis to messages after the
          // user clicks start" — one, occasionally two, never more; never a
          // substitute for the actual words. User-reported follow-up: no
          // thumbs-up — a smiley or confetti-style emoji instead.
          'You may include one fitting emoji (e.g. 😊, 🎉, 💪) — never a thumbs-up emoji — at most one, occasionally two, never more, and never in place of real words.',
          'Reply with only the acknowledgment itself, no quotes or extra text.',
        ];

  return lines.join('\n');
}

/**
 * Bug fix (user-reported, live): reads this plan thread's own checkpointed
 * history for the last `limit` acknowledgments this route itself wrote,
 * tagged with the given `kwarg` (`STEP_START_ACK_KWARG`/
 * `STEP_COMPLETION_ACK_KWARG` below) — never a genuine chat reply, which
 * carries no such tag, and never the *other* ack kind, so a step-start and
 * a step-completion message never dilute each other's no-repeat pool.
 * Fail-open, same precedent as `detectUserReplyLanguage` (`ideas.ts`): a
 * read error returns an empty list rather than blocking the action itself.
 */
async function getRecentAckTexts(agent: CoachAgent, threadId: string, limit: number, kwarg: string): Promise<string[]> {
  try {
    const state = await agent.getState({ configurable: { thread_id: threadId } });
    const messages = (state.values.messages ?? []) as BaseMessage[];
    return messages
      .filter((message) => message._getType() === 'ai' && message.additional_kwargs?.[kwarg] === true)
      .slice(-limit)
      .map((message) => message.text)
      .filter((text): text is string => text.length > 0);
  } catch {
    return [];
  }
}

/**
 * AC8: builds the chat acknowledgment for a successful `start_step`, fully
 * fail-open — any error, timeout, or moderation/guilt-language flag returns
 * `undefined` rather than throwing, so the step-start response itself is
 * never affected by this best-effort extra.
 *
 * Exported for `src/evals/start-step-ack-latency.eval.ts` — "the same
 * function the route uses" (user-requested), not a re-implementation of its
 * timing/prompt/moderation behavior.
 */
export async function buildStartStepAckMessage(
  model: BaseChatModel,
  classify: ClassifyText,
  threadId: string,
  language: 'de' | 'en',
  stepTitle: string,
  recentMessages: readonly string[],
  random: () => number = Math.random,
): Promise<ChatMessage | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('start_step ack: exceeded its budget')), START_STEP_ACK_TIMEOUT_MS);

  try {
    const styleHint = pickStartStepAckStyleHint(language, random);
    const response = await model.invoke([new HumanMessage(buildStartStepAckPrompt(language, stepTitle, recentMessages, styleHint))], {
      signal: controller.signal,
    });
    const text = (response.text ?? '').trim();
    if (!text) return undefined;

    // AD-11-equivalent: the same unsafe-output check the agent's own
    // `afterModel` moderation middleware applies to every reply.
    const verdict = await evaluateAssistantMessage(text, classify, threadId);
    if (verdict.action === 'replace') return undefined;
    // AD-12: the same guilt-language guard CAP-4 replies get — this
    // acknowledgment must never slip into "you missed/broke a streak"
    // phrasing, even though nothing prompted it to.
    if (containsGuiltLanguage(text)) return undefined;

    return chatMessageSchema.parse({
      id: randomUUID(),
      role: 'assistant',
      kind: 'message',
      content: text,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    console.warn('[plans] start_step acknowledgment failed/timed out, omitting it:', {
      threadId,
      error: (error as Error)?.message,
    });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** User-requested (follow-up to Spec 2.12 AC8/Story 4.5 AC3): marks a
 * persisted `AIMessage` as this route's own per-step completion
 * acknowledgment — its own tag, distinct from `STEP_START_ACK_KWARG` and
 * `PLAN_COMPLETION_ACK_KWARG` below, so `getRecentAckTexts` only ever quotes
 * back this kind of message as the no-repeat context. */
const STEP_COMPLETION_ACK_KWARG = 'stepCompletionAck';

/**
 * User-requested (follow-up to Spec 2.12 AC8): "also send an encouraging
 * message when the user completes a task, not just when they start one" —
 * the exact same variety rules/no-repeat quoting as
 * `buildStartStepAckPrompt` above, themed around finishing one step rather
 * than starting it. Fires on every non-final step completion
 * (`buildPlanCompletionAckPrompt` below already owns the plan's own final
 * step, with its own distinct "whole plan is done" theme).
 */
export function buildStepCompletionAckPrompt(
  language: 'de' | 'en',
  stepTitle: string,
  recentMessages: readonly string[],
  styleHint: string,
): string {
  const noRepeatLines =
    recentMessages.length > 0
      ? language === 'de'
        ? [
            'Deine letzten Abschluss-Bestätigungen in diesem Chat waren:',
            ...recentMessages.map((message) => `- "${message}"`),
            'Verwende weder denselben Satzanfang noch dieselbe Formulierung wie diese — jede Bestätigung muss anders klingen.',
          ]
        : [
            'Your last completion acknowledgments in this chat were:',
            ...recentMessages.map((message) => `- "${message}"`),
            'Do not reuse their opener or wording — each acknowledgment must sound different from all of these.',
          ]
      : [];

  const lines =
    language === 'de'
      ? [
          `Die Person hat gerade den Plan-Schritt "${stepTitle}" abgeschlossen.`,
          'Schreibe eine kurze, ermutigende und nicht-belehrende Bestätigung auf Deutsch, die diesen Abschluss anerkennt.',
          'Variiere den Satzanfang jedes Mal — beginne nicht immer gleich (z. B. nicht immer mit "Du hast ... geschafft").',
          'Variiere die Länge: oft nur ein kurzer Satz, manchmal zwei — nie mehr.',
          'Keine Floskeln wie "super gemacht", "weiter so" oder "das war ein großer Schritt" ohne eigenen Inhalt dahinter.',
          'Benenne die konkrete Handlung in einfachen, eigenen Worten statt einer generischen Floskel.',
          styleHint,
          ...noRepeatLines,
          'Erwähne nichts Verpasstes, keinen Rückstand und keinen Druck in Richtung des nächsten Schritts — nur diesen Abschluss selbst.',
          'Du darfst ein passendes Emoji einbauen (z. B. 😊, 🎉, ✅) — kein Daumen-hoch-Emoji — höchstens eins, gelegentlich zwei, nie mehr, und nie anstelle echter Worte.',
          'Antworte nur mit der Bestätigung selbst, ohne Anführungszeichen oder zusätzlichen Text.',
        ]
      : [
          `The person just completed the plan step "${stepTitle}".`,
          'Write a short, encouraging, non-judgmental acknowledgment in English that recognizes this completion.',
          'Vary the opener every time — never always start the same way (e.g. not always "You\'ve finished...").',
          'Vary the length: often just one short sentence, sometimes two — never more.',
          'No stock phrases such as "great job", "keep it up", or "that was a big step" with no real content behind them.',
          'Name the concrete action in plain words of your own, not a generic stock phrase.',
          styleHint,
          ...noRepeatLines,
          'Never mention anything missed, any backlog, or pressure toward the next step — only this completion itself.',
          'You may include one fitting emoji (e.g. 😊, 🎉, ✅) — never a thumbs-up emoji — at most one, occasionally two, never more, and never in place of real words.',
          'Reply with only the acknowledgment itself, no quotes or extra text.',
        ];

  return lines.join('\n');
}

/**
 * User-requested: builds the chat acknowledgment for a successful
 * `complete_step` on a non-final step, fully fail-open — mirrors
 * `buildStartStepAckMessage` exactly (AD-11 moderation, AD-12
 * guilt-language guard, same bounded one-shot timeout): any error, timeout,
 * or moderation/guilt-language flag returns `undefined` rather than
 * throwing, so completion itself is never affected by this best-effort
 * extra.
 *
 * Exported (Story 4.6, same precedent as `buildStartStepAckMessage` above)
 * so it can be unit-tested directly, without a real HTTP/DB round trip.
 */
export async function buildStepCompletionAckMessage(
  model: BaseChatModel,
  classify: ClassifyText,
  threadId: string,
  language: 'de' | 'en',
  stepTitle: string,
  recentMessages: readonly string[],
  random: () => number = Math.random,
): Promise<ChatMessage | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('complete_step ack: exceeded its budget')), START_STEP_ACK_TIMEOUT_MS);

  try {
    const styleHint = pickStartStepAckStyleHint(language, random);
    const response = await model.invoke([new HumanMessage(buildStepCompletionAckPrompt(language, stepTitle, recentMessages, styleHint))], {
      signal: controller.signal,
    });
    const text = (response.text ?? '').trim();
    if (!text) return undefined;

    // AD-11-equivalent: the same unsafe-output check the agent's own
    // `afterModel` moderation middleware applies to every reply.
    const verdict = await evaluateAssistantMessage(text, classify, threadId);
    if (verdict.action === 'replace') return undefined;
    // AD-12: the same guilt-language guard CAP-4 replies get — this
    // acknowledgment must never slip into "you missed/broke a streak"
    // phrasing, even though nothing prompted it to.
    if (containsGuiltLanguage(text)) return undefined;

    return chatMessageSchema.parse({
      id: randomUUID(),
      role: 'assistant',
      kind: 'message',
      content: text,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    console.warn('[plans] complete_step (non-final) acknowledgment failed/timed out, omitting it:', {
      threadId,
      error: (error as Error)?.message,
    });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Story 4.5 (AC3): marks a persisted `AIMessage` as this route's own
 * plan-completion acknowledgment — its own tag, distinct from
 * `STEP_START_ACK_KWARG`/`STEP_COMPLETION_ACK_KWARG`, even though nothing
 * currently re-reads it (a plan only completes once, so there's no "recent
 * completion acks" lookup to filter by it the way `getRecentAckTexts` does
 * for the other two ack kinds). */
const PLAN_COMPLETION_ACK_KWARG = 'planCompletionAck';

/**
 * AC3 (4.5): the exact same direct, non-agentic, one-shot pattern as
 * `buildStartStepAckPrompt` above (variety rules, no-repeat quoting) —
 * themed around finishing the whole plan instead of starting one step.
 * `recentMessages` reuses this thread's own recent *start*-step
 * acknowledgments (`getRecentAckTexts`, below) as the "don't repeat this"
 * context — a plan completes at most once, so there's no prior completion
 * message of its own to avoid repeating; quoting the thread's recent tone
 * instead is what AC3's "previous messages passed so it does not repeat"
 * means here.
 */
export function buildPlanCompletionAckPrompt(
  language: 'de' | 'en',
  finalStepTitle: string,
  totalSteps: number,
  recentMessages: readonly string[],
  styleHint: string,
): string {
  const noRepeatLines =
    recentMessages.length > 0
      ? language === 'de'
        ? [
            'Frühere kurze Bestätigungen in diesem Chat waren:',
            ...recentMessages.map((message) => `- "${message}"`),
            'Verwende weder denselben Satzanfang noch dieselbe Formulierung wie diese.',
          ]
        : [
            'Earlier short acknowledgments in this chat were:',
            ...recentMessages.map((message) => `- "${message}"`),
            'Do not reuse their opener or wording.',
          ]
      : [];

  // User-reported (live): the first live completion message read as a flat
  // status recap ("You've completed all 12 steps... that's the whole plan
  // finished"), not as something encouraging — the "no empty stock phrases"
  // rule alone pushed the model toward a dry factual summary instead of
  // genuine warmth with real content behind it. The lines below ask for
  // both at once: lead with the feeling, then ground it in one concrete
  // thing they actually did (not just the step/total count).
  const lines =
    language === 'de'
      ? [
          `Die Person hat gerade den letzten Schritt ihres Plans abgeschlossen ("${finalStepTitle}") — damit ist der ganze Plan mit ${totalSteps} Schritten fertig.`,
          'Schreibe eine kurze, herzliche Nachricht auf Deutsch, die sich wie eine echte, warme Anerkennung anfühlt — kein trockener Statusbericht ("12 von 12 Schritten erledigt").',
          'Beginne mit dem Gefühl (Freude, Stolz, Erleichterung), nicht mit einer Aufzählung — und verankere das dann in einer konkreten Sache, die die Person wirklich getan hat, in einfachen eigenen Worten.',
          'Variiere den Satzanfang — beginne nicht immer gleich.',
          'Variiere die Länge: oft ein bis zwei Sätze, manchmal drei — nie mehr.',
          'Keine leeren Floskeln wie "Glückwunsch" oder "super gemacht" ohne eigenen Inhalt dahinter.',
          styleHint,
          ...noRepeatLines,
          'Erwähne einmal, neutral, dass es in der Seitenleiste "Neue Ideen" gibt, falls die Person weitermachen möchte — niemals als Aufforderung oder Druck, nur als Option.',
          'Keine Schuldzuweisung, kein Druck, keine Dringlichkeit — keine Erwähnung von Streaks, Punkten oder Leveln.',
          // User-reported (live): "add some emojis" — a touch of warmth,
          // never a substitute for the actual words.
          'Du darfst ein oder zwei passende Emojis einbauen (z. B. 🎉, 👏, ✨) — nie mehr, und nie anstelle echter Worte.',
          'Antworte nur mit der Nachricht selbst, ohne Anführungszeichen oder zusätzlichen Text.',
        ]
      : [
          `The person just completed the final step of their plan ("${finalStepTitle}") — their whole plan, ${totalSteps} steps in total, is now finished.`,
          'Write a short message in English that feels like a genuine, warm acknowledgment — never a dry status recap ("12 of 12 steps done").',
          'Lead with the feeling (joy, pride, relief), not a tally — then ground it in one concrete thing they actually did, in plain words of your own.',
          'Vary the opener — never always start the same way.',
          'Vary the length: often one or two sentences, sometimes three — never more.',
          'No empty stock phrases like "congratulations" or "great job" with no real content behind them.',
          styleHint,
          ...noRepeatLines,
          'Mention once, neutrally, that "New ideas" is in the sidebar if they want to keep going — never as a call to action or pressure, just as an option.',
          'No guilt, no pressure, no urgency — never mention streaks, points, or levels.',
          // User-reported (live): "add some emojis" — a touch of warmth,
          // never a substitute for the actual words.
          'You may include one or two fitting emojis (e.g. 🎉, 👏, ✨) — never more, and never in place of real words.',
          'Reply with only the message itself, no quotes or extra text.',
        ];

  return lines.join('\n');
}

/**
 * AC3 (4.5): builds the chat acknowledgment for a successful `complete_step`
 * on the plan's final step, fully fail-open — mirrors
 * `buildStartStepAckMessage` exactly (AD-11 moderation, AD-12 guilt-language
 * guard, same bounded one-shot timeout): any error, timeout, or
 * moderation/guilt-language flag returns `undefined` rather than throwing,
 * so completion itself is never affected by this best-effort extra.
 */
async function buildPlanCompletionAckMessage(
  model: BaseChatModel,
  classify: ClassifyText,
  threadId: string,
  language: 'de' | 'en',
  finalStepTitle: string,
  totalSteps: number,
  recentMessages: readonly string[],
  random: () => number = Math.random,
): Promise<ChatMessage | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('complete_step ack: exceeded its budget')), START_STEP_ACK_TIMEOUT_MS);

  try {
    const styleHint = pickStartStepAckStyleHint(language, random);
    const response = await model.invoke(
      [new HumanMessage(buildPlanCompletionAckPrompt(language, finalStepTitle, totalSteps, recentMessages, styleHint))],
      { signal: controller.signal },
    );
    const text = (response.text ?? '').trim();
    if (!text) return undefined;

    // AD-11-equivalent: the same unsafe-output check the agent's own
    // `afterModel` moderation middleware applies to every reply.
    const verdict = await evaluateAssistantMessage(text, classify, threadId);
    if (verdict.action === 'replace') return undefined;
    // AD-12: this completion message must never slip into guilt-language
    // phrasing either, even though nothing prompted it to.
    if (containsGuiltLanguage(text)) return undefined;

    return chatMessageSchema.parse({
      id: randomUUID(),
      role: 'assistant',
      kind: 'message',
      content: text,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    console.warn('[plans] complete_step completion acknowledgment failed/timed out, omitting it:', {
      threadId,
      error: (error as Error)?.message,
    });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `createPlansRouter`: `POST /select/:ideaId` (AC: lazy create-or-fetch —
 * AD-13) and `GET /:planId/current-step` (AD-4's sole steps-read path, used
 * directly as a plain read here — same Boundary precedent as
 * `ideas.ts`/`get_current_step` never being a second write path).
 */
export function createPlansRouter({ env, db, agent, model, createDraft, activatePlanGraph, classify: classifyOverride }: PlansRouterDeps) {
  const router = Router();
  // Intent/Code Map: "create_plan is LLM-backed and cost-bearing like
  // generate_ideas's POST; reuse the same strict tier."
  const strictLimiter = createStrictRateLimiter(env, { limit: 40 });
  // AD-11: same `defaultClassify(env)` real-Mistral-call precedent as
  // `intake.ts`'s own router.
  const classify = classifyOverride ?? defaultClassify(env);
  // Live-bug fix (user-reported, measured live: two real model calls for one
  // plan selection): the `existingPlan` DB check below has a race window —
  // two concurrent requests for the same idea can both pass it before
  // either's `handleCreatePlan` insert commits. `isUniqueViolationError`
  // (below) already makes the *row* idempotent (the loser's insert fails,
  // recovered to return the winner's row) but does nothing about the
  // *model call* — both still ran one. This in-process map makes a second
  // concurrent request for the same idea await the first's already in-
  // flight call instead of starting its own.
  const inFlightCreations = new Map<string, Promise<PlanResponse>>();

  router.post('/select/:ideaId', strictLimiter, async (req, res) => {
    const userId = req.session.userId!;
    const ideaIdParse = z.uuid().safeParse(req.params.ideaId);
    if (!ideaIdParse.success) {
      res.status(400).json({ error: 'Bad request' });
      return;
    }
    const ideaId = ideaIdParse.data;

    // Same request-scoped abort pattern as `ideas.ts`'s `POST /generate` —
    // a client disconnect aborts the in-flight `create_plan` call rather
    // than letting it keep running for a caller that's already gone.
    const abortController = new AbortController();
    const onClientDisconnect = () => abortController.abort(new Error('create_plan: client disconnected'));
    req.on('close', onClientDisconnect);

    try {
      // I/O matrix: "Idea not owned by user / unselected idea" -> 404, no
      // plan created. `create_plan` runs lazily only for a `selected` or
      // `bookmarked` idea (AD-13) — `suggested`/`rejected` are never a
      // valid target.
      const [idea] = await db
        .select({ status: ideas.status })
        .from(ideas)
        .where(and(eq(ideas.id, ideaId), eq(ideas.userId, userId)))
        .limit(1);
      if (!idea || (idea.status !== 'selected' && idea.status !== 'bookmarked')) {
        res.status(404).json({ error: 'Idea not found' });
        return;
      }

      // I/O matrix: "Re-open, plan exists" -> existing row returned,
      // `create_plan` never re-invoked (Boundary: "exactly one plans row
      // per idea"). Story 3.3/AD-13: a `paused` plan resumes (pausing
      // whatever else is currently active) rather than being returned
      // as-is — `draft`/`active`/`completed` are returned unchanged, same
      // as before this story.
      const [existingPlan] = await db.select().from(plans).where(eq(plans.ideaId, ideaId)).limit(1);
      if (existingPlan) {
        if (existingPlan.status === 'paused') {
          res.json(await resumePausedPlan(db, existingPlan.id, userId));
          return;
        }
        res.json(toPlanResponse(existingPlan));
        return;
      }

      // Live-bug fix: a second concurrent request for this same idea awaits
      // the first's already in-flight creation instead of starting its own
      // model call — and skips seeding the plan thread's welcome message
      // below entirely, since the first request's own flow already does
      // that exactly once (doing it twice would insert the fixed welcome
      // message into the thread history twice, since `AIMessage`s with no
      // explicit `id` are appended, not deduped, by the checkpointer).
      const existingCreation = inFlightCreations.get(ideaId);
      if (existingCreation) {
        res.json(await existingCreation);
        return;
      }

      // I/O matrix: "First selection, no plan" -> `create_plan` runs once,
      // on its own new plan thread (AD-18) — `planId` is minted here,
      // before any row exists, so the real `plan:${planId}` thread id can be
      // built ahead of the write `create_plan` itself performs.
      const planId = randomUUID();
      const replyLanguage = await detectUserReplyLanguage(agent, buildDiscoveryThreadId(userId));

      // Story 2.10: `handleCreatePlan` called directly — the same exported
      // function `create_plan.ts`'s own tool wrapper calls, same `Deps`/
      // `Config`/`Args` shape, no `agent.invoke` around it. There is no
      // server-authored trigger message to moderate/force a tool choice for
      // anymore (AC3) — `skipInputModeration`/`forceToolChoice` were only
      // ever needed for the agent-loop trigger this replaces.
      const creation = handleCreatePlan(
        { db, model, createDraft },
        { configurable: { planId, ideaId, userId }, signal: abortController.signal },
        { replyLanguage },
      ).finally(() => {
        inFlightCreations.delete(ideaId);
      });
      inFlightCreations.set(ideaId, creation);
      const createdPlanResponse = await creation;

      // Bug fix (user-reported): seed the real plan thread with a fixed
      // welcome message now that the plan actually exists — the user's
      // first sight of this thread, never the raw trigger text the old
      // agent-loop path used to send.
      await agent.updateState(
        { configurable: { thread_id: buildPlanThreadId(planId) } },
        { messages: [new AIMessage(replyLanguage === 'de' ? PLAN_READY_MESSAGE_DE : PLAN_READY_MESSAGE_EN)] },
      );

      res.json(createdPlanResponse);
    } catch (error) {
      if (isUniqueViolationError(error)) {
        // The race above: some other request's `create_plan` won — re-read
        // and return that row instead of reporting a false failure.
        const [winningPlan] = await db.select().from(plans).where(eq(plans.ideaId, ideaId)).limit(1);
        if (winningPlan) {
          res.json(toPlanResponse(winningPlan));
          return;
        }
      }
      console.error('[plans] select failed:', { userId, ideaId, error: (error as Error)?.message });
      if (!res.headersSent) res.status(502).json({ error: 'Plan could not be generated' });
    } finally {
      req.off('close', onClientDisconnect);
    }
  });

  /**
   * Story 2.9 — the sidebar's "My plans" list: one row per idea that has a
   * plan, scoped to this session's user, joined to that idea's own title
   * (Boundary: never a second "fetch the idea too" round trip from the
   * client). "Sorted by last activity" (AC) — `plans.updatedAt`, the same
   * column `activate_plan.ts`'s transactions already bump.
   *
   * Bug fix (user-reported, live): excludes a plan whose idea is now
   * `rejected` — `set_idea_status.ts` now refuses to create this
   * combination going forward (`IdeaHasPlanError`), but this filter stays
   * as the defensive read-side guard (and covers any row that predates that
   * fix). Without it, the plan stayed listed here forever while
   * `POST /api/plans/select/:ideaId` already 404s for a non-`selected`/
   * `bookmarked` idea — permanently inaccessible but still shown.
   */
  router.get('/', async (req, res) => {
    const userId = req.session.userId!;

    try {
      // Story 2.9 AC (updated): "a stable order that never changes just
      // because the user switches plans" — sorted by `createdAt` (newest
      // first), never `updatedAt` (which every activation/pause/step action
      // touches, and used to reshuffle this list on every switch).
      const rows = await db
        .select({ id: plans.id, ideaId: plans.ideaId, status: plans.status, updatedAt: plans.updatedAt, ideaTitle: ideas.title })
        .from(plans)
        .innerJoin(ideas, eq(ideas.id, plans.ideaId))
        .where(and(eq(plans.userId, userId), ne(ideas.status, 'rejected')))
        .orderBy(desc(plans.createdAt));

      res.json(
        planListResponseSchema.parse({
          plans: rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() })),
        }),
      );
    } catch (error) {
      console.error('[plans] list failed:', { userId, error: (error as Error)?.message });
      res.status(503).json({ error: 'Service unavailable' });
    }
  });

  /**
   * Story 4.1 (AC, follow-up): user-scoped, never plan-scoped — "already
   * answered today" for the energy pop-up, computed across every plan
   * (`getCheckInStatus`). A single literal path segment, never collides
   * with `/:planId/...` below regardless of registration order.
   */
  router.get('/check-in-status', async (req, res) => {
    const userId = req.session.userId!;

    try {
      const result = await getCheckInStatus(db, userId);
      res.json(checkInStatusResponseSchema.parse(result));
    } catch (error) {
      console.error('[plans] check-in-status read failed:', { userId, error: (error as Error)?.message });
      res.status(503).json({ error: 'Service unavailable' });
    }
  });

  router.get('/:planId/current-step', async (req, res) => {
    const userId = req.session.userId!;
    const planIdParse = z.uuid().safeParse(req.params.planId);
    if (!planIdParse.success) {
      res.status(400).json({ error: 'Bad request' });
      return;
    }

    try {
      const [plan] = await db.select({ userId: plans.userId }).from(plans).where(eq(plans.id, planIdParse.data)).limit(1);
      if (!plan || plan.userId !== userId) {
        res.status(404).json({ error: 'Plan not found' });
        return;
      }

      const result = await getCurrentStep(db, planIdParse.data);
      res.json(currentStepResponseSchema.parse(result));
    } catch (error) {
      console.error('[plans] current-step read failed:', { userId, planId: planIdParse.data, error: (error as Error)?.message });
      res.status(503).json({ error: 'Service unavailable' });
    }
  });

  /**
   * Story 4.4 (AD-4/AD-6/AD-27): direct, user-scoped read of the plan's
   * live income/opportunity projection — a plain deterministic read via
   * `getProjection`, same ownership-check precedent as `/:planId/current-step`
   * above. `currency` is the user's own display-currency setting
   * (`user_settings.currency`), read fresh on every call; `estimate` stays
   * in its sourced currency (Boundary) — conversion/formatting happen
   * client-side via `shared/money.ts` (same pattern `GET /api/ideas` uses).
   */
  router.get('/:planId/projection', async (req, res) => {
    const userId = req.session.userId!;
    const planIdParse = z.uuid().safeParse(req.params.planId);
    if (!planIdParse.success) {
      res.status(400).json({ error: 'Bad request' });
      return;
    }
    const planId = planIdParse.data;

    try {
      if (!(await isPlanOwnedByUser(db, planId, userId))) {
        res.status(404).json({ error: 'Plan not found' });
        return;
      }

      const [settingsRow, data] = await Promise.all([getUserSettings(db, userId), getProjection(db, planId)]);

      res.json(projectionResponseSchema.parse({ ...data, currency: resolveCurrency(settingsRow?.currency) }));
    } catch (error) {
      console.error('[plans] projection read failed:', { userId, planId, error: (error as Error)?.message });
      res.status(503).json({ error: 'Service unavailable' });
    }
  });

  /**
   * Story 4.1 (AD-4/AD-11): direct, UI-button check-in — a plain Postgres
   * write via `recordCheckIn`, never through the agent loop. `note` is this
   * route's one new user-authored free text, moderated here before it's
   * stored (same `evaluateUserMessage` precedent as `/:planId/activate/reject`'s
   * `feedback`); a chat-typed check-in instead goes through the agent's own
   * `beforeModel` moderation of the triggering message, never this route.
   */
  router.post('/:planId/check-in', async (req, res) => {
    const userId = req.session.userId!;
    const planIdParse = z.uuid().safeParse(req.params.planId);
    const bodyParse = recordCheckInRequestSchema.safeParse(req.body);
    if (!planIdParse.success || !bodyParse.success) {
      res.status(400).json({ error: 'Bad request' });
      return;
    }
    const planId = planIdParse.data;

    try {
      if (!(await isPlanOwnedByUser(db, planId, userId))) {
        res.status(404).json({ error: 'Plan not found' });
        return;
      }

      let args = bodyParse.data;
      if (args.note) {
        const verdict = await evaluateUserMessage(args.note, classify, buildPlanThreadId(planId));
        if (verdict.action === 'reject') {
          res.status(502).json({ error: 'Note could not be processed' });
          return;
        }
        if (verdict.action === 'redact') {
          args = { ...args, note: verdict.content };
        }
      }

      const result = await recordCheckIn(db, planId, args);
      res.json(checkInResponseSchema.parse(result));
    } catch (error) {
      console.error('[plans] check-in failed:', { userId, planId, error: (error as Error)?.message });
      res.status(502).json({ error: 'Check-in could not be recorded' });
    }
  });

  /**
   * Story 4.1 (AD-13 state-machine rule): direct, UI-button start/complete
   * of the plan's current step — both reject with a 409 when `stepId` isn't
   * the plan's own current step, the same tool-level rejection the agent's
   * own `start_step`/`complete_step` tool calls enforce (AC: "the tool
   * itself rejects the call, not just a UI-level guard"). Bug fix
   * (user-reported, live): also 409s when the plan itself isn't `active`
   * yet (`PlanNotActiveError`) — a `draft` plan awaiting review must not
   * let its current step be started/completed early.
   *
   * Perf fix (user-reported, live): used to also run the AC8 chat
   * acknowledgment inline (language detection + the direct model call +
   * moderation), making this one response wait on all of it — ~2-3s on the
   * default model for what the status panel only needs the plain DB write
   * for. The acknowledgment is now `POST .../start-ack` below, fired by the
   * frontend right after this response lands instead of before it — this
   * route is the DB write alone.
   */
  router.post('/:planId/steps/:stepId/start', async (req, res) => {
    const userId = req.session.userId!;
    const planIdParse = z.uuid().safeParse(req.params.planId);
    const stepIdParse = z.uuid().safeParse(req.params.stepId);
    if (!planIdParse.success || !stepIdParse.success) {
      res.status(400).json({ error: 'Bad request' });
      return;
    }
    const planId = planIdParse.data;

    try {
      if (!(await isPlanOwnedByUser(db, planId, userId))) {
        res.status(404).json({ error: 'Plan not found' });
        return;
      }

      const result = await startStep(db, planId, stepIdParse.data);
      res.json(startStepResponseSchema.parse(result));
    } catch (error) {
      if (error instanceof StepNotCurrentError) {
        res.status(409).json({ error: 'Step is not this plan\'s current step' });
        return;
      }
      if (error instanceof PlanNotActiveError) {
        res.status(409).json({ error: 'Plan is not active yet' });
        return;
      }
      console.error('[plans] start_step failed:', { userId, planId, error: (error as Error)?.message });
      res.status(502).json({ error: 'Step could not be started' });
    }
  });

  /**
   * Perf fix (user-reported, live), split out of `/:planId/steps/:stepId/start`
   * above: the AC8 chat acknowledgment itself (language detection + one
   * direct, non-agentic model call + moderation) — the frontend fires this
   * right after `/start` responds instead of waiting on it, so the status
   * panel flips to "started" immediately and this message trails in once
   * it's ready. Fully fail-open, same as before the split (see
   * `buildStartStepAckMessage`'s own doc comment): any failure here —
   * including the step no longer existing on this plan — responds `200`
   * with no `chatMessage` rather than an error, since the step itself
   * already started successfully via the other route regardless of what
   * happens here.
   */
  router.post('/:planId/steps/:stepId/start-ack', async (req, res) => {
    const userId = req.session.userId!;
    const planIdParse = z.uuid().safeParse(req.params.planId);
    const stepIdParse = z.uuid().safeParse(req.params.stepId);
    if (!planIdParse.success || !stepIdParse.success) {
      res.status(400).json({ error: 'Bad request' });
      return;
    }
    const planId = planIdParse.data;

    try {
      if (!(await isPlanOwnedByUser(db, planId, userId))) {
        res.status(404).json({ error: 'Plan not found' });
        return;
      }

      // The step's own title is re-read here, never taken from the client —
      // the title flows straight into the model prompt below (`buildStartStep
      // AckPrompt`), so trusting a client-supplied value would let it inject
      // arbitrary text into that prompt.
      const [step] = await db
        .select({ title: planSteps.title })
        .from(planSteps)
        .where(and(eq(planSteps.id, stepIdParse.data), eq(planSteps.planId, planId)))
        .limit(1);
      if (!step) {
        res.json(startStepAckResponseSchema.parse({}));
        return;
      }

      // Review fix: the reply language is detected from the *discovery*
      // thread (same `detectUserReplyLanguage` call this file's own
      // plan-creation welcome message already uses, Code Map line 221), not
      // the plan thread itself — a user who hasn't yet typed anything into
      // this specific plan's chat would otherwise always fall back to 'en'
      // even though their discovery answers were in German.
      const threadId = buildPlanThreadId(planId);
      // Independent of each other — run concurrently rather than one after
      // another (this is exactly the latency this split exists to cut).
      const [replyLanguage, recentAckMessages] = await Promise.all([
        detectUserReplyLanguage(agent, buildDiscoveryThreadId(userId)),
        // Bug fix (user-reported, live): this thread's own previous start
        // acknowledgments, quoted back to the model as a no-repeat rule
        // (`buildStartStepAckMessage`'s own doc comment).
        getRecentAckTexts(agent, threadId, START_STEP_ACK_HISTORY_LIMIT, STEP_START_ACK_KWARG),
      ]);
      let chatMessage = await buildStartStepAckMessage(model, classify, threadId, replyLanguage, step.title, recentAckMessages);
      if (chatMessage) {
        try {
          await agent.updateState(
            { configurable: { thread_id: threadId } },
            { messages: [new AIMessage({ id: chatMessage.id, content: chatMessage.content, additional_kwargs: { [STEP_START_ACK_KWARG]: true } })] },
          );
        } catch (error) {
          // Fail open, same as every other branch of this best-effort
          // extra — the step itself already started successfully via the
          // other route; never persisting the acknowledgment is reason to
          // drop it from the response, never to fail the whole request.
          console.error('[plans] start_step acknowledgment persistence failed:', { userId, planId, error: (error as Error)?.message });
          chatMessage = undefined;
        }
      }

      res.json(startStepAckResponseSchema.parse({ chatMessage }));
    } catch (error) {
      // Fail-open: an error here never surfaces as a failure — the step
      // itself already started, this is a best-effort extra.
      console.error('[plans] start_step acknowledgment failed:', { userId, planId, error: (error as Error)?.message });
      res.json(startStepAckResponseSchema.parse({}));
    }
  });

  /**
   * Story 4.6 (perf fix, mirroring `/:planId/steps/:stepId/start`'s own
   * precedent exactly): used to also run the completion chat
   * acknowledgment inline (language detection + the direct model call +
   * moderation), making this one response wait on all of it. The
   * acknowledgment is now `POST .../complete-ack` below, fired by the
   * frontend right after this response lands instead of before it — this
   * route is the DB write alone.
   */
  router.post('/:planId/steps/:stepId/complete', async (req, res) => {
    const userId = req.session.userId!;
    const planIdParse = z.uuid().safeParse(req.params.planId);
    const stepIdParse = z.uuid().safeParse(req.params.stepId);
    if (!planIdParse.success || !stepIdParse.success) {
      res.status(400).json({ error: 'Bad request' });
      return;
    }
    const planId = planIdParse.data;

    try {
      if (!(await isPlanOwnedByUser(db, planId, userId))) {
        res.status(404).json({ error: 'Plan not found' });
        return;
      }

      const result = await completeStep(db, planId, stepIdParse.data);
      res.json(completeStepResponseSchema.parse(result));
    } catch (error) {
      if (error instanceof StepNotCurrentError) {
        res.status(409).json({ error: 'Step is not this plan\'s current step' });
        return;
      }
      if (error instanceof PlanNotActiveError) {
        res.status(409).json({ error: 'Plan is not active yet' });
        return;
      }
      console.error('[plans] complete_step failed:', { userId, planId, error: (error as Error)?.message });
      res.status(502).json({ error: 'Step could not be completed' });
    }
  });

  /**
   * Story 4.6, split out of `/:planId/steps/:stepId/complete` above (same
   * perf fix as `/start-ack`): one direct model call produces a completion
   * message on every successful `complete_step` — the plan's own distinct
   * "whole plan is done" message on the final step, or an encouraging
   * per-step one otherwise, never both (AC: "when the completed step is the
   * plan's last one, do not add a second message") — fully fail-open (see
   * `buildPlanCompletionAckMessage`'s/`buildStepCompletionAckMessage`'s own
   * doc comments), so nothing here can turn a successful completion into an
   * error response; the fixed `stepActions.planCompletedHint` the UI
   * already shows regardless is the fallback. `planCompleted` is re-derived
   * from the plan's own current status here, never taken from the client —
   * same "never trust client input flowing into the model prompt" posture
   * as `/start-ack`'s own re-read of the step title.
   */
  router.post('/:planId/steps/:stepId/complete-ack', async (req, res) => {
    const userId = req.session.userId!;
    const planIdParse = z.uuid().safeParse(req.params.planId);
    const stepIdParse = z.uuid().safeParse(req.params.stepId);
    if (!planIdParse.success || !stepIdParse.success) {
      res.status(400).json({ error: 'Bad request' });
      return;
    }
    const planId = planIdParse.data;

    try {
      if (!(await isPlanOwnedByUser(db, planId, userId))) {
        res.status(404).json({ error: 'Plan not found' });
        return;
      }

      const [step] = await db
        .select({ title: planSteps.title, stepOrder: planSteps.stepOrder })
        .from(planSteps)
        .where(and(eq(planSteps.id, stepIdParse.data), eq(planSteps.planId, planId)))
        .limit(1);
      if (!step) {
        res.json(completeStepAckResponseSchema.parse({}));
        return;
      }
      const [plan] = await db.select({ status: plans.status }).from(plans).where(eq(plans.id, planId)).limit(1);
      const planCompleted = plan?.status === 'completed';

      const threadId = buildPlanThreadId(planId);
      const replyLanguage = await detectUserReplyLanguage(agent, buildDiscoveryThreadId(userId));
      const ackKwarg = planCompleted ? PLAN_COMPLETION_ACK_KWARG : STEP_COMPLETION_ACK_KWARG;
      let chatMessage: ChatMessage | undefined;
      if (planCompleted) {
        const recentAckMessages = await getRecentAckTexts(agent, threadId, START_STEP_ACK_HISTORY_LIMIT, STEP_START_ACK_KWARG);
        chatMessage = await buildPlanCompletionAckMessage(model, classify, threadId, replyLanguage, step.title, step.stepOrder + 1, recentAckMessages);
      } else {
        // User-requested: "also send an encouraging message when the user
        // completes a task" — own no-repeat history, distinct from the
        // start-step ack's, so a completion message never reuses an
        // earlier completion's opener/wording (same guarantee the start
        // ack already has).
        const recentAckMessages = await getRecentAckTexts(agent, threadId, START_STEP_ACK_HISTORY_LIMIT, STEP_COMPLETION_ACK_KWARG);
        chatMessage = await buildStepCompletionAckMessage(model, classify, threadId, replyLanguage, step.title, recentAckMessages);
      }
      if (chatMessage) {
        try {
          await agent.updateState(
            { configurable: { thread_id: threadId } },
            { messages: [new AIMessage({ id: chatMessage.id, content: chatMessage.content, additional_kwargs: { [ackKwarg]: true } })] },
          );
        } catch (error) {
          // Fail open, same as every other branch of this best-effort
          // extra — the step itself already completed successfully via the
          // other route; never persisting the acknowledgment is reason to
          // drop it from the response, never to fail the whole request.
          console.error('[plans] complete_step acknowledgment persistence failed:', { userId, planId, error: (error as Error)?.message });
          chatMessage = undefined;
        }
      }

      res.json(completeStepAckResponseSchema.parse({ chatMessage }));
    } catch (error) {
      // Fail-open: an error here never surfaces as a failure — the step
      // itself already completed, this is a best-effort extra.
      console.error('[plans] complete_step acknowledgment failed:', { userId, planId, error: (error as Error)?.message });
      res.json(completeStepAckResponseSchema.parse({}));
    }
  });

  /**
   * Story 3.2 (AD-14): "the UI buttons call a route that resumes the paused
   * graph or the equivalent direct handler". `confirm`/`modify`/`reject` all
   * resolve the same way — a `Command({ resume: decision })` invocation of
   * the one dedicated `activatePlanGraph` on this plan's own activation
   * thread — mapping its own thrown error types to the right status instead
   * of the generic 502 every other route's catch block uses.
   */
  async function resumeActivation(req: Request, res: Response, decisionInput: unknown) {
    const userId = req.session.userId!;
    const planIdParse = z.uuid().safeParse(req.params.planId);
    const decisionParse = activatePlanDecisionSchema.safeParse(decisionInput);
    if (!planIdParse.success || !decisionParse.success) {
      res.status(400).json({ error: 'Bad request' });
      return;
    }
    const planId = planIdParse.data;

    try {
      if (!(await isPlanOwnedByUser(db, planId, userId))) {
        res.status(404).json({ error: 'Plan not found' });
        return;
      }

      const pending = await getPendingReview(activatePlanGraph, planId);
      if (!pending) {
        res.status(409).json({ error: 'No activation review is pending for this plan' });
        return;
      }

      // AD-11 (Part 2, user-requested): reject's `feedback` is this story's
      // one new user-authored free text — it flows into `create_plan`'s
      // nested model prompt (`handleRegeneratePlanDraft`), so it must pass
      // through moderation first, same direct-call precedent as
      // `intake.ts`'s own free-text fields (jailbreak -> reject the turn,
      // PII -> redact and continue). Confirm/modify carry no free text, so
      // this only ever runs for `action === 'reject'`.
      let decision = decisionParse.data;
      if (decision.action === 'reject') {
        const verdict = await evaluateUserMessage(decision.feedback, classify, buildPlanActivationThreadId(planId));
        if (verdict.action === 'reject') {
          res.status(502).json({ error: 'Feedback could not be processed' });
          return;
        }
        if (verdict.action === 'redact') {
          decision = { ...decision, feedback: verdict.content };
        }
      }

      const result = await activatePlanGraph.invoke(new Command({ resume: decision }), {
        configurable: { thread_id: buildPlanActivationThreadId(planId), planId, userId },
      });
      res.json(planResponseSchema.parse((result as { result?: PlanResponse }).result));
    } catch (error) {
      if (error instanceof PlanNotFoundError) {
        res.status(404).json({ error: 'Plan not found' });
        return;
      }
      if (error instanceof PlanNotDraftError) {
        res.status(409).json({ error: 'Plan is not a draft' });
        return;
      }
      console.error('[plans] activation resume failed:', { userId, planId, error: (error as Error)?.message });
      res.status(502).json({ error: 'Plan activation could not be processed' });
    }
  }

  router.post('/:planId/activate', strictLimiter, async (req, res) => {
    const userId = req.session.userId!;
    const planIdParse = z.uuid().safeParse(req.params.planId);
    if (!planIdParse.success) {
      res.status(400).json({ error: 'Bad request' });
      return;
    }
    const planId = planIdParse.data;

    try {
      if (!(await isPlanOwnedByUser(db, planId, userId))) {
        res.status(404).json({ error: 'Plan not found' });
        return;
      }

      // Idempotent: a re-click/retry while a review is already paused just
      // returns that same pending review instead of starting a second run
      // against the same thread (which LangGraph rejects).
      const existing = await getPendingReview(activatePlanGraph, planId);
      if (existing) {
        res.json(existing);
        return;
      }

      await activatePlanGraph.invoke(
        {},
        { configurable: { thread_id: buildPlanActivationThreadId(planId), planId, userId } },
      );

      const review = await getPendingReview(activatePlanGraph, planId);
      if (!review) {
        throw new Error('activate_plan: graph run completed without pausing for review');
      }
      res.json(review);
    } catch (error) {
      if (error instanceof PlanNotFoundError) {
        res.status(404).json({ error: 'Plan not found' });
        return;
      }
      if (error instanceof PlanNotDraftError) {
        res.status(409).json({ error: 'Plan is not a draft' });
        return;
      }
      console.error('[plans] activation request failed:', { userId, planId, error: (error as Error)?.message });
      res.status(502).json({ error: 'Plan activation could not be started' });
    }
  });

  router.get('/:planId/activate', async (req, res) => {
    const userId = req.session.userId!;
    const planIdParse = z.uuid().safeParse(req.params.planId);
    if (!planIdParse.success) {
      res.status(400).json({ error: 'Bad request' });
      return;
    }
    const planId = planIdParse.data;

    try {
      if (!(await isPlanOwnedByUser(db, planId, userId))) {
        res.status(404).json({ error: 'Plan not found' });
        return;
      }

      const review = await getPendingReview(activatePlanGraph, planId);
      res.json({ review });
    } catch (error) {
      console.error('[plans] activation review read failed:', { userId, planId, error: (error as Error)?.message });
      res.status(503).json({ error: 'Service unavailable' });
    }
  });

  router.post('/:planId/activate/confirm', strictLimiter, async (req, res) => {
    await resumeActivation(req, res, { action: 'confirm' });
  });

  router.post('/:planId/activate/modify', strictLimiter, async (req, res) => {
    await resumeActivation(req, res, { action: 'modify', draft: (req.body as { draft?: unknown } | undefined)?.draft });
  });

  router.post('/:planId/activate/reject', strictLimiter, async (req, res) => {
    await resumeActivation(req, res, { action: 'reject', feedback: (req.body as { feedback?: unknown } | undefined)?.feedback });
  });

  return router;
}
