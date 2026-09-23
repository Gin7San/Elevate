import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extensionForMediaType } from './mediaType.js';

export type AudioPayload = { buffer: Buffer; name: string; type: string };
export type ExtractionResult = AudioPayload & { extracted: boolean; reason?: string };

/**
 * Reduces an uploaded recording to 16 kHz mono WAV before it is sent to the
 * transcription provider.
 *
 * The SPA records video, so an upload is mostly pixels: Whisper only needs the
 * audio track. Re-encoding typically shrinks the payload by an order of
 * magnitude, which makes the upload faster and the provider's own file limits
 * far harder to hit. Any local engine requires PCM in the first place.
 *
 * Extraction is strictly an optimisation: if ffmpeg is missing, times out, or
 * produces nothing usable, the original upload is returned untouched so
 * transcription still happens.
 */
export async function extractAudioForTranscription(
  input: AudioPayload,
  options: { ffmpegPath?: string; timeoutMs?: number; enabled?: boolean } = {}
): Promise<ExtractionResult> {
  const { ffmpegPath = 'ffmpeg', timeoutMs = 60_000, enabled = true } = options;
  if (!enabled) return { ...input, extracted: false, reason: 'extraction-disabled' };

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'interviewsense-audio-'));
  const inputPath = path.join(workDir, `input.${extensionForMediaType(input.type)}`);
  const outputPath = path.join(workDir, 'output.wav');

  try {
    await fsp.writeFile(inputPath, input.buffer);
    await runFfmpeg(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-i', inputPath,
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav',
      outputPath
    ], timeoutMs);

    const extracted = await fsp.readFile(outputPath);
    // A WAV header with no samples is not usable audio.
    if (extracted.length <= 44) return { ...input, extracted: false, reason: 'ffmpeg-produced-no-audio' };
    return { buffer: extracted, name: `audio-${crypto.randomBytes(6).toString('hex')}.wav`, type: 'audio/wav', extracted: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    const reason = code === 'ENOENT' ? 'ffmpeg-not-found'
      : code === 'ETIMEDOUT' ? 'ffmpeg-timed-out'
      : 'ffmpeg-failed';
    return { ...input, extracted: false, reason };
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runFfmpeg(ffmpegPath: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error('ffmpeg timed out'), { code: 'ETIMEDOUT' }));
    }, timeoutMs);

    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      if (exitCode === 0) resolve();
      else reject(Object.assign(new Error(`ffmpeg exited with ${exitCode}: ${stderr.slice(0, 500)}`), { code: 'EEXIT' }));
    });
  });
}
