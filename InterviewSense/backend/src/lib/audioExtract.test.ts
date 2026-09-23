import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractAudioForTranscription } from './audioExtract.js';

/**
 * Runs a case against a stand-in `ffmpeg`. The real binary is not guaranteed to
 * exist (and this only needs to prove how the caller invokes it and handles the
 * outcome), so the stub records its arguments and fakes an output file.
 */
async function withFakeFfmpeg(script: string, run: (ffmpegPath: string, argsFile: string) => Promise<void>) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ffmpeg-stub-'));
  const argsFile = path.join(dir, 'args.txt');
  const bin = path.join(dir, 'ffmpeg');
  await fsp.writeFile(bin, [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > '${argsFile}'`,
    'out=""',
    'for arg in "$@"; do out="$arg"; done',
    script
  ].join('\n'));
  await fsp.chmod(bin, 0o755);
  try {
    await run(bin, argsFile);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

const upload = { buffer: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]), name: 'answer.webm', type: 'video/webm' };

test('re-encodes the upload to 16 kHz mono wav', async () => {
  await withFakeFfmpeg('head -c 320 /dev/zero > "$out"', async (ffmpegPath, argsFile) => {
    const result = await extractAudioForTranscription(upload, { ffmpegPath });
    assert.equal(result.extracted, true);
    assert.equal(result.type, 'audio/wav');
    assert.match(result.name, /^audio-[0-9a-f]{12}\.wav$/);
    assert.equal(result.buffer.length, 320);

    const args = (await fsp.readFile(argsFile, 'utf8')).trim().split('\n');
    for (const expected of ['-hide_banner', '-nostdin', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav']) {
      assert.ok(args.includes(expected), `ffmpeg was called with ${expected}`);
    }
    const inputArg = args[args.indexOf('-i') + 1];
    assert.match(inputArg, /input\.webm$/, 'the input is written with an extension matching its media type');
  });
});

test('falls back to the original upload when ffmpeg is missing', async () => {
  const result = await extractAudioForTranscription(upload, { ffmpegPath: '/nonexistent/ffmpeg-binary' });
  assert.equal(result.extracted, false);
  assert.equal(result.reason, 'ffmpeg-not-found');
  assert.deepEqual(result.buffer, upload.buffer, 'the caller still gets the audio it uploaded');
  assert.equal(result.type, 'video/webm');
});

test('falls back when ffmpeg fails', async () => {
  await withFakeFfmpeg('echo "unsupported codec" >&2; exit 1', async (ffmpegPath) => {
    const result = await extractAudioForTranscription(upload, { ffmpegPath });
    assert.equal(result.extracted, false);
    assert.equal(result.reason, 'ffmpeg-failed');
    assert.deepEqual(result.buffer, upload.buffer);
  });
});

test('falls back when ffmpeg produces no usable audio', async () => {
  await withFakeFfmpeg('head -c 44 /dev/zero > "$out"', async (ffmpegPath) => {
    const result = await extractAudioForTranscription(upload, { ffmpegPath });
    assert.equal(result.extracted, false);
    assert.equal(result.reason, 'ffmpeg-produced-no-audio');
  });
});

test('a hung ffmpeg is killed and the original upload is used', async () => {
  await withFakeFfmpeg('sleep 5; head -c 320 /dev/zero > "$out"', async (ffmpegPath) => {
    const started = Date.now();
    const result = await extractAudioForTranscription(upload, { ffmpegPath, timeoutMs: 250 });
    assert.equal(result.extracted, false);
    assert.equal(result.reason, 'ffmpeg-timed-out');
    assert.ok(Date.now() - started < 3000, 'the wait is bounded by the timeout');
  });
});

test('extraction can be switched off', async () => {
  const result = await extractAudioForTranscription(upload, { enabled: false });
  assert.equal(result.extracted, false);
  assert.equal(result.reason, 'extraction-disabled');
  assert.deepEqual(result.buffer, upload.buffer);
});

test('cleans up its temporary working directory', async () => {
  const before = (await fsp.readdir(os.tmpdir())).filter((name) => name.startsWith('interviewsense-audio-'));
  await withFakeFfmpeg('head -c 320 /dev/zero > "$out"', async (ffmpegPath) => {
    await extractAudioForTranscription(upload, { ffmpegPath });
  });
  const after = (await fsp.readdir(os.tmpdir())).filter((name) => name.startsWith('interviewsense-audio-'));
  assert.deepEqual(after, before, 'no working directory was left behind');
});
