import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signMediaUrl, toSignedMediaUrl, verifyMediaSignature } from './mediaSign.js';

process.env.JWT_SECRET ||= 'test-secret-for-media-signing-0123456789';

const FILENAME = 'abcdef0123456789abcdef0123456789';

function parseSigned(url: string) {
  const match = url.match(/^\/api\/v1\/media\/([A-Za-z0-9_-]+)\?e=(\d+)&s=([a-f0-9]{64})$/);
  assert.ok(match, `signed URL has unexpected shape: ${url}`);
  return { filename: match[1], expiresAt: Number(match[2]), signature: match[3] };
}

test('signMediaUrl produces a verifiable URL shape', () => {
  const { filename, expiresAt, signature } = parseSigned(signMediaUrl(FILENAME));
  assert.equal(filename, FILENAME);
  assert.ok(expiresAt > Math.floor(Date.now() / 1000));
  assert.equal(verifyMediaSignature(filename, expiresAt, signature), true);
});

test('verifyMediaSignature rejects tampered input', () => {
  const { filename, expiresAt, signature } = parseSigned(signMediaUrl(FILENAME));
  assert.equal(verifyMediaSignature(filename, expiresAt, signature.replace(/^./, '0')), false);
  assert.equal(verifyMediaSignature('ff'.repeat(16), expiresAt, signature), false);
  const nowSeconds = Math.floor(Date.now() / 1000);
  assert.equal(verifyMediaSignature(filename, nowSeconds - 10, signature), false);
  assert.equal(verifyMediaSignature('../secret', expiresAt, signature), false);
  assert.equal(verifyMediaSignature(filename, expiresAt, 'not-hex'), false);
});

test('toSignedMediaUrl signs stored uploads and passes through external URLs', () => {
  const signed = toSignedMediaUrl(`/uploads/${FILENAME}`);
  assert.ok(signed?.startsWith(`/api/v1/media/${FILENAME}?e=`));
  assert.equal(toSignedMediaUrl('https://cdn.example.com/x.webm'), 'https://cdn.example.com/x.webm');
  assert.equal(toSignedMediaUrl('/uploads/../etc/passwd'), null);
  assert.equal(toSignedMediaUrl(null), null);
  assert.equal(toSignedMediaUrl(undefined), null);
});

test('signMediaUrl refuses unsafe filenames', () => {
  assert.throws(() => signMediaUrl('../traversal'));
  assert.throws(() => signMediaUrl('a/b'));
  assert.throws(() => signMediaUrl('x'));
});
