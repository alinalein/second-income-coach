import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { ideas } from './ideas.js';

/**
 * Story 3.1 (AD-4/AD-13/AD-18): one row per idea's plan. `ideaId` is a
 * *unique* FK (Boundary: "Exactly one `plans` row per idea (DB unique
 * constraint)") — `create_plan` runs lazily, at most once per idea
 * (AD-13: "a given idea has at most one plan row at any time"). `status`
 * stays plain `text()` (no `pgEnum`/check constraint — same no-`pgEnum`
 * precedent as `ideas.status`/`intake.failurePattern`), validated only at
 * the Zod layer (`shared/schemas/plans.ts`'s `planStatusSchema`):
 * `draft` (this story) -> `active` | `paused` (Story 3.2) -> `completed`
 * (Epic 4). `threadId` is always `plan:${id}` (AD-18, `buildPlanThreadId`,
 * `src/agent/index.ts`) — stored (not recomputed from `id` everywhere) so a
 * row's own thread is explicit at the DB layer too.
 */
export const plans = pgTable(
  'plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ideaId: uuid('idea_id')
      .notNull()
      .unique()
      .references(() => ideas.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    status: text('status').notNull().default('draft'),
    threadId: text('thread_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Story 4.2 (AD-15): the single anchor `get_current_step`'s gap
     * detection measures elapsed time from — reset to "now" by
     * `record_check_in` (a real check-in) and by `get_current_step` itself
     * once it applies a gap's timeline shift (so the same gap is never
     * shifted twice). `null` for a plan that was never checked into yet —
     * code falls back to `createdAt` in that case.
     */
    timelineAnchorAt: timestamp('timeline_anchor_at', { withTimezone: true }),
  },
  // Story 3.2 (AD-14): "exactly one plan is active per user" enforced at the
  // DB layer via a partial unique index, never only in application code —
  // the `activate_plan` transaction (`src/tools/plain/activate_plan.ts`)
  // pauses any previously-active plan *before* activating the new one in the
  // same transaction, so this index is never hit as a real conflict in the
  // normal confirm path; it's the backstop against a logic bug, not the
  // primary mechanism.
  (table) => [uniqueIndex('plans_one_active_per_user_idx').on(table.userId).where(sql`${table.status} = 'active'`)],
);

/**
 * One row per ordered step of a plan (Code Map: "ordered steps with a
 * timeline"). `status` is plain `text()` (no `pgEnum`, same precedent as
 * `plans.status` above): `pending` -> `current` -> `completed` (`complete_step`,
 * Epic 4, is what advances this — out of scope for this story, which only
 * ever writes the initial `current`/`pending` split on insert).
 * `get_current_step` (`src/tools/plain/get_current_step.ts`) is the sole
 * path reading this table (AD-4) — capped to the `current`-status row plus
 * the next `stepOrder`, never the full list.
 *
 * `description` (UI fix, user-reported): a Postgres text array — 1-5
 * distinct, concrete actions rendered as a bullet list (`StatusPanel.tsx`),
 * never one prose paragraph — same array-column precedent as
 * `ideas.citedIntakeFields`.
 */
export const planSteps = pgTable('plan_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  planId: uuid('plan_id')
    .notNull()
    .references(() => plans.id),
  stepOrder: integer('step_order').notNull(),
  title: text('title').notNull(),
  description: text('description').array().notNull(),
  dayOffset: integer('day_offset').notNull(),
  status: text('status').notNull().default('pending'),
  /** Story 4.1 (AD-4): set by `start_step` when the user starts acting on
   * this step while it's `current` — `null` until then. */
  startedAt: timestamp('started_at', { withTimezone: true }),
});
