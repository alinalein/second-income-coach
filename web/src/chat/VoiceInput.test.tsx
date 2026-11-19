import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { VoiceInput } from './VoiceInput';
import chatEn from '../locales/en/chat.json';

type DataAvailableHandler = (event: { data: Blob }) => void;

/** Minimal fake standing in for the real `MediaRecorder` — `start()` is a
 * no-op, `stop()` synchronously fires `ondataavailable` then `onstop`, same
 * as a real (very short) recording would, just without any real audio.
 * `emitChunk()` lets a test simulate one of `MediaRecorder`'s own periodic
 * `ondataavailable` events while still recording (near-live mode), without
 * stopping. */
class FakeMediaRecorder {
  static isTypeSupported = () => true;
  static instances: FakeMediaRecorder[] = [];
  ondataavailable: DataAvailableHandler | null = null;
  onstop: (() => void) | null = null;
  mimeType = 'audio/webm';

  constructor() {
    FakeMediaRecorder.instances.push(this);
  }

  start(): void {}

  emitChunk(): void {
    this.ondataavailable?.({ data: new Blob(['fake-audio'], { type: 'audio/webm' }) });
  }

  stop(): void {
    this.emitChunk();
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
  FakeMediaRecorder.instances = [];
});

// I/O matrix: "No MediaRecorder" -> neutral note instead of a mic button;
// typing stays available (this component has no reference to the text
// input at all, so there's nothing here to disable).
describe('VoiceInput (I/O matrix: no MediaRecorder)', () => {
  it('shows a neutral note instead of a mic button when MediaRecorder is unavailable', () => {
    render(<VoiceInput fillDraft={vi.fn()} disabled={false} getSendCount={() => 0} />);

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

    render(<VoiceInput fillDraft={fillDraft} disabled={false} getSendCount={() => 0} />);

    fireEvent.click(screen.getByRole('button', { name: chatEn.voice.micLabel }));
    await waitFor(() => expect(screen.getByRole('button', { name: chatEn.voice.stopLabel })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: chatEn.voice.stopLabel }));

    await waitFor(() => expect(fillDraft).toHaveBeenCalledWith('Ich habe heute gut gearbeitet', 'de'));
    expect(screen.getByRole('button', { name: chatEn.voice.micLabel })).toBeInTheDocument();
  });
});

// User-requested near-live mode: a periodic slice while still recording
// (not just the final stop) re-transcribes the clip-so-far and updates the
// draft progressively, without leaving the recording state or showing any
// notice for an interim call specifically.
describe('VoiceInput (near-live mode: interim updates while still recording)', () => {
  it('fills the draft on each interim slice while still recording, then again with the final result on stop', async () => {
    stubSupportedMediaApis(vi.fn().mockResolvedValue(fakeStream()));
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        callCount += 1;
        const transcript = callCount === 1 ? 'Hallo' : callCount === 2 ? 'Hallo, wie' : 'Hallo, wie geht es dir';
        return Promise.resolve(new Response(JSON.stringify({ transcript, detectedLanguage: 'de' }), { status: 200 }));
      }),
    );
    const fillDraft = vi.fn();

    render(<VoiceInput fillDraft={fillDraft} disabled={false} getSendCount={() => 0} />);

    fireEvent.click(screen.getByRole('button', { name: chatEn.voice.micLabel }));
    await waitFor(() => expect(screen.getByRole('button', { name: chatEn.voice.stopLabel })).toBeInTheDocument());

    const recorder = FakeMediaRecorder.instances.at(-1)!;
    recorder.emitChunk();
    await waitFor(() => expect(fillDraft).toHaveBeenNthCalledWith(1, 'Hallo', 'de'));
    // Still recording — an interim update never moves the control out of
    // the recording state.
    expect(screen.getByRole('button', { name: chatEn.voice.stopLabel })).toBeInTheDocument();

    recorder.emitChunk();
    await waitFor(() => expect(fillDraft).toHaveBeenNthCalledWith(2, 'Hallo, wie', 'de'));
    expect(screen.getByRole('button', { name: chatEn.voice.stopLabel })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: chatEn.voice.stopLabel }));
    await waitFor(() => expect(fillDraft).toHaveBeenNthCalledWith(3, 'Hallo, wie geht es dir', 'de'));
    expect(screen.getByRole('button', { name: chatEn.voice.micLabel })).toBeInTheDocument();
  });
});

// I/O matrix: "Mic permission denied" -> neutral note, mic returns to idle;
// typing stays available.
describe('VoiceInput (I/O matrix: mic permission denied)', () => {
  it('shows a neutral note and returns to idle when getUserMedia rejects', async () => {
    stubSupportedMediaApis(vi.fn().mockRejectedValue(new Error('denied')));

    render(<VoiceInput fillDraft={vi.fn()} disabled={false} getSendCount={() => 0} />);

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

    render(<VoiceInput fillDraft={fillDraft} disabled={false} getSendCount={() => 0} />);

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

    const { unmount } = render(<VoiceInput fillDraft={vi.fn()} disabled={false} getSendCount={() => 0} />);

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

// Bug fix (user-reported, live): "sent a voice message, but the input
// still showed the (already-sent) transcript afterward" — the final
// transcription call is async; if the user sends (text, or an earlier
// interim-filled draft) before it resolves, `getSendCount()` will have
// moved on by then, and the stale result must never repopulate the
// now-empty, already-sent draft.
describe('VoiceInput (bug fix, live: a stale transcription result is dropped once the draft has already been sent)', () => {
  it('does not fill the draft with the final transcript if a send happened while it was still in flight', async () => {
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
    const fillDraft = vi.fn();
    let sendCount = 0;

    render(<VoiceInput fillDraft={fillDraft} disabled={false} getSendCount={() => sendCount} />);

    fireEvent.click(screen.getByRole('button', { name: chatEn.voice.micLabel }));
    await waitFor(() => expect(screen.getByRole('button', { name: chatEn.voice.stopLabel })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: chatEn.voice.stopLabel }));

    // The user sends a message (this recording's own transcript, or
    // something else entirely) before the transcription call resolves.
    sendCount += 1;
    resolveFetch(new Response(JSON.stringify({ transcript: 'Hallo', detectedLanguage: 'de' }), { status: 200 }));
    await waitFor(() => expect(screen.getByRole('button', { name: chatEn.voice.micLabel })).toBeInTheDocument());

    expect(fillDraft).not.toHaveBeenCalled();
  });
});
