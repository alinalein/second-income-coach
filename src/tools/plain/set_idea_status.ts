import { z } from 'zod';
import { and, eq, ne } from 'drizzle-orm';
import type { createDb } from '../../db/client.js';
import { ideas, plans } from '../../db/schema/index.js';

type Db = ReturnType<typeof createDb>['db'];

/**
 * AD-4/AD-13: the 3 statuses a user can actively set via this tool —
 * `suggested` is never a settable target (it's only the initial value
 * `generate_ideas` writes), matching `shared/schemas/ideas.ts`'s
 * `ideaStatusSchema` minus that one value. Local to this file (never
 * exported from `@app/shared`) since no other caller needs it — the Boundary
 * says not to touch `shared/schemas/ideas.ts` for this story.
 */
export const settableIdeaStatusSchema = z.enum(['selected', 'bookmarked', 'rejected']);

export type SettableIdeaStatus = z.infer<typeof settableIdeaStatusSchema>;

/** Thrown when `ideaId` doesn't exist, exists but belongs to a different
 * user, or is already `rejected` and the caller is asking for anything
 * other than `rejected` again — a rejected idea is never resurrected, even
 * by a direct request targeting its own id (re-rejecting an already-
 * rejected idea stays a harmless no-op, still allowed). The route
 * (`src/api/routes/ideas.ts`) maps this to 404, same precedent as
 * `set_model.ts`'s `UnselectableModelError` -> 400. */
export class IdeaNotFoundError extends Error {}

/**
 * Bug fix (user-reported, live): an idea that already has a `plans` row
 * (created by `create_plan` once the idea was `selected`/`bookmarked`) could
 * still be rejected — leaving that plan listed in the sidebar's "My plans"
 * (`GET /api/plans`, which never filtered on idea status) but permanently
 * inaccessible, since `POST /api/plans/select/:ideaId` 404s for any idea
 * that isn't `selected`/`bookmarked`. Rejecting such an idea is refused
 * outright now, rather than only hiding the resulting orphan afterward
 * (`plans.ts`'s own `GET /` query, which still filters it defensively). The
 * route (`src/api/routes/ideas.ts`) maps this to 409, same "state conflict"
 * precedent as `activate_plan.ts`'s `PlanNotDraftError`.
 */
export class IdeaHasPlanError extends Error {}

/**
 * AD-4: a plain, deterministic Postgres write — never agent-registered,
 * never LLM-invoked (same boundary precedent as `set_personality`/
 * `set_model`/`set_ui_language`, `src/tools/plain/`). Reachable only via
 * `POST /api/ideas/:id/status` (`src/api/routes/ideas.ts`).
 *
 * Mirrors `src/db/auth-repository.ts`'s `db.transaction(async (tx) => {...})`
 * pattern — the ownership check, the target update, and (for `selected`
 * only) the demote-others sweep all happen inside one transaction, so a
 * concurrent request can never observe a half-applied select.
 *
 * Selecting (`status === 'selected'`) marks the target idea `selected` and
 * every *other* idea owned by the same user that isn't already `rejected`
 * `bookmarked` — an already-`rejected` idea is never resurrected by someone
 * else being selected (Design Notes: the AC's own "5 generated ideas"
 * example only covers the no-rejects-yet case; excluding `rejected` from the
 * sweep is the only reading that can't silently undo a deliberate reject).
 * `bookmarked`/`rejected` only ever touch the one target row — no sweep.
 */
export async function setIdeaStatus(db: Db, userId: string, ideaId: string, status: SettableIdeaStatus): Promise<void> {
  const parsedStatus = settableIdeaStatusSchema.parse(status);

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: ideas.id, status: ideas.status })
      .from(ideas)
      .where(and(eq(ideas.id, ideaId), eq(ideas.userId, userId)))
      .limit(1);

    if (!existing) {
      throw new IdeaNotFoundError(`Idea "${ideaId}" was not found for this user`);
    }

    // A rejected idea is never resurrected — including by a direct request
    // targeting its own id, not just as a side effect of selecting a
    // different idea (the demote sweep below already excludes it).
    // Re-rejecting an already-rejected idea is still allowed as a no-op.
    if (existing.status === 'rejected' && parsedStatus !== 'rejected') {
      throw new IdeaNotFoundError(`Idea "${ideaId}" is rejected and cannot be set to "${parsedStatus}"`);
    }

    if (parsedStatus === 'rejected' && existing.status !== 'rejected') {
      const [existingPlan] = await tx.select({ id: plans.id }).from(plans).where(eq(plans.ideaId, ideaId)).limit(1);
      if (existingPlan) {
        throw new IdeaHasPlanError(`Idea "${ideaId}" already has a plan and cannot be rejected`);
      }
    }

    await tx.update(ideas).set({ status: parsedStatus, updatedAt: new Date() }).where(eq(ideas.id, ideaId));

    if (parsedStatus === 'selected') {
      // User-reported bug fix: exclude an already-`bookmarked` sibling too
      // (not just `rejected`) — it has nothing to change, so skipping it
      // avoids a no-op write that bumps `updatedAt` for no real reason.
      await tx
        .update(ideas)
        .set({ status: 'bookmarked', updatedAt: new Date() })
        .where(and(eq(ideas.userId, userId), ne(ideas.id, ideaId), ne(ideas.status, 'rejected'), ne(ideas.status, 'bookmarked')));
    }
  });
}
