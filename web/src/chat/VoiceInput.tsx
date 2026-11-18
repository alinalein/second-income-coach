import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Mic, Square } from 'lucide-react';
import { voiceTranscribeResponseSchema, type DetectedLanguage } from '@app/shared';
import { Button } from '../components/ui/button';

export interface VoiceInputProps {
  /** `ChatThread`'s own `fillDraft`, forwarded through its `inputExtra`
   * render-prop (Code Map, user-requested revision) — fills the same draft
   * the text input edits, with the transcript's detected language attached
   * for `ChatThread` to carry through whenever the user actually sends it. */
  fillDraft: (content: string, detectedLanguage?: DetectedLanguage) => void;
  /** Mirrors `ChatThread`'s own `sending` state — this control is disabled
   * while a turn is already in flight, same as the text input next to it. */
  disabled: boolean;
}

type Status = 'idle' | 'recording' | 'transcribing';
type NoticeKind = 'permissionDenied' | 'unsupported' | 'transcriptionFailed';

/** User-requested near-live mode: `MediaRecorder`'s own periodic
 * `ondataavailable` (via `recorder.start(CHUNK_INTERVAL_MS)`) is reused as
 * the cadence for re-transcribing the growing clip-so-far and updating the
 * draft while still recording — no separate timer needed. OpenRouter's
 * transcription endpoint has no streaming/WebSocket variant (verified
 * against its own docs), so this is the closest available approximation:
 * the text catches up every couple of seconds, not instantly. */
const CHUNK_INTERVAL_MS = 2500;

/** Each interim call re-transcribes the *entire* clip so far (the endpoint
 * has no "continue from here" mode), so cost/latency grow with recording
 * length. Past this many accumulated chunks (~60s), interim updates stop;
 * the final transcription on stop still covers the whole recording. */
const MAX_INTERIM_CHUNKS = Math.ceil(60_000 / CHUNK_INTERVAL_MS);

/** AC/Boundary (NFR2): "No MediaRecorder" is a feature-detect failure on
 * mount, not a failed call — checked once, not re-checked per click. */
function isVoiceSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

/**
 * Story 4.3 (AD-9/AD-10, user-requested revision): records via the
 * browser's `MediaRecorder` — click to start, click the same button again
 * to stop — sends the finished blob to `POST /api/voice/transcribe` (the
 * only place the transcription key is used, server-side only), then drops
 * the transcript straight into `ChatThread`'s own draft via `fillDraft`
 * (this component's only coupling to it) for the user to review/edit in
 * that one familiar input and send with its existing Send button — same
 * pipeline as a typed message (AC: "same tools, same moderation").
 *
 * NFR2: every failure path here (permission denied, unsupported, a failed
 * transcription call) only ever shows a neutral note next to this control —
 * it never disables or replaces `ChatThread`'s own text input, which this
 * component has no reference to at all.
 */
