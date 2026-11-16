import { setModelRequestSchema } from '@app/shared';
import type { Env } from '../../config/env.js';
import type { createDb } from '../../db/client.js';
import { updateModel as updateModelInDb } from '../../db/settings-repository.js';
import { listSelectableModels } from '../../agent/registry.js';

type Db = ReturnType<typeof createDb>['db'];

/** Thrown when the requested id isn't a currently selectable chat model —
 * either it's not a `chat`-category registry entry (e.g. the moderation
 * model) or its provider's key isn't configured. Distinct from a Zod parse
 * failure so the route can map it to the same 400 without conflating "bad
 * shape" and "not a valid choice right now". */
export class UnselectableModelError extends Error {}

export interface SetModelDeps {
  /** Test-only seam (same DI pattern as `createModerationMiddleware`'s
   * `classify`): a fake write instead of a real Drizzle update. */
  updateModel?: typeof updateModelInDb;
}

/**
 * AD-4/AD-20: `set_model` as a plain deterministic Postgres write — never
 * agent-callable (same boundary as `set_personality`, see its own comment).
 * Re-validates the id against `listSelectableModels` at the write boundary
 * (AC: "only providers with a configured server-side key appear, and the
 * moderation/transcription models never appear as options") rather than
 * trusting that the settings screen only ever offers a valid choice.
 */
export async function setModel(
  db: Db,
  env: Pick<Env, 'OPENROUTER_API_KEY' | 'MISTRAL_API_KEY'>,
  userId: string,
  model: string,
  deps: SetModelDeps = {},
): Promise<void> {
  const parsed = setModelRequestSchema.parse({ model });
  const selectable = listSelectableModels(env);
  if (!selectable.some((entry) => entry.id === parsed.model)) {
    throw new UnselectableModelError(`"${parsed.model}" is not a currently selectable model`);
  }
  const updateModel = deps.updateModel ?? updateModelInDb;
  await updateModel(db, userId, parsed.model);
}
