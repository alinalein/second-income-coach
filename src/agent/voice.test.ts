import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTranscribeAudio, TranscriptionError } from './voice.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

// AC: "audio is sent to the backend and transcribed" (AD-9) — asserted off
// the one real network call this module makes, against OpenRouter's own
// confirmed-real audio transcription endpoint/model (live-test fix: the
// fictional `gpt-transcribe` 404s there; `openai/whisper-1` 404'd too,
// blocked by this account's own workspace guardrail; `openai/whisper-
// large-v3-turbo` is confirmed available and reachable for this account).
describe('createTranscribeAudio (AD-9: transcription call shape)', () => {
  it('posts to the transcriptions endpoint with the whisper model and verbose_json, returning the detected language', async () => {
    let capturedUrl: string | undefined;
    let capturedForm: FormData | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedForm = init.body as FormData;
        return Promise.resolve(new Response(JSON.stringify({ text: 'Hallo, wie geht es dir?', language: 'de' }), { status: 200 }));
      }),
    );

    const transcribeAudio = createTranscribeAudio({ OPENROUTER_API_KEY: 'test-key' });
    const result = await transcribeAudio(Buffer.from([1, 2, 3]), 'audio/webm');

    expect(capturedUrl).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
    expect(capturedForm?.get('model')).toBe('openai/whisper-large-v3-turbo');
    expect(capturedForm?.get('response_format')).toBe('verbose_json');
    expect(result).toEqual({ transcript: 'Hallo, wie geht es dir?', detectedLanguage: 'de' });
    // Review fix: a multipart transcription endpoint commonly infers audio
    // format from the filename's own extension — never a bare, extension-
    // less name.
    expect((capturedForm?.get('file') as File)?.name).toBe('audio.webm');
  });

  // AD-26: "the language gpt-transcribe reports detecting is captured" —
  // the whole point is catching a short/ambiguous transcript that a text-
  // only heuristic would get wrong. Text alone here ('Ok') carries no
  // German signal at all (the text heuristic would default to 'en'); the
  // provider's own `language` field must still win.
  it("trusts the provider's reported language over what the transcript text alone would suggest", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ text: 'Ok', language: 'de' }), { status: 200 }))),
    );

    const transcribeAudio = createTranscribeAudio({ OPENROUTER_API_KEY: 'test-key' });
    const result = await transcribeAudio(Buffer.from([1]), 'audio/webm');

    expect(result).toEqual({ transcript: 'Ok', detectedLanguage: 'de' });
  });

  // AD-26 fallback: only when the provider's own field is absent/unrecognized
  // does this fall back to the transcript's own text heuristic.
  it('falls back to the text heuristic when the provider reports no recognized language', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ text: 'Ich bin müde' }), { status: 200 }))),
    );

    const transcribeAudio = createTranscribeAudio({ OPENROUTER_API_KEY: 'test-key' });
    const result = await transcribeAudio(Buffer.from([1]), 'audio/webm');

    expect(result).toEqual({ transcript: 'Ich bin müde', detectedLanguage: 'de' });
  });

  // I/O matrix: "Transcription call fails/503" — a non-ok response (or a
  // thrown fetch, or an empty transcript) is this module's one failure
  // branch, always surfaced the same way so the route can turn it into the
  // one neutral failure response.
  it.each([
    ['a non-ok response', () => Promise.resolve(new Response('', { status: 500 }))],
    ['a rejected fetch', () => Promise.reject(new Error('network down'))],
    ['an empty transcript', () => Promise.resolve(new Response(JSON.stringify({ text: '' }), { status: 200 }))],
  ])('throws TranscriptionError for %s', async (_label, mockResponse) => {
    vi.stubGlobal('fetch', vi.fn(mockResponse));

    const transcribeAudio = createTranscribeAudio({ OPENROUTER_API_KEY: 'test-key' });

    await expect(transcribeAudio(Buffer.from([1]), 'audio/webm')).rejects.toBeInstanceOf(TranscriptionError);
  });
});