export function VoiceInput({ fillDraft, disabled }: VoiceInputProps) {
  const { t } = useTranslation('chat');
  const [supported] = React.useState(isVoiceSupported);
  const [status, setStatus] = React.useState<Status>('idle');
  const [notice, setNotice] = React.useState<NoticeKind | null>(null);
  const mediaRecorderRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<BlobPart[]>([]);
  const streamRef = React.useRef<MediaStream | null>(null);
  // Near-live mode: guards against an interim transcription call overlapping
  // a still-in-flight one (skip this tick, catch up on the next) and
  // against starting a new interim call once `stopRecording` has already
  // been requested (the final, authoritative transcription on `onstop`
  // owns that moment instead).
  const interimInFlightRef = React.useRef(false);
  const stoppingRef = React.useRef(false);
  // Guards every state update below against a stop/transcribe callback
  // resolving after this control has already unmounted (e.g. the plan
  // workspace itself unmounts mid-recording or mid-transcription) —
  // without it, `onstop`/the `transcribe()` fetch can still call `setStatus`/
  // `setNotice` on an unmounted component.
  //
  // Live-test bug fix: this flag must be re-armed to `true` every time the
  // mount effect below actually runs, not just once at `useRef`'s initial
  // value. React 18 StrictMode (dev only) deliberately mounts, unmounts,
  // then re-mounts every component once — the first unmount set this to
  // `false`, and with nothing to reset it, it stayed `false` for the rest
  // of this component's real lifetime. Every later click's `startRecording`
  // then saw `mountedRef.current === false` right after `getUserMedia`
  // resolved, immediately stopped the just-granted stream, and returned —
  // before ever reaching `setStatus('recording')`. That's why the mic
  // briefly appeared in Chrome's own indicator and then vanished, with the
  // button never visibly changing: the status update it needed never ran.
  const mountedRef = React.useRef(true);

  function stopStream(): void {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  // Releases the mic if this control unmounts mid-recording (e.g. the plan
  // workspace itself unmounts) — never left open in the background. Detaches
  // the recorder's own callbacks first so stopping it here never triggers a
  // (now pointless) `onstop` -> `transcribe()` call.
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const recorder = mediaRecorderRef.current;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.stop();
      }
      stopStream();
    };
  }, []);

  async function startRecording(): Promise<void> {
    setNotice(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      stoppingRef.current = false;
      interimInFlightRef.current = false;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
        // Near-live mode: re-transcribe the clip-so-far on each periodic
        // slice while still recording — never overlapping a call already
        // in flight, never once `stopRecording` has been requested (the
        // final transcription on `onstop` owns that moment), and capped so
        // a long recording doesn't keep re-transcribing an ever-growing
        // clip forever.
        if (stoppingRef.current || interimInFlightRef.current || chunksRef.current.length > MAX_INTERIM_CHUNKS) return;
        interimInFlightRef.current = true;
        void transcribeInterim(new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })).finally(() => {
          interimInFlightRef.current = false;
        });
      };
      recorder.onstop = () => {
        void transcribeFinal(new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' }));
        stopStream();
      };
      mediaRecorderRef.current = recorder;
      recorder.start(CHUNK_INTERVAL_MS);
      setStatus('recording');
    } catch {
      // I/O matrix: "Mic permission denied" -> neutral note, mic returns to
      // idle; typing stays available (this component never touches it).
      if (!mountedRef.current) return;
      setNotice('permissionDenied');
      setStatus('idle');
      stopStream();
    }
  }

  function stopRecording(): void {
    stoppingRef.current = true;
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    setStatus('transcribing');
  }

  async function requestTranscription(blob: Blob): Promise<{ transcript: string; detectedLanguage?: DetectedLanguage }> {
    const res = await fetch('/api/voice/transcribe', {
      method: 'POST',
      credentials: 'include',
      body: blob,
    });
    if (!res.ok) throw new Error(`transcription failed: ${res.status}`);
    const body: unknown = await res.json();
    const parsed = voiceTranscribeResponseSchema.safeParse(body);
    if (!parsed.success) throw new Error('malformed transcription response');
    return parsed.data;
  }

  // Near-live mode: a best-effort update while still recording — a failed
  // interim call never shows a notice or stops recording (NFR2-adjacent:
  // the user is still mid-recording, not blocked by anything here), it
  // just tries again on the next slice.
  async function transcribeInterim(blob: Blob): Promise<void> {
    try {
      const result = await requestTranscription(blob);
      // `stoppingRef` (not the `status` state) — a plain closure over
      // `status` here would always see whatever it was when this closure
      // was created (this callback is set once per recording, long before
      // any later re-render), never the fresh value.
      if (!mountedRef.current || stoppingRef.current) return;
      fillDraft(result.transcript, result.detectedLanguage);
    } catch {
      // Silently skipped — see comment above.
    }
  }

  // The authoritative result once the user actually stops — covers the
  // whole recording (including the last slice interim updates may have
  // missed), and is the one call whose failure the I/O matrix's
  // "Transcription call fails/503" row applies to.
  async function transcribeFinal(blob: Blob): Promise<void> {
    try {
      const result = await requestTranscription(blob);
      if (!mountedRef.current) return;
      fillDraft(result.transcript, result.detectedLanguage);
      setStatus('idle');
    } catch {
      if (!mountedRef.current) return;
      setNotice('transcriptionFailed');
      setStatus('idle');
    }
  }

  function handleMicClick(): void {
    if (status === 'recording') {
      stopRecording();
      return;
    }
    void startRecording();
  }

  if (!supported) {
    // I/O matrix: "No MediaRecorder" -> neutral note instead of a mic
    // button; typing stays available.
    return <p className="text-xs text-muted-foreground">{t('voice.unsupported')}</p>;
  }

  // The status/notice text is absolutely positioned above the button
  // (rather than in normal flow below it) so it never affects the
  // composer's layout regardless of the surrounding card's fixed-height
  // footer (review fix, user-reported: a stacked second row there was
  // silently clipped, not grown into).
  const statusText =
    status === 'recording'
      ? t('voice.recording')
      : status === 'transcribing'
        ? t('voice.transcribing')
        : notice
          ? t(`voice.${notice}`)
          : null;

  return (
    <div className="relative flex items-center">
      {statusText && (
        <p
          role={notice ? 'alert' : 'status'}
          className="absolute bottom-full right-0 mb-2 whitespace-nowrap rounded-md border bg-card px-2 py-1 text-xs text-foreground shadow-[var(--shadow)]"
        >
          {statusText}
        </p>
      )}
      <Button
        type="button"
        variant={status === 'recording' ? 'default' : 'outline'}
        className="h-9 w-9 shrink-0 rounded-full p-0"
        disabled={disabled || status === 'transcribing'}
        aria-label={status === 'recording' ? t('voice.stopLabel') : t('voice.micLabel')}
        aria-pressed={status === 'recording'}
        onClick={handleMicClick}
      >
        {status === 'recording' ? <Square className="h-4 w-4 fill-current" /> : <Mic className="h-4 w-4" />}
      </Button>
    </div>
  );
}
