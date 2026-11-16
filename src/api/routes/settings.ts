import { Router } from 'express';
import {
  settingsResponseSchema,
  setPersonalityRequestSchema,
  setModelRequestSchema,
  setUiLanguageRequestSchema,
  resolveUiLanguage,
} from '@app/shared';
import type { Env } from '../../config/env.js';
import type { createDb } from '../../db/client.js';
import { getUserSettings } from '../../db/settings-repository.js';
import { resolvePersonality } from '../../agent/personality.js';
import { resolveModelId, listSelectableModels } from '../../agent/registry.js';
import { setPersonality } from '../../tools/plain/set_personality.js';
import { setModel, UnselectableModelError } from '../../tools/plain/set_model.js';
import { setUiLanguage } from '../../tools/plain/set_ui_language.js';

export interface SettingsRouterDeps {
  env: Pick<Env, 'OPENROUTER_API_KEY' | 'MISTRAL_API_KEY'>;
  db: ReturnType<typeof createDb>['db'];
}

/**
 * `createSettingsRouter`: the settings screen's backend, covering Story 5.1
 * (personality + model) and Story 5.4 (UI language; `set_currency` lands
 * with Story 5.5 on this same table and router). Relies on the blanket
 * `requireAuth` gate already applied in `app.ts` before this router is
 * mounted, same as `createChatRouter`.
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
        // AC2: "a first-time visit with no stored preference -> defaults to
        // English" — never browser-detected (AD-20).
        uiLanguage: resolveUiLanguage(settings?.uiLanguage),
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

  router.post('/ui-language', async (req, res) => {
    const parseResult = setUiLanguageRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ error: 'Bad request' });
      return;
    }

    await setUiLanguage(db, req.session.userId!, parseResult.data.uiLanguage);
    res.status(204).end();
  });

  return router;
}
