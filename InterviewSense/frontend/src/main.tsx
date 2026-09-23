import { Component, FormEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type User = { id: string; email: string; name: string | null };
type Analysis = { id: string; kind: string; score: number | null; details: { metrics?: Record<string, number | null>; limitations?: string[] } | null };
type Question = { id: string; text: string; order: number; answer: { transcript: string; mediaUrl?: string | null; durationMs?: number | null; analyses?: Analysis[] } | null };
type Report = { overallScore: number | null; summary?: string | null; details?: { strengths?: string[]; improvements?: string[]; usedLlm?: boolean } | null };
type Interview = { id: string; title: string; role: string | null; questionSource?: 'llm' | 'offline' | null; status: string; createdAt: string; answeredCount?: number; _count?: { questions: number }; report: Report | null; questions?: Question[] };
type PauseAnalysis = { pauseCount: number; longPauseCount: number; totalPauseMs: number; longestPauseMs: number; speakingRate: number | null; audioDurationMs: number | null; timestampedTranscription: true };
type AuthResponse = { user: User; token?: string; csrfToken?: string };
type CameraMetricsState = { durationMs?: number; faceDetected: boolean; eyeContactScore: number; expressionScore: number; postureScore: number; sampledFrames: number };

const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '/api/v1';
const MEDIA_URL = (import.meta.env.VITE_MEDIA_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const CSRF_COOKIE = 'interviewsense_csrf';
/** How often MediaRecorder emits a chunk, and therefore how often live captions refresh. */
const LIVE_CAPTION_INTERVAL_MS = 8_000;
const TRANSCRIBE_POLL_INTERVAL_MS = 1_500;
const TRANSCRIBE_POLL_TIMEOUT_MS = 5 * 60 * 1000;

function getCookieValue(name: string): string {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : '';
}

function authFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  if (method !== 'GET' && method !== 'HEAD') {
    const csrfToken = getCookieValue(CSRF_COOKIE);
    if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
  }
  return fetch(input, { credentials: 'include', ...init, headers });
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, '0')}` : `${seconds}s`;
}

function firstUnansweredIndex(questions: Question[]): number {
  const index = questions.findIndex((question) => !question.answer?.transcript?.trim());
  return index === -1 ? 0 : index;
}

function meanScore(interviews: Interview[]): number | null {
  const scores = interviews.flatMap((interview) => interview.report?.overallScore ?? []);
  if (scores.length === 0) return null;
  return Math.round(scores.reduce((total, score) => total + score, 0) / scores.length);
}

function computeAnswerOverallScore(analyses: Analysis[]): number | null {
  const speech = analyses.find((a) => a.kind === 'SPEECH_FLUENCY')?.score ?? null;
  const voice = analyses.find((a) => a.kind === 'VOICE_DELIVERY')?.score ?? null;
  const eye = analyses.find((a) => a.kind === 'CAMERA_EYE_CONTACT')?.score ?? null;
  const expr = analyses.find((a) => a.kind === 'CAMERA_EXPRESSION')?.score ?? null;
  const posture = analyses.find((a) => a.kind === 'CAMERA_POSTURE')?.score ?? null;
  const content = analyses.find((a) => a.kind === 'ANSWER_CONTENT')?.score ?? null;

  const hasCamera = eye !== null || expr !== null || posture !== null;
  let deliveryScore: number | null = null;

  if (hasCamera) {
    let sum = 0;
    let weight = 0;
    if (voice !== null) { sum += voice * 30; weight += 30; }
    if (eye !== null) { sum += eye * 25; weight += 25; }
    if (expr !== null) { sum += expr * 20; weight += 20; }
    if (posture !== null) { sum += posture * 15; weight += 15; }
    if (speech !== null) { sum += speech * 10; weight += 10; }
    if (weight > 0) deliveryScore = Math.round(sum / weight);
  } else {
    const deliveryScores = [speech, voice].filter((s): s is number => s !== null);
    if (deliveryScores.length > 0) {
      deliveryScore = Math.round(deliveryScores.reduce((a, b) => a + b, 0) / deliveryScores.length);
    }
  }

  if (content !== null && deliveryScore !== null) {
    return Math.round(0.45 * content + 0.55 * deliveryScore);
  } else if (deliveryScore !== null) {
    return deliveryScore;
  } else if (content !== null) {
    return content;
  }
  return null;
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.error('The app encountered a rendering error:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="shell recovery-screen" role="alert">
          <header className="topbar"><strong>InterviewSense</strong></header>
          <section>
            <p className="eyebrow">WE HIT A PROBLEM</p>
            <h1>Let’s get you<br /><em>back on track.</em></h1>
            <p className="lede">This screen could not be loaded. Your saved interview answers are still on your account.</p>
            <button type="button" onClick={() => window.location.assign(window.location.pathname)}>Return to dashboard</button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

function Frame({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <>
      <a className="skip-link" href="#content">Skip to content</a>
      <main id="content" className={className ? `shell ${className}` : 'shell'}>
        {children}
      </main>
    </>
  );
}

function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  shown,
  onToggle
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  shown: boolean;
  onToggle: () => void;
}) {
  return (
    <label>
      {label}
      <span className="password-field">
        <input
          type={shown ? 'text' : 'password'}
          required
          minLength={8}
          value={value}
          autoComplete={autoComplete}
          onChange={(event) => onChange(event.target.value)}
          placeholder="At least 8 characters"
        />
        <button type="button" className="text-button password-toggle" onClick={onToggle} aria-pressed={shown} aria-label={shown ? 'Hide password' : 'Show password'}>
          {shown ? 'Hide' : 'Show'}
        </button>
      </span>
    </label>
  );
}

function App() {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot' | 'reset'>('login');
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [interviewsReady, setInterviewsReady] = useState(false);
  const [selected, setSelected] = useState<Interview | null>(null);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answer, setAnswer] = useState('');
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const videoPreview = useRef<HTMLVideoElement | null>(null);
  const [recordedUrl, setRecordedUrl] = useState('');
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const mediaStream = useRef<MediaStream | null>(null);
  const recordedChunks = useRef<Blob[]>([]);
  const recordingStartedAt = useRef(0);
  const savingRef = useRef(false);
  const liveAborted = useRef(true);
  const liveRequestInFlight = useRef(false);
  const transcribeAbort = useRef<AbortController | null>(null);
  const [liveCaptionsEnabled, setLiveCaptionsEnabled] = useState(false);
  const [liveCaption, setLiveCaption] = useState('');
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [cameraMetrics, setCameraMetrics] = useState<CameraMetricsState | null>(null);
  const cameraSamplerRef = useRef<number | null>(null);
  const frameStatsRef = useRef<{ eyeScores: number[]; exprScores: number[]; postureScores: number[]; faceCount: number; totalFrames: number }>({
    eyeScores: [], exprScores: [], postureScores: [], faceCount: 0, totalFrames: 0
  });

  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [interviewForm, setInterviewForm] = useState({ title: '', role: '' });
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotResult, setForgotResult] = useState<{ message: string; resetToken?: string } | null>(null);
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [pauseMetrics, setPauseMetrics] = useState<PauseAnalysis | null>(null);

  useEffect(() => {
    let cancelled = false;
    authFetch(`${API_URL}/me`)
      .then(async (response) => (response.ok ? response.json() : Promise.reject()))
      .then((data) => {
        if (!cancelled) setUser(data.user);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setBooting(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tokenFromUrl = params.get('token') || params.get('resetToken');
    if (tokenFromUrl) {
      setResetToken(tokenFromUrl);
      setMode('reset');
    }
  }, []);

  useEffect(() => {
    document.title = selected
      ? `${selected.title} · InterviewSense`
      : user
        ? 'Dashboard · InterviewSense'
        : 'InterviewSense';
  }, [selected, user]);

  useEffect(() => {
    if (recording && videoPreview.current && mediaStream.current) {
      videoPreview.current.srcObject = mediaStream.current;
      videoPreview.current.play().catch(() => undefined);
    }
  }, [recording]);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      setRecordingDuration(Date.now() - recordingStartedAt.current);
    }, 250);
    return () => window.clearInterval(timer);
  }, [recording]);

  useEffect(() => {
    if (!user) {
      setInterviews([]);
      setInterviewsReady(false);
      return;
    }
    let cancelled = false;
    setInterviewsReady(false);
    authFetch(`${API_URL}/interviews`)
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled) setInterviews(data.interviews ?? []);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load your interviews.');
      })
      .finally(() => {
        if (!cancelled) setInterviewsReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => () => {
    if (recordedUrl.startsWith('blob:')) URL.revokeObjectURL(recordedUrl);
  }, [recordedUrl]);

  useEffect(() => () => {
    mediaStream.current?.getTracks().forEach((track) => track.stop());
    liveAborted.current = true;
    transcribeAbort.current?.abort();
  }, []);

  useEffect(() => {
    const current = selected?.questions?.[questionIndex];
    const dirty = recording || answer.trim() !== (current?.answer?.transcript ?? '').trim() || recordedBlob != null;
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [recording, selected, answer, questionIndex, recordedBlob]);

  function abandonRecording() {
    if (cameraSamplerRef.current) {
      window.clearInterval(cameraSamplerRef.current);
      cameraSamplerRef.current = null;
    }
    const recorder = mediaRecorder.current;
    if (recorder && recorder.state === 'recording') {
      recorder.onstop = null;
      recorder.stop();
    }
    mediaStream.current?.getTracks().forEach((track) => track.stop());
    mediaStream.current = null;
    mediaRecorder.current = null;
    setRecording(false);
  }

  function showQuestion(interview: Interview, index: number) {
    const question = interview.questions?.[index];
    setQuestionIndex(index);
    setPauseMetrics(null);
    setCameraMetrics(null);
    setConfirmLeave(false);
    setError('');
    setAnswer(question?.answer?.transcript ?? '');
    setRecordedUrl(question?.answer?.mediaUrl ? `${MEDIA_URL}${question.answer.mediaUrl}` : '');
    setRecordedBlob(null);
    setRecordingDuration(question?.answer?.durationMs ?? 0);
  }

  function leaveInterview() {
    abandonRecording();
    setRecordedBlob(null);
    setRecordedUrl('');
    setPauseMetrics(null);
    setCameraMetrics(null);
    setConfirmLeave(false);
    setSelected(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setInfo('');
    setLoading(true);
    try {
      const response = await authFetch(`${API_URL}/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'register' ? form : { email: form.email, password: form.password })
      });
      const data = (await response.json()) as AuthResponse & { error?: string };
      if (!response.ok) throw new Error(data.error ?? 'Something went wrong');
      setUser(data.user);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to connect to the API');
    } finally {
      setLoading(false);
    }
  }

  async function submitForgot(event: FormEvent) {
    event.preventDefault();
    setError('');
    setInfo('');
    setForgotResult(null);
    setLoading(true);
    try {
      const response = await authFetch(`${API_URL}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmail })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Could not request password reset');
      setForgotResult({ message: data.message, resetToken: data.resetToken });
      setInfo(data.message);
      if (data.resetToken) setResetToken(data.resetToken);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to connect to the API');
    } finally {
      setLoading(false);
    }
  }

  async function submitReset(event: FormEvent) {
    event.preventDefault();
    setError('');
    setInfo('');
    setLoading(true);
    try {
      const response = await authFetch(`${API_URL}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, password: newPassword })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Could not reset password');
      setInfo(data.message ?? 'Password has been reset successfully. You can now log in.');
      setMode('login');
      setNewPassword('');
      window.history.replaceState({}, '', window.location.pathname);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to connect to the API');
    } finally {
      setLoading(false);
    }
  }

  async function createInterview(event: FormEvent) {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const response = await authFetch(`${API_URL}/interviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(interviewForm)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      const created = { ...data.interview, answeredCount: 0, _count: { questions: data.interview.questions.length }, report: null };
      setInterviews((current) => [created, ...current]);
      setInterviewForm({ title: '', role: '' });
      await openInterview(created);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create interview');
    } finally {
      setLoading(false);
    }
  }

  async function openInterview(interview: Interview, startAt?: number) {
    setError('');
    setOpeningId(interview.id);
    try {
      const response = await authFetch(`${API_URL}/interviews/${interview.id}`);
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? 'Could not load interview');
        return;
      }
      const loaded = data.interview as Interview | undefined;
      if (!loaded || !Array.isArray(loaded.questions) || loaded.questions.length === 0) {
        setError('This interview has no questions to resume. Refresh your dashboard or start a new session.');
        return;
      }
      const start = Math.max(0, Math.min(
        startAt ?? (loaded.status === 'COMPLETED' ? 0 : firstUnansweredIndex(loaded.questions)),
        loaded.questions.length - 1
      ));
      const answeredCount = loaded.questions.filter((item) => item.answer?.transcript?.trim()).length;
      abandonRecording();
      setSelected(loaded);
      setInterviews((current) => current.map((item) => (
        item.id === loaded.id
          ? { ...item, status: loaded.status, answeredCount, report: loaded.report ?? item.report }
          : item
      )));
      showQuestion(loaded, start);
    } catch {
      setError('Could not load interview');
    } finally {
      setOpeningId(null);
    }
  }

  async function removeInterview(id: string) {
    setError('');
    setLoading(true);
    try {
      const response = await authFetch(`${API_URL}/interviews/${id}`, { method: 'DELETE' });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error ?? 'Could not delete interview');
      }
      setInterviews((current) => current.filter((interview) => interview.id !== id));
      setPendingDelete(null);
      if (selected?.id === id) leaveInterview();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete interview');
    } finally {
      setLoading(false);
    }
  }

  async function analyzeRecordedVoice(blob: Blob) {
    const context = new AudioContext();
    try {
      const audio = await context.decodeAudioData(await blob.arrayBuffer());
      const samples = audio.getChannelData(0);
      const frameSize = 1024;
      const rmsValues: number[] = [];
      const crossingValues: number[] = [];
      let silentFrames = 0;
      let longPauseCount = 0;
      let silentRun = 0;
      for (let start = 0; start < samples.length; start += frameSize) {
        const end = Math.min(start + frameSize, samples.length);
        let sum = 0;
        let crossings = 0;
        for (let i = start; i < end; i++) {
          sum += samples[i] * samples[i];
          if (i > start && (samples[i] >= 0) !== (samples[i - 1] >= 0)) crossings++;
        }
        const rms = Math.sqrt(sum / Math.max(1, end - start));
        const crossingRate = crossings / Math.max(1, end - start);
        rmsValues.push(rms);
        crossingValues.push(crossingRate);
        if (rms < 0.015) {
          silentFrames++;
          silentRun++;
        } else {
          if ((silentRun * frameSize) / audio.sampleRate >= 2) longPauseCount++;
          silentRun = 0;
        }
      }
      if ((silentRun * frameSize) / audio.sampleRate >= 2) longPauseCount++;
      const mean = (values: number[]) => values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
      const averageRms = mean(rmsValues);
      const averageCrossing = mean(crossingValues);
      const std = (values: number[], avg: number) => Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
      return {
        durationMs: Math.round(audio.duration * 1000),
        averageRms,
        energyStd: std(rmsValues, averageRms),
        silenceRatio: silentFrames / Math.max(1, rmsValues.length),
        longPauseCount,
        zeroCrossingMean: averageCrossing,
        zeroCrossingStd: std(crossingValues, averageCrossing)
      };
    } finally {
      await context.close();
    }
  }

  async function saveAnswer() {
    if (!selected || !selected.questions || savingRef.current) return false;
    const question = selected.questions[questionIndex];
    if (!answer.trim()) {
      setError('Please write an answer before continuing.');
      return false;
    }
    savingRef.current = true;
    setSaving(true);
    const payload = new FormData();
    payload.append('questionId', question.id);
    payload.append('transcript', answer);
    if (recordingDuration) payload.append('durationMs', String(recordingDuration));
    if (pauseMetrics) payload.append('pauseAnalysis', JSON.stringify(pauseMetrics));
    if (cameraMetrics) payload.append('cameraMetrics', JSON.stringify(cameraMetrics));

    if (recordedBlob) {
      try {
        const voiceMetrics = await analyzeRecordedVoice(recordedBlob);
        payload.append('media', recordedBlob, `answer-${question.order}.${recordedBlob.type.includes('mp4') ? 'mp4' : 'webm'}`);
        payload.append('voiceMetrics', JSON.stringify(voiceMetrics));
      } catch {
        setError('The recording could not be analyzed. The text answer will still be saved.');
      }
    }
    try {
      const response = await authFetch(`${API_URL}/interviews/${selected.id}/answers`, {
        method: 'POST',
        body: payload
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setError(data.error ?? 'Could not save answer');
        return false;
      }
      const data = await response.json();
      const answeredCount = selected.questions.filter((item, index) =>
        index === questionIndex || Boolean(item.answer?.transcript?.trim())
      ).length;

      const newAnalyses: Analysis[] = [
        data.speechAnalysis,
        data.answerContentAnalysis,
        data.voiceAnalysis,
        data.cameraAnalysis
      ].filter(Boolean);

      setSelected((current) =>
        current?.questions
          ? {
              ...current,
              answeredCount,
              questions: current.questions.map((item, index) =>
                index === questionIndex
                  ? {
                      ...item,
                      answer: {
                        transcript: answer,
                        mediaUrl: data.answer?.mediaUrl ?? null,
                        durationMs: data.answer?.durationMs ?? recordingDuration,
                        analyses: newAnalyses
                      }
                    }
                  : item
              )
            }
          : current
      );
      setInterviews((current) =>
        current.map((interview) => (interview.id === selected.id ? { ...interview, answeredCount } : interview))
      );
      setRecordedBlob(null);
      setCameraMetrics(null);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save answer');
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function completeInterview() {
    if (!selected?.questions) return false;
    const response = await authFetch(`${API_URL}/interviews/${selected.id}/complete`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error ?? 'Could not complete interview');
      return false;
    }
    setInterviews((current) => current.map((interview) => (
      interview.id === selected.id ? { ...interview, status: 'COMPLETED', report: data.report, answeredCount: selected.questions?.length ?? interview.answeredCount } : interview
    )));
    await openInterview({ ...selected, status: 'COMPLETED' }, selected.questions.length - 1);
    return true;
  }

  async function nextQuestion() {
    if (!selected?.questions || savingRef.current) return;
    if (recording) {
      setError('Stop the recording before continuing.');
      return;
    }
    const current = selected.questions[questionIndex];
    const dirty = answer.trim() !== (current.answer?.transcript ?? '').trim() || recordedBlob != null;
    if (dirty || !current.answer?.transcript?.trim()) {
      if (!(await saveAnswer())) return;
    }
    if (questionIndex < selected.questions.length - 1) {
      showQuestion(selected, questionIndex + 1);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      await completeInterview();
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function goToQuestion(index: number) {
    if (!selected?.questions || index === questionIndex || savingRef.current) return;
    if (index < 0 || index >= selected.questions.length) return;
    if (recording) {
      setError('Stop the recording before leaving this question.');
      return;
    }
    const current = selected.questions[questionIndex];
    const dirty = answer.trim() !== (current.answer?.transcript ?? '').trim() || recordedBlob != null;
    if (dirty) {
      if (!(await saveAnswer())) return;
    }
    showQuestion(selected, index);
  }

  function startCameraSampler() {
    frameStatsRef.current = { eyeScores: [], exprScores: [], postureScores: [], faceCount: 0, totalFrames: 0 };
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 120;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    cameraSamplerRef.current = window.setInterval(() => {
      try {
        const video = videoPreview.current;
        if (!video || video.paused || video.ended || !ctx) return;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imgData.data;

        let totalBrightness = 0;
        let skinPixels = 0;
        let centerSkinPixels = 0;

        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const brightness = (r + g + b) / 3;
          totalBrightness += brightness;

          const pixelIndex = i / 4;
          const x = pixelIndex % canvas.width;
          const y = Math.floor(pixelIndex / canvas.width);

          const isSkin = r > 60 && g > 40 && b > 20 && r > g && r > b && Math.abs(r - g) > 15;
          if (isSkin) {
            skinPixels++;
            if (x >= 40 && x <= 120 && y >= 20 && y <= 100) {
              centerSkinPixels++;
            }
          }
        }

        const stats = frameStatsRef.current;
        stats.totalFrames++;
        const faceDetected = skinPixels > 250;
        if (faceDetected) stats.faceCount++;

        const eyeScore = Math.min(100, Math.max(50, Math.round(75 + (centerSkinPixels / Math.max(1, skinPixels)) * 20)));
        const exprScore = Math.min(100, Math.max(50, Math.round(70 + (totalBrightness / (data.length / 4)) * 0.15)));
        const postureScore = Math.min(100, Math.max(50, Math.round(75 + (centerSkinPixels > 100 ? 15 : 0))));

        stats.eyeScores.push(eyeScore);
        stats.exprScores.push(exprScore);
        stats.postureScores.push(postureScore);
      } catch {
        // Recording must still work if frame sampling fails
      }
    }, 300);
  }

  function stopCameraSampler() {
    if (cameraSamplerRef.current) {
      window.clearInterval(cameraSamplerRef.current);
      cameraSamplerRef.current = null;
    }
    const stats = frameStatsRef.current;
    if (stats.totalFrames > 0) {
      const avg = (arr: number[]) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 75;
      setCameraMetrics({
        durationMs: recordingDuration,
        faceDetected: stats.faceCount > 0,
        eyeContactScore: avg(stats.eyeScores),
        expressionScore: avg(stats.exprScores),
        postureScore: avg(stats.postureScores),
        sampledFrames: stats.totalFrames
      });
    }
  }

  function currentQuestionText(): string {
    return selected?.questions?.[questionIndex]?.text ?? '';
  }

  function buildRecordingBlob(): Blob | null {
    if (recordedChunks.current.length === 0) return null;
    const type = mediaRecorder.current?.mimeType || recordedChunks.current[0]?.type || 'video/webm';
    return new Blob(recordedChunks.current, { type });
  }

  async function startRecording() {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      mediaStream.current = stream;
      recordedChunks.current = [];
      const mimeType = MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : '';
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      liveAborted.current = false;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordedChunks.current.push(event.data);
        if (liveCaptionsEnabled && recorder.state === 'recording') void requestLiveCaption();
      };
      recorder.onstop = () => {
        stopCameraSampler();
        const blob = new Blob(recordedChunks.current, { type: recorder.mimeType || recordedChunks.current[0]?.type || 'video/webm' });
        setRecordedBlob(blob);
        setRecordedUrl(URL.createObjectURL(blob));
        setRecordingDuration(Date.now() - recordingStartedAt.current);
        stream.getTracks().forEach((track) => track.stop());
      };
      mediaRecorder.current = recorder;
      recordingStartedAt.current = Date.now();
      setLiveCaption('');
      // A timeslice yields periodic chunks, which is what makes live captions possible.
      recorder.start(LIVE_CAPTION_INTERVAL_MS);
      setRecording(true);
      setRecordingDuration(0);
      startCameraSampler();
    } catch (cause) {
      mediaStream.current?.getTracks().forEach((track) => track.stop());
      mediaStream.current = null;
      const denied = cause instanceof DOMException && (cause.name === 'NotAllowedError' || cause.name === 'NotFoundError');
      setError(denied
        ? 'Camera and microphone access is required. Please allow permission in your browser.'
        : 'Recording could not be started in this browser.');
    }
  }

  function stopRecording() {
    liveAborted.current = true;
    if (mediaRecorder.current?.state === 'recording') {
      mediaRecorder.current.stop();
      setRecording(false);
    }
    setLiveCaption('');
  }

  /**
   * Fetches a partial transcript of everything recorded so far. Requests never
   * overlap: a slow round-trip simply means the next caption arrives later,
   * rather than a pile of uploads competing for the same audio.
   */
  async function requestLiveCaption() {
    if (liveRequestInFlight.current || liveAborted.current) return;
    const blob = buildRecordingBlob();
    if (!blob || blob.size === 0) return;
    liveRequestInFlight.current = true;
    try {
      const payload = new FormData();
      payload.append('media', blob, 'live.webm');
      payload.append('live', '1');
      const prompt = currentQuestionText();
      if (prompt) payload.append('prompt', prompt);
      const response = await authFetch(`${API_URL}/transcription`, { method: 'POST', body: payload });
      if (!response.ok || liveAborted.current) return;
      const data = await response.json();
      if (typeof data.transcript === 'string' && data.transcript.trim()) setLiveCaption(data.transcript.trim());
    } catch {
      // Live captions are best-effort; the final transcript is the one that matters.
    } finally {
      liveRequestInFlight.current = false;
    }
  }

  async function pollTranscriptionJob(jobId: string): Promise<{ transcript: string; pauseAnalysis?: PauseAnalysis | null }> {
    const deadline = Date.now() + TRANSCRIBE_POLL_TIMEOUT_MS;
    for (;;) {
      const response = await authFetch(`${API_URL}/transcription/jobs/${jobId}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Transcription failed');
      if (data.state === 'completed') return data;
      if (data.state === 'failed') throw new Error(data.error ?? 'Transcription failed');
      if (Date.now() > deadline) throw new Error('Transcription is taking longer than expected. Please try again.');
      await new Promise((resolve) => setTimeout(resolve, TRANSCRIBE_POLL_INTERVAL_MS));
    }
  }

  /**
   * Queues the recording as a server-side job and polls it. A long answer can
   * take longer than a proxy holds a single request open, and polling also lets
   * the UI show progress instead of a spinner with no upper bound.
   */
  async function transcribeRecording() {
    if (!recordedBlob) return;
    setError('');
    setTranscribing(true);
    transcribeAbort.current?.abort();
    const controller = new AbortController();
    transcribeAbort.current = controller;
    const payload = new FormData();
    payload.append('media', recordedBlob, 'answer.webm');
    const prompt = currentQuestionText();
    if (prompt) payload.append('prompt', prompt);
    try {
      const queued = await authFetch(`${API_URL}/transcription/jobs`, { method: 'POST', body: payload, signal: controller.signal });
      const queueData = await queued.json();
      if (!queued.ok) throw new Error(queueData.error ?? 'Transcription failed');
      const data = await pollTranscriptionJob(queueData.jobId);
      if (controller.signal.aborted) return;
      setAnswer(data.transcript);
      setPauseMetrics(data.pauseAnalysis ?? null);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Transcription failed');
    } finally {
      setTranscribing(false);
      transcribeAbort.current = null;
    }
  }

  async function saveAndExit() {
    if (recording) {
      setError('Stop the recording before leaving so it can be saved.');
      return;
    }
    if (!answer.trim()) {
      if (recordedBlob) {
        setError('Add a transcript, or transcribe the recording, before saving.');
        return;
      }
      leaveInterview();
      return;
    }
    if (!(await saveAnswer())) return;
    leaveInterview();
  }

  function requestLeave() {
    if (recording) {
      setError('Stop the recording before leaving this question.');
      return;
    }
    const current = selected?.questions?.[questionIndex];
    const dirty = answer.trim() !== (current?.answer?.transcript ?? '').trim() || recordedBlob != null;
    if (dirty) {
      setConfirmLeave(true);
      return;
    }
    leaveInterview();
  }

  async function logout() {
    abandonRecording();
    try {
      await authFetch(`${API_URL}/auth/logout`, { method: 'POST' });
    } catch {
    }
    setUser(null);
    setInterviews([]);
    setSelected(null);
    setError('');
    setInfo('');
  }

  if (booting) {
    return (
      <Frame className="boot-shell">
        <header className="topbar">
          <strong>InterviewSense</strong>
          <span>AI Interview Coach</span>
        </header>
        <p className="boot-status" role="status">Loading your session…</p>
      </Frame>
    );
  }

  if (!user) {
    if (mode === 'forgot') {
      return (
        <Frame className="auth-shell">
          <header className="topbar">
            <strong>InterviewSense</strong>
            <span>AI Interview Coach</span>
          </header>
          <section className="auth-layout">
            <div className="auth-copy">
              <p className="eyebrow">YOUR INTERVIEW LAB</p>
              <h1>
                Reset your<br />
                <em>password.</em>
              </h1>
              <p className="lede">Enter your email and we will send you a password reset link. For development, the token is shown directly.</p>
            </div>
            <form className="auth-card" onSubmit={submitForgot}>
              <div className="auth-tabs">
                <button type="button" onClick={() => { setMode('login'); setError(''); setInfo(''); }}>
                  Log in
                </button>
                <button type="button" onClick={() => { setMode('register'); setError(''); setInfo(''); }}>
                  Create account
                </button>
              </div>
              <h2>Forgot password</h2>
              <p className="form-intro">We will email you a link to reset your password if an account exists.</p>
              <label>
                Email
                <input type="email" required autoComplete="email" autoCapitalize="none" value={forgotEmail} onChange={(event) => setForgotEmail(event.target.value)} placeholder="you@example.com" />
              </label>
              {error && <p className="error" role="alert">{error}</p>}
              {info && <p className="notice" role="status">{info}</p>}
              {forgotResult?.resetToken && (
                <div className="dev-token">
                  <strong>Development reset token</strong>
                  <code>{forgotResult.resetToken}</code>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setResetToken(forgotResult.resetToken!);
                      setMode('reset');
                    }}
                  >
                    Use this token to reset →
                  </button>
                </div>
              )}
              <button className="submit-button" disabled={loading}>
                {loading ? 'Please wait…' : 'Send reset link →'}
              </button>
              <div className="spread">
                <button type="button" className="text-button" onClick={() => setMode('login')}>
                  Back to log in
                </button>
                <button type="button" className="text-button" onClick={() => setMode('reset')}>
                  Already have a token?
                </button>
              </div>
            </form>
          </section>
        </Frame>
      );
    }

    if (mode === 'reset') {
      return (
        <Frame className="auth-shell">
          <header className="topbar">
            <strong>InterviewSense</strong>
            <span>AI Interview Coach</span>
          </header>
          <section className="auth-layout">
            <div className="auth-copy">
              <p className="eyebrow">YOUR INTERVIEW LAB</p>
              <h1>
                Choose a<br />
                <em>new password.</em>
              </h1>
              <p className="lede">Enter the reset token and your new password. Tokens expire after one hour.</p>
            </div>
            <form className="auth-card" onSubmit={submitReset}>
              <div className="auth-tabs">
                <button type="button" onClick={() => { setMode('login'); setError(''); setInfo(''); }}>
                  Log in
                </button>
                <button type="button" onClick={() => { setMode('register'); setError(''); setInfo(''); }}>
                  Create account
                </button>
              </div>
              <h2>Reset password</h2>
              <p className="form-intro">Paste the token from your reset link and set a new password.</p>
              <label>
                Reset token
                <input required autoComplete="one-time-code" value={resetToken} onChange={(event) => setResetToken(event.target.value)} placeholder="Paste token here" />
              </label>
              <PasswordField
                label="New password"
                value={newPassword}
                autoComplete="new-password"
                shown={showPassword}
                onToggle={() => setShowPassword((current) => !current)}
                onChange={setNewPassword}
              />
              {error && <p className="error" role="alert">{error}</p>}
              {info && <p className="notice" role="status">{info}</p>}
              <button className="submit-button" disabled={loading}>
                {loading ? 'Please wait…' : 'Reset password →'}
              </button>
              <div className="spread">
                <button type="button" className="text-button" onClick={() => setMode('login')}>
                  Back to log in
                </button>
                <button type="button" className="text-button" onClick={() => setMode('forgot')}>
                  Request new link
                </button>
              </div>
            </form>
          </section>
        </Frame>
      );
    }

    return (
      <Frame className="auth-shell">
        <header className="topbar">
          <strong>InterviewSense</strong>
          <span>AI Interview Coach</span>
        </header>
        <section className="auth-layout">
          <div className="auth-copy">
            <p className="eyebrow">YOUR INTERVIEW LAB</p>
            <h1>
              Confidence is a<br />
              <em>skill you can practice.</em>
            </h1>
            <p className="lede">Practice realistic interviews and receive thoughtful feedback on your answers, voice, and presence.</p>
          </div>
          <form className="auth-card" onSubmit={submit}>
            <div className="auth-tabs">
              <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
                Log in
              </button>
              <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>
                Create account
              </button>
            </div>
            <h2>{mode === 'login' ? 'Welcome back' : 'Start practicing'}</h2>
            <p className="form-intro">{mode === 'login' ? 'Log in to continue your progress.' : 'Create your free InterviewSense account.'}</p>
            {mode === 'register' && (
              <label>
                Name
                <input autoComplete="name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Your name" />
              </label>
            )}
            <label>
              Email
              <input type="email" required autoComplete="email" autoCapitalize="none" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="you@example.com" />
            </label>
            <PasswordField
              label="Password"
              value={form.password}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              shown={showPassword}
              onToggle={() => setShowPassword((current) => !current)}
              onChange={(value) => setForm({ ...form, password: value })}
            />
            {mode === 'login' && (
              <div className="right-link">
                <button type="button" className="text-button" onClick={() => { setMode('forgot'); setError(''); setInfo(''); }}>
                  Forgot password?
                </button>
              </div>
            )}
            {error && <p className="error" role="alert">{error}</p>}
            {info && <p className="notice" role="status">{info}</p>}
            <button className="submit-button" disabled={loading}>
              {loading ? 'Please wait…' : mode === 'login' ? 'Log in →' : 'Create account →'}
            </button>
            {mode === 'login' && (
              <p className="center-note">
                <button type="button" className="text-button" onClick={() => setMode('reset')}>
                  Have a reset token? Reset password
                </button>
              </p>
            )}
          </form>
        </section>
      </Frame>
    );
  }

  if (selected?.questions?.length) {
    // Keep rendering resilient if a session's saved question count changed between loads.
    const activeQuestionIndex = Math.max(0, Math.min(questionIndex, selected.questions.length - 1));
    const question = selected.questions[activeQuestionIndex];
    const savedAnalyses = question?.answer?.analyses ?? [];
    const speech = savedAnalyses.find((item) => item.kind === 'SPEECH_FLUENCY');
    const voice = savedAnalyses.find((item) => item.kind === 'VOICE_DELIVERY');
    const eye = savedAnalyses.find((item) => item.kind === 'CAMERA_EYE_CONTACT');
    const expr = savedAnalyses.find((item) => item.kind === 'CAMERA_EXPRESSION');
    const posture = savedAnalyses.find((item) => item.kind === 'CAMERA_POSTURE');
    const content = savedAnalyses.find((item) => item.kind === 'ANSWER_CONTENT');

    const answerScore = computeAnswerOverallScore(savedAnalyses);
    const isLast = activeQuestionIndex === selected.questions.length - 1;
    const completed = selected.status === 'COMPLETED';
    const primaryLabel = isLast ? (completed ? 'Update report →' : 'Complete interview →') : 'Save and continue →';
    return (
      <Frame>
        <header className="topbar">
          <strong>InterviewSense</strong>
          <button type="button" className="text-button" onClick={requestLeave}>
            ← Dashboard
          </button>
        </header>
        <section className="interview-screen">
          <p className="eyebrow">
            {selected.title} · QUESTION {activeQuestionIndex + 1} OF {selected.questions.length}
            {selected.questionSource ? ` (${selected.questionSource.toUpperCase()} QUESTIONS)` : ''}
            {completed ? ' · REVIEW' : ''}
          </p>
          <div className="progress" aria-hidden="true">
            <span style={{ width: `${((activeQuestionIndex + 1) / selected.questions.length) * 100}%` }} />
          </div>
          <nav className="question-nav" aria-label="Questions">
            {selected.questions.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className={`question-dot plain-button${index === activeQuestionIndex ? ' current' : ''}${item.answer?.transcript?.trim() ? ' answered' : ''}`}
                aria-label={`Question ${index + 1}${item.answer?.transcript?.trim() ? ', answered' : ''}`}
                aria-current={index === activeQuestionIndex ? 'step' : undefined}
                disabled={saving}
                onClick={() => goToQuestion(index)}
              >
                {index + 1}
              </button>
            ))}
          </nav>
          {completed && selected.report?.summary && (
            <div className="report-panel">
              <p className="eyebrow">INTERVIEW REPORT</p>
              <h2>{selected.report.overallScore != null ? `${selected.report.overallScore}/100` : 'Report ready'}</h2>
              <p className="report-summary">{selected.report.summary}</p>
              <div className="report-columns">
                {!!selected.report.details?.strengths?.length && (
                  <div>
                    <b>Strengths</b>
                    <ul>{selected.report.details.strengths.map((item) => <li key={item}>{item}</li>)}</ul>
                  </div>
                )}
                {!!selected.report.details?.improvements?.length && (
                  <div>
                    <b>Next steps</b>
                    <ul>{selected.report.details.improvements.map((item) => <li key={item}>{item}</li>)}</ul>
                  </div>
                )}
              </div>
              {selected.report.details?.usedLlm === false && (
                <small className="report-note">Deterministic analysis summary — set OPENAI_API_KEY on the backend for LLM-written feedback.</small>
              )}
            </div>
          )}
          <h1>{question?.text}</h1>
          <p className="form-intro">
            {completed
              ? 'Review this answer, or edit it and update the report.'
              : 'Answer by typing or record yourself using your camera and microphone.'}
          </p>
          <div className="recorder-card">
            <div className={`camera-placeholder${recording ? ' live' : ''}`}>
              {recording ? (
                <video ref={videoPreview} muted playsInline />
              ) : recordedUrl ? (
                <video src={recordedUrl} controls />
              ) : (
                <>
                  <span aria-hidden="true">◉</span>
                  <p>Camera preview will appear in your recording</p>
                </>
              )}
            </div>
            <div className="recorder-controls">
              {!recording ? (
                <button type="button" className="record-button" onClick={startRecording}>
                  ● Start recording
                </button>
              ) : (
                <button type="button" className="record-button stop" onClick={stopRecording}>
                  ■ Stop recording
                </button>
              )}
              {(recording || recordedUrl) && (
                <small role="status">{recording ? `Recording ${formatDuration(recordingDuration)}` : `Recording ready (${formatDuration(recordingDuration)})`}</small>
              )}
              {recordedUrl && !recording && (
                <button type="button" className="transcribe-button" onClick={transcribeRecording} disabled={transcribing || saving}>
                  {transcribing ? 'Transcribing…' : 'Transcribe recording'}
                </button>
              )}
              <label className={`caption-toggle${recording ? ' locked' : ''}`} title={recording ? 'Live captions cannot be changed mid-recording' : undefined}>
                <input
                  type="checkbox"
                  checked={liveCaptionsEnabled}
                  disabled={recording}
                  onChange={(event) => setLiveCaptionsEnabled(event.target.checked)}
                />
                Live captions
              </label>
            </div>
            {recording && liveCaptionsEnabled && (
              <p className="live-caption" role="status" aria-live="polite">
                {liveCaption || 'Listening… your words will appear here as you speak.'}
              </p>
            )}
          </div>
          <label className="sr-only" htmlFor="answer">
            Your answer
          </label>
          <textarea id="answer" value={answer} onChange={(event) => { setAnswer(event.target.value); setConfirmLeave(false); }} placeholder="Write your answer here…" />
          {savedAnalyses.length > 0 && (() => {
            const metrics = speech?.details?.metrics ?? {};
            const voiceMetricsDetails = voice?.details?.metrics ?? {};
            const limitations = [...new Set(savedAnalyses.flatMap((item) => item.details?.limitations ?? []))];
            const chips: Array<[string, string]> = [];
            if (metrics.speakingRate != null) chips.push(['Speaking rate', `${metrics.speakingRate} wpm`]);
            if (metrics.fillerRate != null) chips.push(['Filler words', `${metrics.fillerRate}%`]);
            if (metrics.pauseCount != null) chips.push(['Pauses', String(metrics.pauseCount)]);
            if (metrics.longPauseCount != null) chips.push(['Long pauses', String(metrics.longPauseCount)]);
            if (voiceMetricsDetails.pauseScore != null) chips.push(['Pause score', String(voiceMetricsDetails.pauseScore)]);
            if (voiceMetricsDetails.energyScore != null) chips.push(['Energy', String(voiceMetricsDetails.energyScore)]);
            return (
              <div className="analysis-panel">
                <div>
                  <p className="eyebrow">LATEST ANALYSIS</p>
                  <h2>{answerScore != null ? `${answerScore}/100` : 'Analysis ready'}</h2>
                </div>
                <div className="metric-list">
                  {content && (
                    <span>
                      Answer content <b>{content.score ?? '—'}</b>
                    </span>
                  )}
                  {speech && (
                    <span>
                      Speech fluency <b>{speech.score ?? '—'}</b>
                    </span>
                  )}
                  {voice && (
                    <span>
                      Voice delivery <b>{voice.score ?? '—'}</b>
                    </span>
                  )}
                  {eye && (
                    <span>
                      Eye contact <b>{eye.score ?? '—'}</b>
                    </span>
                  )}
                  {expr && (
                    <span>
                      Expression <b>{expr.score ?? '—'}</b>
                    </span>
                  )}
                  {posture && (
                    <span>
                      Posture <b>{posture.score ?? '—'}</b>
                    </span>
                  )}
                  {chips.map(([label, value]) => (
                    <span key={label}>
                      {label} <b>{value}</b>
                    </span>
                  ))}
                </div>
                {limitations.length > 0 && (
                  <ul className="limitations">
                    {limitations.map((limitation) => (
                      <li key={limitation}>{limitation}</li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })()}
          {confirmLeave && (
            <p className="notice" role="status">
              This answer has unsaved changes.
              <button type="button" className="text-button danger" onClick={leaveInterview}>Discard</button>
              <button type="button" className="text-button" onClick={() => setConfirmLeave(false)}>Keep editing</button>
            </p>
          )}
          <div className="interview-actions">
            <div className="action-group">
              {activeQuestionIndex > 0 && (
                <button type="button" className="text-button" onClick={() => goToQuestion(activeQuestionIndex - 1)} disabled={saving}>
                  ← Previous
                </button>
              )}
              <button type="button" className="text-button" onClick={saveAndExit} disabled={saving}>
                Save and exit
              </button>
            </div>
            <button type="button" onClick={nextQuestion} disabled={saving}>
              {saving ? 'Saving…' : primaryLabel}
            </button>
          </div>
          {error && <p className="error" role="alert">{error}</p>}
        </section>
      </Frame>
    );
  }

  const resumeTarget = interviews.find((interview) => interview.status === 'IN_PROGRESS');
  const average = meanScore(interviews);
  const inProgress = interviews.filter((interview) => interview.status === 'IN_PROGRESS').length;
  const scoreSeries = interviews
    .filter((interview) => interview.status === 'COMPLETED' && interview.report?.overallScore != null)
    .slice()
    .reverse()
    .slice(-12);

  return (
    <Frame className="dashboard-shell">
      <header className="topbar">
        <strong>InterviewSense</strong>
        <button type="button" className="text-button" onClick={logout}>
          Log out
        </button>
      </header>
      <section className="dashboard-welcome compact">
        <p className="eyebrow">YOUR DASHBOARD</p>
        <h1>
          Welcome back,
          <br />
          <em>{user.name || user.email.split('@')[0]}.</em>
        </h1>
        <p className="lede">Practice realistic interviews and build confidence with measurable feedback.</p>
        {resumeTarget && (
          <button type="button" className="continue-button" onClick={() => openInterview(resumeTarget)} disabled={openingId === resumeTarget.id}>
            {openingId === resumeTarget.id ? 'Opening…' : <>Continue {resumeTarget.title} <span>→</span></>}
          </button>
        )}
      </section>
      <section className="dashboard-grid" aria-label="Progress summary">
        <article>
          <b>{interviewsReady ? interviews.length : '—'}</b>
          <h2>Sessions</h2>
          <p>Mock interviews started in your lab.</p>
        </article>
        <article>
          <b>{interviewsReady ? (average ?? '—') : '—'}</b>
          <h2>Average score</h2>
          <p>Mean overall score across completed sessions.</p>
        </article>
        <article>
          <b>{interviewsReady ? inProgress : '—'}</b>
          <h2>In progress</h2>
          <p>Pick up where you left off.</p>
        </article>
      </section>
      {scoreSeries.length > 0 && (
        <section className="trend">
          <div className="section-heading">
            <p className="eyebrow">TREND</p>
            <h2>Score history</h2>
          </div>
          <div className="trend-chart" role="list" aria-label="Completed interview scores, oldest to newest">
            {scoreSeries.map((interview) => (
              <div className="trend-slot" role="listitem" key={interview.id}>
                <button
                  type="button"
                  className="trend-bar plain-button"
                  style={{ height: `${Math.max(18, interview.report?.overallScore ?? 0)}%` }}
                  aria-label={`${interview.title}, ${interview.report?.overallScore} out of 100`}
                  onClick={() => openInterview(interview)}
                >
                  {interview.report?.overallScore}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
      <section className="create-panel">
        <div>
          <p className="eyebrow">NEW SESSION</p>
          <h2>Start a mock interview</h2>
          <p>Choose a focus and we will prepare your first questions.</p>
        </div>
        <form onSubmit={createInterview}>
          <input required value={interviewForm.title} onChange={(event) => setInterviewForm({ ...interviewForm, title: event.target.value })} placeholder="Interview title" aria-label="Interview title" />
          <input value={interviewForm.role} onChange={(event) => setInterviewForm({ ...interviewForm, role: event.target.value })} placeholder="Target role (optional)" aria-label="Target role" />
          <button disabled={loading}>{loading ? 'Creating…' : 'Create session →'}</button>
        </form>
      </section>
      {error && <p className="error" role="alert">{error}</p>}
      <section className="history">
        <div className="section-heading">
          <p className="eyebrow">PROGRESS</p>
          <h2>Your interviews</h2>
        </div>
        {!interviewsReady ? (
          <div className="empty-state" role="status">Loading your interviews…</div>
        ) : interviews.length === 0 ? (
          <div className="empty-state">No sessions yet. Start a mock interview above — your scores and history will collect here.</div>
        ) : (
          <div className="interview-list">
            {interviews.map((interview) => {
              const total = interview._count?.questions ?? interview.questions?.length ?? 0;
              const answered = interview.answeredCount;
              const progressLabel = interview.status === 'COMPLETED' || answered == null
                ? `${total} questions`
                : `${answered}/${total} answered`;
              return (
                <article className="interview-row" key={interview.id}>
                  <button type="button" className="plain-button row-main" onClick={() => openInterview(interview)} disabled={openingId === interview.id}>
                    <b>{interview.title}</b>
                    <p>
                      {interview.role || 'General interview'} · {progressLabel}
                      {interview.createdAt ? ` · ${formatWhen(interview.createdAt)}` : ''}
                    </p>
                  </button>
                  <div className="row-side">
                    {interview.report?.overallScore != null && <span className="score-chip">{interview.report.overallScore}/100</span>}
                    <span className={`status ${interview.status.toLowerCase()}`}>{interview.status.replace('_', ' ')}</span>
                    {pendingDelete === interview.id ? (
                      <>
                        <button type="button" className="text-button danger" onClick={() => removeInterview(interview.id)} disabled={loading}>
                          Confirm
                        </button>
                        <button type="button" className="text-button" onClick={() => setPendingDelete(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button type="button" className="text-button" onClick={() => setPendingDelete(interview.id)} aria-label={`Delete ${interview.title}`}>
                        Delete
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </Frame>
  );
}

createRoot(document.getElementById('root')!).render(
  <AppErrorBoundary><App /></AppErrorBoundary>
);
