import { z } from 'zod';
import { and, eq, ne } from 'drizzle-orm';
import type { createDb } from '../../db/client.js';
import { ideas } from '../../db/schema/index.js';

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

    await tx.update(ideas).set({ status: parsedStatus, updatedAt: new Date() }).where(eq(ideas.id, ideaId));

    if (parsedStatus === 'selected') {
      await tx
        .update(ideas)
        .set({ status: 'bookmarked', updatedAt: new Date() })
        .where(and(eq(ideas.userId, userId), ne(ideas.id, ideaId), ne(ideas.status, 'rejected')));
    }
  });
}
