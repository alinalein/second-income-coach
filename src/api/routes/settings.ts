import { Router } from 'express';
import { settingsResponseSchema, setPersonalityRequestSchema, setModelRequestSchema } from '@app/shared';
import type { Env } from '../../config/env.js';
import type { createDb } from '../../db/client.js';
import { getUserSettings } from '../../db/settings-repository.js';
import { resolvePersonality } from '../../agent/personality.js';
import { resolveModelId, listSelectableModels } from '../../agent/registry.js';
import { setPersonality } from '../../tools/plain/set_personality.js';
import { setModel, UnselectableModelError } from '../../tools/plain/set_model.js';

export interface SettingsRouterDeps {
  env: Pick<Env, 'OPENROUTER_API_KEY' | 'MISTRAL_API_KEY'>;
  db: ReturnType<typeof createDb>['db'];
}

/**
 * `createSettingsRouter`: the settings screen's backend for Story 5.1
 * (personality + model; `set_ui_language`/`set_currency` land with Stories
 * 5.4/5.5 on this same table and, presumably, this same router). Relies on
 * the blanket `requireAuth` gate already applied in `app.ts` before this
 * router is mounted, same as `createChatRouter`.
 */
export function createSettingsRouter({ env, db }: SettingsRouterDeps) {
  const router = Router();

  router.get('/', async (req, res) => {
    const userId = req.session.userId!;
    const settings = await getUserSettings(db, userId);

    res.json(
      settingsResponseSchema.parse({
        // AC: "an unknown or no-longer-selectable id resolves to the
        // default model rather than erroring" — the settings screen must
        // never display a stale id as the current selection either.
        personality: resolvePersonality(settings?.personality),
        model: resolveModelId(settings?.model),
        // AC: "pricing ... is read from the registry, never a hardcoded
        // value" — `listSelectableModels` is the registry itself, filtered.
        selectableModels: listSelectableModels(env),
      }),
    );
  });

  router.post('/personality', async (req, res) => {
    const parseResult = setPersonalityRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ error: 'Bad request' });
      return;
    }

    await setPersonality(db, req.session.userId!, parseResult.data.personality);
    res.status(204).end();
  });

  router.post('/model', async (req, res) => {
    const parseResult = setModelRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ error: 'Bad request' });
      return;
    }

    try {
      await setModel(db, env, req.session.userId!, parseResult.data.model);
      res.status(204).end();
    } catch (error) {
      if (error instanceof UnselectableModelError) {
        res.status(400).json({ error: 'Bad request' });
        return;
      }
      throw error;
    }
  });

  return router;
}
