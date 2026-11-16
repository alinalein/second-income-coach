import { setPersonalityRequestSchema, type Personality } from '@app/shared';
import type { createDb } from '../../db/client.js';
import { updatePersonality as updatePersonalityInDb } from '../../db/settings-repository.js';

type Db = ReturnType<typeof createDb>['db'];

export interface SetPersonalityDeps {
  /** Test-only seam (same DI pattern as `createModerationMiddleware`'s
   * `classify`): a fake write instead of a real Drizzle update. */
  updatePersonality?: typeof updatePersonalityInDb;
}

/**
 * AD-4/AD-20: `set_personality` as a plain deterministic Postgres write —
 * never registered as an agent-callable LangChain tool (unlike AD-4's other
 * "plain-code" tools, e.g. `submit_intake`). The only caller is
 * `POST /api/settings/personality` (`src/api/routes/settings.ts`), itself
 * only reachable through the settings screen's own API call — the agent has
 * no path to invoke this (AC: "only ever called via the settings UI's API
 * calls").
 */
export async function setPersonality(
  db: Db,
  userId: string,
  personality: Personality,
  deps: SetPersonalityDeps = {},
): Promise<void> {
  const parsed = setPersonalityRequestSchema.parse({ personality });
  const updatePersonality = deps.updatePersonality ?? updatePersonalityInDb;
  await updatePersonality(db, userId, parsed.personality);
}
