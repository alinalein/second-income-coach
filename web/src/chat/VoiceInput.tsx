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
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        void transcribe(new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' }));
        stopStream();
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
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
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    setStatus('transcribing');
  }

  async function transcribe(blob: Blob): Promise<void> {
    try {
      const res = await fetch('/api/voice/transcribe', {
        method: 'POST',
        credentials: 'include',
        body: blob,
      });
      if (!res.ok) throw new Error(`transcription failed: ${res.status}`);
      const body: unknown = await res.json();
      const parsed = voiceTranscribeResponseSchema.safeParse(body);
      if (!parsed.success) throw new Error('malformed transcription response');

      if (!mountedRef.current) return;
      fillDraft(parsed.data.transcript, parsed.data.detectedLanguage);
      setStatus('idle');
    } catch {
      // I/O matrix: "Transcription call fails/503" -> neutral note, back to
      // idle; typing stays available.
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
