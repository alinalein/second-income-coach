import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createVoiceRouter, type VoiceRouterDeps } from './voice.js';

const testEnv: VoiceRouterDeps['env'] = { RATE_LIMIT_WINDOW_MS: 60_000, OPENROUTER_API_KEY: 'test-key' };

function buildTestApp(transcribeAudio: VoiceRouterDeps['transcribeAudio']) {
  const app = express();
  app.use('/api/voice', createVoiceRouter({ env: testEnv, transcribeAudio }));
  return app;
}

// AC: "audio is sent to the backend and transcribed via gpt-transcribe" —
// this route's own happy path, with the real transcription client replaced
// by the injected test seam.
describe('createVoiceRouter POST /transcribe (AC: happy path)', () => {
  it('returns the transcript and detected language from transcribeAudio', async () => {
    const transcribeAudio = vi.fn().mockResolvedValue({ transcript: 'Hello there', detectedLanguage: 'en' });

    const res = await request(buildTestApp(transcribeAudio))
      .post('/api/voice/transcribe')
      .set('Content-Type', 'audio/webm')
      .send(Buffer.from([1, 2, 3]));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transcript: 'Hello there', detectedLanguage: 'en' });
    expect(transcribeAudio).toHaveBeenCalledWith(expect.any(Buffer), expect.stringContaining('audio/webm'));
  });
});

// I/O matrix: "Transcription call fails/503" — a thrown transcription error
// surfaces as a logged 503, and NFR3's "never...in logs" boundary holds:
// the logged metadata carries only the error's own message, never the
// audio buffer that was just sent.
describe('createVoiceRouter POST /transcribe (I/O matrix: transcription call fails)', () => {
  it('returns 503 and logs only the error message, never the audio buffer', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const transcribeAudio = vi.fn().mockRejectedValue(new Error('upstream exploded'));

    const res = await request(buildTestApp(transcribeAudio))
      .post('/api/voice/transcribe')
      .set('Content-Type', 'audio/webm')
      .send(Buffer.from([1, 2, 3]));

    expect(res.status).toBe(503);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('[voice]'), { error: 'upstream exploded' });

    consoleErrorSpy.mockRestore();
  });
});
