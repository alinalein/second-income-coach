import express, { Router } from 'express';
import { voiceTranscribeResponseSchema } from '@app/shared';
import type { Env } from '../../config/env.js';
import { createTranscribeAudio, TranscriptionError, type TranscribeAudio } from '../../agent/voice.js';
import { createStrictRateLimiter } from '../middleware/rateLimit.js';

/** Code Map: "exports MAX_VOICE_AUDIO_BYTES (10MB)" — both this route's own
 * `express.raw` body parser and `app.ts`'s blanket content-length gate
 * (exempting `/api/voice/*` up to this size instead of `env.BODY_LIMIT`)
 * import this one constant. */
export const MAX_VOICE_AUDIO_BYTES = 10 * 1024 * 1024;

export interface VoiceRouterDeps {
  env: Pick<Env, 'RATE_LIMIT_WINDOW_MS' | 'OPENROUTER_API_KEY'>;
  /** Test-only seam: a fake transcription client instead of a real
   * `createTranscribeAudio(env)` (which would otherwise call OpenRouter). */
  transcribeAudio?: TranscribeAudio;
}

/**
 * `createVoiceRouter`: the one backend route wrapping `gpt-transcribe`
 * (Intent). NFR3: `express.raw` buffers exactly this one request's body in
 * memory; it's passed straight to `transcribeAudio` and never persisted —
 * nothing here writes it to the DB, disk, or a log line.
 */
export function createVoiceRouter({ env, transcribeAudio = createTranscribeAudio(env) }: VoiceRouterDeps) {
  const router = Router();
  // Near-live mode (`VoiceInput.tsx`): re-transcribes the growing clip
  // every `CHUNK_INTERVAL_MS` (1.2s) while recording, capped at ~60s of
  // accumulated audio — worst case ~50 interim calls plus the final one
  // inside a single `RATE_LIMIT_WINDOW_MS`. The default strict limit (10)
  // is sized for one-shot cost-bearing calls (`create_plan`/
  // `generate_ideas`), not this periodic pattern, so this route overrides it.
  const strictLimiter = createStrictRateLimiter(env, { limit: 60 });

  router.post(
    '/transcribe',
    strictLimiter,
    express.raw({ type: '*/*', limit: MAX_VOICE_AUDIO_BYTES }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ error: 'Bad request' });
        return;
      }

      try {
        const contentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : '';
        const result = await transcribeAudio(req.body, contentType);
        res.json(voiceTranscribeResponseSchema.parse(result));
      } catch (error) {
        // Boundary (same vocabulary as moderation.ts's logModerationIncident):
        // log only this error's own message — the audio buffer and the
        // transcript (if any was even produced) never reach a log line.
        const label = error instanceof TranscriptionError ? 'transcription failed' : 'unexpected transcription error';
        console.error(`[voice] ${label}:`, { error: (error as Error)?.message });
        res.status(503).json({ error: 'Service unavailable' });
      }
    },
  );

  return router;
}
