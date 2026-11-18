import type { Env } from '../config/env.js';
import { detectReplyLanguage } from './language.js';
import type { DetectedLanguage } from '@app/shared';

/** AD-9/AD-10: served through the same OpenRouter OpenAI-compatible proxy
 * every other model in this app's registry already uses (`./model.ts`'s
 * `OPENROUTER_BASE_URL`) — one key covers every provider, including this
 * one, so no second credential is needed. Confirmed against OpenRouter's
 * own docs (openrouter.ai/docs/guides/overview/multimodal/stt): a real
 * `POST /api/v1/audio/transcriptions` endpoint, multipart `file`/`model`
 * fields OpenAI-SDK-compatible. */
const OPENROUTER_TRANSCRIPTIONS_URL = 'https://openrouter.ai/api/v1/audio/transcriptions';

/** Live-test fix: `gpt-transcribe` (AD-9's placeholder name, this app's
 * own near-future fictional model id, same convention as `gpt-6-luna`) is
 * not a real OpenRouter catalog model for this endpoint — a live call
 * against it 404s. `openai/whisper-1` 404'd too, blocked by this account's
 * own OpenRouter workspace guardrail policy (account-level, not something
 * this code can control). `openai/whisper-large-v3-turbo` is confirmed
 * available to this account (live-tested: a garbage-audio request reaches
 * the provider and gets a 400 "Invalid or unsupported audio file" — i.e.
 * the model itself is accepted, only the fake audio bytes aren't). */
const TRANSCRIBE_MODEL = 'openai/whisper-large-v3-turbo';

/** Review fix: a multipart transcription endpoint commonly infers audio
 * format from the uploaded filename's extension — a bare `'audio'` with no
 * extension risks the provider guessing wrong. Falls back to `webm` (the
 * common `MediaRecorder` default) for an unrecognized content type. */
const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

function extensionFor(contentType: string): string {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return CONTENT_TYPE_EXTENSIONS[base] ?? 'webm';
}

export interface TranscribeAudioResult {
  transcript: string;
  detectedLanguage: DetectedLanguage;
}

export type TranscribeAudio = (audio: Buffer, contentType: string) => Promise<TranscribeAudioResult>;

/** Thrown on any transcription failure (network, non-2xx, empty/malformed
 * result) — `src/api/routes/voice.ts` catches this and turns it into the
 * one neutral-failure response the I/O matrix calls for, logging only this
 * error's own message, never the audio. */
export class TranscriptionError extends Error {}

/**
 * AD-26: normalizes the transcription model's own reported language into
 * the closed `'de' | 'en'` set `AD-25`'s downstream hint needs — this is the
 * primary path (the whole point of AD-26 is that audio-based detection
 * catches a short/ambiguous transcript, e.g. "Ok", that a text-only
 * heuristic can't). Falls back to `detectReplyLanguage`'s deterministic
 * text heuristic only when the provider's field is missing or not one of
 * the two recognized codes — never the other way around.
 */
function normalizeDetectedLanguage(reportedLanguage: unknown, transcript: string): DetectedLanguage {
  if (typeof reportedLanguage === 'string') {
    const normalized = reportedLanguage.trim().toLowerCase();
    if (normalized === 'de' || normalized === 'german' || normalized === 'deutsch') return 'de';
    if (normalized === 'en' || normalized === 'english') return 'en';
  }
  return detectReplyLanguage(transcript);
}

/**
 * AD-9/AD-10: the one place that calls the real voice model, server-side
 * only — never in the browser. Reuses the existing `OPENROUTER_API_KEY`
 * (Boundary/env rule): a new credential is added only when a story's
 * provider can't be reached through an existing one, and this one can.
 * Boundary/NFR3: the `audio` buffer passed in is only ever forwarded to
 * this one `fetch` call — never written to DB, disk, or a log line, and
 * goes out of scope the moment this function returns.
 *
 * Live-test fix (AD-26 deviation, documented): the real endpoint has no
 * `languages: [...]`-style multi-language hint — only a single forced
 * `language` field, or omitting it for full (unconstrained) auto-detect.
 * Omitting it is the closer match to AD-26's intent ("without forcing
 * either") than forcing one of the two; `response_format: verbose_json`
 * is what makes the endpoint return a `language` field in the response at
 * all (the default `json` format returns only `text`).
 */
export function createTranscribeAudio(env: Pick<Env, 'OPENROUTER_API_KEY'>): TranscribeAudio {
  return async function transcribeAudio(audio, contentType) {
    const form = new FormData();
    form.append('file', new Blob([audio], { type: contentType || 'application/octet-stream' }), `audio.${extensionFor(contentType)}`);
    form.append('model', TRANSCRIBE_MODEL);
    form.append('response_format', 'verbose_json');

    let response: Response;
    try {
      response = await fetch(OPENROUTER_TRANSCRIPTIONS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
        body: form,
      });
    } catch (error) {
      throw new TranscriptionError(`transcription request failed: ${(error as Error)?.message}`);
    }

    if (!response.ok) {
      throw new TranscriptionError(`transcription request returned ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new TranscriptionError(`transcription response was not valid JSON: ${(error as Error)?.message}`);
    }

    const parsed = body as { text?: unknown; language?: unknown } | undefined;
    const text = parsed?.text;
    const transcript = typeof text === 'string' ? text.trim() : '';
    if (!transcript) {
      throw new TranscriptionError('transcription returned no text');
    }

    return { transcript, detectedLanguage: normalizeDetectedLanguage(parsed?.language, transcript) };
  };
}
