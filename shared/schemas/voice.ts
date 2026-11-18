import { z } from 'zod';

/**
 * Story 4.3 (AD-26): the app's two supported languages — the same closed
 * set `src/agent/language.ts`'s `detectReplyLanguage` already returns, now
 * also the shape `POST /api/voice/transcribe`'s response and
 * `sendMessageRequestSchema.detectedLanguage` (`./index.ts`) both carry.
 */
export const detectedLanguageSchema = z.enum(['de', 'en']);

export type DetectedLanguage = z.infer<typeof detectedLanguageSchema>;

/**
 * Story 4.3 (AD-9): `src/api/routes/voice.ts`'s `POST /transcribe` response
 * — the backend's own `gpt-transcribe` call result, shared so the frontend
 * validates the exact same shape it's given.
 */
export const voiceTranscribeResponseSchema = z.object({
  transcript: z.string().min(1),
  detectedLanguage: detectedLanguageSchema,
});

export type VoiceTranscribeResponse = z.infer<typeof voiceTranscribeResponseSchema>;
