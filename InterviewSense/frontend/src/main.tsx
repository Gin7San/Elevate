import { FormEvent, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type User = { id: string; email: string; name: string | null };
type Analysis = { id: string; kind: string; score: number | null; details: { metrics?: Record<string, number | null> } | null };
type Question = { id: string; text: string; order: number; answer: { transcript: string; mediaUrl?: string | null; durationMs?: number | null; analyses?: Analysis[] } | null };
type Interview = { id: string; title: string; role: string | null; status: string; createdAt: string; _count?: { questions: number }; report: { overallScore: number | null } | null; questions?: Question[] };
type AuthResponse = { user: User; token?: string; csrfToken?: string };
const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '/api/v1';
const MEDIA_URL = (import.meta.env.VITE_MEDIA_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const CSRF_COOKIE = 'interviewsense_csrf';

function getCookieValue(name: string): string {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : '';
}

/**
 * Session lives in an HttpOnly cookie set by the API. Unsafe requests echo the
 * readable CSRF cookie back in a header (double-submit protection).
 */
function authFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  if (method !== 'GET' && method !== 'HEAD') {
    const csrfToken = getCookieValue(CSRF_COOKIE);
    if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
  }
  return fetch(input, { credentials: 'include', ...init, headers });
}

function App() {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot' | 'reset'>('login');
  const [user, setUser] = useState<User | null>(null);
  const [interviews, setInterviews] = useState<Interview[]>([]);
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
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [interviewForm, setInterviewForm] = useState({ title: '', role: '' });
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotResult, setForgotResult] = useState<{ message: string; resetToken?: string } | null>(null);
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  useEffect(() => {
    authFetch(`${API_URL}/me`)
      .then(async (r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setUser(d.user))
      .catch(() => setUser(null));
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
    if (recording && videoPreview.current && mediaStream.current) {
      videoPreview.current.srcObject = mediaStream.current;
      videoPreview.current.play().catch(() => undefined);
    }
  }, [recording]);

  useEffect(() => {
    if (!user) return;
    authFetch(`${API_URL}/interviews`)
      .then((r) => r.json())
      .then((d) => setInterviews(d.interviews ?? []))
      .catch(() => setError('Could not load your interviews.'));
  }, [user]);

  useEffect(() => () => {
    if (recordedUrl.startsWith('blob:')) URL.revokeObjectURL(recordedUrl);
  }, [recordedUrl]);

  useEffect(() => () => mediaStream.current?.getTracks().forEach((track) => track.stop()), []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setInfo('');
    setLoading(true);
    try {
      const r = await authFetch(`${API_URL}/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'register' ? form : { email: form.email, password: form.password })
      });
      const d = (await r.json()) as AuthResponse & { error?: string };
      if (!r.ok) throw new Error(d.error ?? 'Something went wrong');
      // Server sets the HttpOnly session cookie; nothing is stored in JS.
      setUser(d.user);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to connect to the API');
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
      const r = await authFetch(`${API_URL}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmail })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? 'Could not request password reset');
      setForgotResult({ message: d.message, resetToken: d.resetToken });
      setInfo(d.message);
      if (d.resetToken) {
        setResetToken(d.resetToken);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to connect to the API');
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
      const r = await authFetch(`${API_URL}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, password: newPassword })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? 'Could not reset password');
      setInfo(d.message ?? 'Password has been reset successfully. You can now log in.');
      setMode('login');
      setNewPassword('');
      // Clear token from URL
      window.history.replaceState({}, '', window.location.pathname);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to connect to the API');
    } finally {
      setLoading(false);
    }
  }

  async function createInterview(event: FormEvent) {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const r = await authFetch(`${API_URL}/interviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(interviewForm)
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      const created = { ...d.interview, _count: { questions: d.interview.questions.length }, report: null };
      setInterviews((current) => [created, ...current]);
      setInterviewForm({ title: '', role: '' });
      openInterview(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create interview');
    } finally {
      setLoading(false);
    }
  }

  async function openInterview(interview: Interview) {
    setError('');
    const r = await authFetch(`${API_URL}/interviews/${interview.id}`);
    const d = await r.json();
    if (!r.ok) return setError(d.error ?? 'Could not load interview');
    setSelected(d.interview);
    setQuestionIndex(0);
    setAnswer(d.interview.questions[0]?.answer?.transcript ?? '');
    setRecordedUrl(d.interview.questions[0]?.answer?.mediaUrl ? `${MEDIA_URL}${d.interview.questions[0].answer.mediaUrl}` : '');
    setRecordedBlob(null);
    setRecordingDuration(d.interview.questions[0]?.answer?.durationMs ?? 0);
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
      const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
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
    if (!selected || !selected.questions) return false;
    const question = selected.questions[questionIndex];
    if (!answer.trim()) {
      setError('Please write an answer before continuing.');
      return false;
    }
    const payload = new FormData();
    payload.append('questionId', question.id);
    payload.append('transcript', answer);
    if (recordingDuration) payload.append('durationMs', String(recordingDuration));
    if (recordedBlob) {
      try {
        const voiceMetrics = await analyzeRecordedVoice(recordedBlob);
        payload.append('media', recordedBlob, `answer-${question.order}.${recordedBlob.type.includes('mp4') ? 'mp4' : 'webm'}`);
        payload.append('voiceMetrics', JSON.stringify(voiceMetrics));
      } catch {
        setError('The recording could not be analyzed. The text answer will still be saved.');
      }
    }
    const r = await authFetch(`${API_URL}/interviews/${selected.id}/answers`, {
      method: 'POST',
      body: payload
    });
    if (!r.ok) {
      const d = await r.json();
      setError(d.error ?? 'Could not save answer');
      return false;
    }
    const data = await r.json();
    setSelected((current) =>
      current?.questions
        ? {
            ...current,
            questions: current.questions.map((item, index) =>
              index === questionIndex
                ? {
                    ...item,
                    answer: {
                      transcript: answer,
                      mediaUrl: data.answer?.mediaUrl ?? null,
                      durationMs: data.answer?.durationMs ?? recordingDuration,
                      analyses: [data.speechAnalysis, data.voiceAnalysis].filter(Boolean)
                    }
                  }
                : item
            )
          }
        : current
    );
    return true;
  }

  async function nextQuestion() {
    if (!(await saveAnswer()) || !selected?.questions) return;
    if (questionIndex < selected.questions.length - 1) {
      const next = questionIndex + 1;
      setQuestionIndex(next);
      setAnswer(selected.questions[next].answer?.transcript ?? '');
      setRecordedUrl(selected.questions[next].answer?.mediaUrl ? `${MEDIA_URL}${selected.questions[next].answer.mediaUrl}` : '');
      setRecordedBlob(null);
      setRecordingDuration(selected.questions[next].answer?.durationMs ?? 0);
    } else {
      const r = await authFetch(`${API_URL}/interviews/${selected.id}/complete`, {
        method: 'POST'
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error ?? 'Could not complete interview');
        return;
      }
      setSelected(null);
      setInterviews((current) => current.map((i) => (i.id === selected.id ? { ...i, status: 'COMPLETED', report: data.report } : i)));
    }
  }

  async function startRecording() {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      mediaStream.current = stream;
      recordedChunks.current = [];
      const mimeType = MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : '';
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordedChunks.current.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(recordedChunks.current, { type: recorder.mimeType || recordedChunks.current[0]?.type || 'video/webm' });
        setRecordedBlob(blob);
        setRecordedUrl(URL.createObjectURL(blob));
        setRecordingDuration(Date.now() - recordingStartedAt.current);
        stream.getTracks().forEach((track) => track.stop());
      };
      mediaRecorder.current = recorder;
      recordingStartedAt.current = Date.now();
      recorder.start();
      setRecording(true);
    } catch {
      setError('Camera and microphone access is required. Please allow permission in your browser.');
    }
  }

  function stopRecording() {
    if (mediaRecorder.current?.state === 'recording') {
      mediaRecorder.current.stop();
      setRecording(false);
    }
  }

  async function transcribeRecording() {
    if (!recordedBlob) return;
    setError('');
    setTranscribing(true);
    const payload = new FormData();
    payload.append('media', recordedBlob, 'answer.webm');
    try {
      const r = await authFetch(`${API_URL}/transcription`, {
        method: 'POST',
        body: payload
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? 'Transcription failed');
      setAnswer(data.transcript);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transcription failed');
    } finally {
      setTranscribing(false);
    }
  }

  async function saveAndExit() {
    if (answer.trim() && !(await saveAnswer())) return;
    stopRecording();
    setSelected(null);
  }

  async function logout() {
    stopRecording();
    try {
      await authFetch(`${API_URL}/auth/logout`, { method: 'POST' });
    } catch {
      // Cookie cleanup is best-effort; local state is cleared either way.
    }
    setUser(null);
    setInterviews([]);
    setSelected(null);
  }

  if (!user) {
    if (mode === 'forgot') {
      return (
        <main className="shell auth-shell">
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
                <input type="email" required value={forgotEmail} onChange={(e) => setForgotEmail(e.target.value)} placeholder="you@example.com" />
              </label>
              {error && <p className="error">{error}</p>}
              {info && <p className="error" style={{ background: '#e9f5ec', color: '#1a4d2e', border: '1px solid #c3e6cb' }}>{info}</p>}
              {forgotResult?.resetToken && (
                <div style={{ marginTop: '12px', padding: '10px', background: '#f0f4ff', borderRadius: '8px', fontSize: '12px', wordBreak: 'break-all' }}>
                  <strong>Development reset token:</strong>
                  <div style={{ marginTop: '6px', fontFamily: 'monospace' }}>{forgotResult.resetToken}</div>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setResetToken(forgotResult.resetToken!);
                      setMode('reset');
                    }}
                    style={{ marginTop: '8px' }}
                  >
                    Use this token to reset →
                  </button>
                </div>
              )}
              <button className="submit-button" disabled={loading}>
                {loading ? 'Please wait…' : 'Send reset link →'}
              </button>
              <div style={{ marginTop: '12px', display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                <button type="button" className="text-button" onClick={() => setMode('login')}>
                  Back to log in
                </button>
                <button type="button" className="text-button" onClick={() => setMode('reset')}>
                  Already have a token?
                </button>
              </div>
            </form>
          </section>
        </main>
      );
    }

    if (mode === 'reset') {
      return (
        <main className="shell auth-shell">
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
                <input required value={resetToken} onChange={(e) => setResetToken(e.target.value)} placeholder="Paste token here" />
              </label>
              <label>
                New password
                <input type="password" required minLength={8} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="At least 8 characters" />
              </label>
              {error && <p className="error">{error}</p>}
              {info && <p className="error" style={{ background: '#e9f5ec', color: '#1a4d2e', border: '1px solid #c3e6cb' }}>{info}</p>}
              <button className="submit-button" disabled={loading}>
                {loading ? 'Please wait…' : 'Reset password →'}
              </button>
              <div style={{ marginTop: '12px', display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                <button type="button" className="text-button" onClick={() => setMode('login')}>
                  Back to log in
                </button>
                <button type="button" className="text-button" onClick={() => setMode('forgot')}>
                  Request new link
                </button>
              </div>
            </form>
          </section>
        </main>
      );
    }

    return (
      <main className="shell auth-shell">
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
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Your name" />
              </label>
            )}
            <label>
              Email
              <input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="you@example.com" />
            </label>
            <label>
              Password
              <input type="password" required minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="At least 8 characters" />
            </label>
            {mode === 'login' && (
              <div style={{ textAlign: 'right', marginTop: '8px' }}>
                <button type="button" className="text-button" onClick={() => { setMode('forgot'); setError(''); setInfo(''); }} style={{ fontSize: '12px' }}>
                  Forgot password?
                </button>
              </div>
            )}
            {error && <p className="error">{error}</p>}
            {info && <p className="error" style={{ background: '#e9f5ec', color: '#1a4d2e', border: '1px solid #c3e6cb' }}>{info}</p>}
            <button className="submit-button" disabled={loading}>
              {loading ? 'Please wait…' : mode === 'login' ? 'Log in →' : 'Create account →'}
            </button>
            {mode === 'login' && (
              <p style={{ textAlign: 'center', marginTop: '12px', fontSize: '12px', color: '#65716b' }}>
                <button type="button" className="text-button" onClick={() => setMode('reset')} style={{ fontSize: '12px' }}>
                  Have a reset token? Reset password
                </button>
              </p>
            )}
          </form>
        </section>
      </main>
    );
  }

  if (selected?.questions) {
    const question = selected.questions[questionIndex];
    const savedAnalyses = question.answer?.analyses ?? [];
    const speech = savedAnalyses.find((item) => item.kind === 'SPEECH_FLUENCY');
    const voice = savedAnalyses.find((item) => item.kind === 'VOICE_DELIVERY');
    const answerScore =
      speech?.score != null && voice?.score != null ? Math.round(speech.score * 0.4 + voice.score * 0.6) : speech?.score ?? voice?.score;
    return (
      <main className="shell">
        <header className="topbar">
          <strong>InterviewSense</strong>
          <button className="text-button" onClick={() => setSelected(null)}>
            ← Dashboard
          </button>
        </header>
        <section className="interview-screen">
          <p className="eyebrow">
            {selected.title} · QUESTION {questionIndex + 1} OF {selected.questions.length}
          </p>
          <div className="progress">
            <span style={{ width: `${((questionIndex + 1) / selected.questions.length) * 100}%` }} />
          </div>
          <h1>{question.text}</h1>
          <p className="form-intro">Answer by typing or record yourself using your camera and microphone.</p>
          <div className="recorder-card">
            <div className="camera-placeholder">
              {recording ? (
                <video ref={videoPreview} muted playsInline />
              ) : recordedUrl ? (
                <video src={recordedUrl} controls />
              ) : (
                <>
                  <span>◉</span>
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
              {recordedUrl && (
                <>
                  <small>Recording ready ({Math.round(recordingDuration / 1000)}s)</small>
                  <button type="button" className="transcribe-button" onClick={transcribeRecording} disabled={transcribing}>
                    {transcribing ? 'Transcribing…' : 'Transcribe recording'}
                  </button>
                </>
              )}
            </div>
          </div>
          <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Write your answer here…" />
          {savedAnalyses.length > 0 && (
            <div className="analysis-panel">
              <div>
                <p className="eyebrow">LATEST ANALYSIS</p>
                <h2>{answerScore != null ? `${answerScore}/100` : 'Analysis ready'}</h2>
              </div>
              <div className="metric-list">
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
              </div>
            </div>
          )}
          <div className="interview-actions">
            <button className="text-button" onClick={saveAndExit}>
              Save and exit
            </button>
            <button onClick={nextQuestion}>{questionIndex === selected.questions.length - 1 ? 'Complete interview →' : 'Save and continue →'}</button>
          </div>
          {error && <p className="error">{error}</p>}
        </section>
      </main>
    );
  }

  return (
    <main className="shell dashboard-shell">
      <header className="topbar">
        <strong>InterviewSense</strong>
        <button className="text-button" onClick={logout}>
          Log out
        </button>
      </header>
      <section className="dashboard-welcome">
        <p className="eyebrow">YOUR DASHBOARD</p>
        <h1>
          Welcome back,
          <br />
          <em>{user.name || user.email.split('@')[0]}.</em>
        </h1>
        <p className="lede">Practice realistic interviews and build confidence with measurable feedback.</p>
      </section>
      <section className="create-panel">
        <div>
          <p className="eyebrow">NEW SESSION</p>
          <h2>Start a mock interview</h2>
          <p>Choose a focus and we will prepare your first questions.</p>
        </div>
        <form onSubmit={createInterview}>
          <input required value={interviewForm.title} onChange={(e) => setInterviewForm({ ...interviewForm, title: e.target.value })} placeholder="Interview title" />
          <input value={interviewForm.role} onChange={(e) => setInterviewForm({ ...interviewForm, role: e.target.value })} placeholder="Target role (optional)" />
          <button disabled={loading}>{loading ? 'Creating…' : 'Create session →'}</button>
        </form>
      </section>
      {error && <p className="error">{error}</p>}
      <section className="history">
        <div className="section-heading">
          <p className="eyebrow">PROGRESS</p>
          <h2>Your interviews</h2>
        </div>
        {interviews.length === 0 ? (
          <div className="empty-state">Your interview history will appear here after you create your first session.</div>
        ) : (
          <div className="interview-list">
            {interviews.map((i) => (
              <article className="interview-row" key={i.id} onClick={() => openInterview(i)}>
                <div>
                  <b>{i.title}</b>
                  <p>
                    {i.role || 'General interview'} · {i._count?.questions ?? 0} questions
                  </p>
                </div>
                <span className={`status ${i.status.toLowerCase()}`}>{i.status.replace('_', ' ')}</span>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
