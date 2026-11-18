import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { VoiceInput } from './VoiceInput';
import chatEn from '../locales/en/chat.json';

type DataAvailableHandler = (event: { data: Blob }) => void;

/** Minimal fake standing in for the real `MediaRecorder` — `start()` is a
 * no-op, `stop()` synchronously fires `ondataavailable` then `onstop`, same
 * as a real (very short) recording would, just without any real audio. */
class FakeMediaRecorder {
  static isTypeSupported = () => true;
  ondataavailable: DataAvailableHandler | null = null;
  onstop: (() => void) | null = null;
  mimeType = 'audio/webm';

  start(): void {}

  stop(): void {
    this.ondataavailable?.({ data: new Blob(['fake-audio'], { type: 'audio/webm' }) });
    this.onstop?.();
  }
}

function stubSupportedMediaApis(getUserMedia: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });
}

function fakeStream(): MediaStream {
  return { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window.navigator, 'mediaDevices');
});

// I/O matrix: "No MediaRecorder" -> neutral note instead of a mic button;
// typing stays available (this component has no reference to the text
// input at all, so there's nothing here to disable).
describe('VoiceInput (I/O matrix: no MediaRecorder)', () => {
  it('shows a neutral note instead of a mic button when MediaRecorder is unavailable', () => {
    render(<VoiceInput fillDraft={vi.fn()} disabled={false} />);

    expect(screen.getByText(chatEn.voice.unsupported)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

// I/O matrix: happy path — record, stop, transcribe, then the transcript
// (and its detected language) lands in the same draft the text input edits
// (user-requested revision: no separate review dialog).
describe('VoiceInput (I/O matrix: happy path)', () => {
  it('records, transcribes, and fills the draft with the transcript and detected language', async () => {
    stubSupportedMediaApis(vi.fn().mockResolvedValue(fakeStream()));
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ transcript: 'Ich habe heute gut gearbeitet', detectedLanguage: 'de' }), { status: 200 })),
      ),
    );
    const fillDraft = vi.fn();

    render(<VoiceInput fillDraft={fillDraft} disabled={false} />);

    fireEvent.click(screen.getByRole('button', { name: chatEn.voice.micLabel }));
    await waitFor(() => expect(screen.getByRole('button', { name: chatEn.voice.stopLabel })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: chatEn.voice.stopLabel }));

    await waitFor(() => expect(fillDraft).toHaveBeenCalledWith('Ich habe heute gut gearbeitet', 'de'));
    expect(screen.getByRole('button', { name: chatEn.voice.micLabel })).toBeInTheDocument();
  });
});

// I/O matrix: "Mic permission denied" -> neutral note, mic returns to idle;
// typing stays available.
describe('VoiceInput (I/O matrix: mic permission denied)', () => {
  it('shows a neutral note and returns to idle when getUserMedia rejects', async () => {
    stubSupportedMediaApis(vi.fn().mockRejectedValue(new Error('denied')));

    render(<VoiceInput fillDraft={vi.fn()} disabled={false} />);

    fireEvent.click(screen.getByRole('button', { name: chatEn.voice.micLabel }));

    expect(await screen.findByText(chatEn.voice.permissionDenied)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: chatEn.voice.micLabel })).toBeInTheDocument();
  });
});

// I/O matrix: "Transcription call fails/503" -> neutral note, back to idle;
// typing stays available.
describe('VoiceInput (I/O matrix: transcription call fails)', () => {
  it('shows a neutral note and returns to idle when the transcription call fails', async () => {
    stubSupportedMediaApis(vi.fn().mockResolvedValue(fakeStream()));
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('', { status: 503 }))));
    const fillDraft = vi.fn();

    render(<VoiceInput fillDraft={fillDraft} disabled={false} />);

    fireEvent.click(screen.getByRole('button', { name: chatEn.voice.micLabel }));
    await waitFor(() => expect(screen.getByRole('button', { name: chatEn.voice.stopLabel })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: chatEn.voice.stopLabel }));

    expect(await screen.findByText(chatEn.voice.transcriptionFailed)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: chatEn.voice.micLabel })).toBeInTheDocument();
    expect(fillDraft).not.toHaveBeenCalled();
  });
});

// Review fix: unmounting mid-transcription must never update state on the
// now-unmounted component — proven by the transcription call resolving
// only *after* unmount, with no React warning/error logged.
describe('VoiceInput (review fix: unmount mid-transcription)', () => {
  it('does not update state or warn after unmounting while a transcription call is still in flight', async () => {
    stubSupportedMediaApis(vi.fn().mockResolvedValue(fakeStream()));
    let resolveFetch: (response: Response) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { unmount } = render(<VoiceInput fillDraft={vi.fn()} disabled={false} />);

    fireEvent.click(screen.getByRole('button', { name: chatEn.voice.micLabel }));
    await waitFor(() => expect(screen.getByRole('button', { name: chatEn.voice.stopLabel })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: chatEn.voice.stopLabel }));

    unmount();
    resolveFetch(new Response(JSON.stringify({ transcript: 'Hallo', detectedLanguage: 'de' }), { status: 200 }));
    await Promise.resolve();
    await Promise.resolve();

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
