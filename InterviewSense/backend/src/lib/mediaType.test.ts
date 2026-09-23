import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAcceptedMediaType,
  isPlausibleMediaType,
  isUnknownMediaType,
  normalizeMediaType,
  resolveMediaType,
  sniffContentType
} from './mediaType.js';

// EBML header: what a WebM recording starts with.
const webmHead = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81, 0x01]);
const notMedia = Buffer.from('not a recording at all', 'utf8');

test('normalizes a declared media type', () => {
  assert.equal(normalizeMediaType('VIDEO/WEBM'), 'video/webm');
  assert.equal(normalizeMediaType('video/webm;codecs=vp8,opus'), 'video/webm');
  assert.equal(normalizeMediaType('  audio/mpeg ' ), 'audio/mpeg');
  assert.equal(normalizeMediaType(undefined), '');
});

test('accepts the supported media types', () => {
  for (const type of ['video/webm', 'video/mp4', 'audio/webm', 'audio/mpeg', 'audio/wav', 'audio/ogg']) {
    assert.equal(isAcceptedMediaType(type), true, type);
  }
  assert.equal(isAcceptedMediaType('application/pdf'), false);
  assert.equal(isAcceptedMediaType('text/plain'), false);
});

test('treats a dropped Content-Type header as unknown rather than wrong', () => {
  // busboy reports `text/plain` for `video/webm;codecs=vp8,opus` because the
  // comma in the unquoted parameter value makes the header unparseable.
  assert.equal(isUnknownMediaType('text/plain'), true);
  assert.equal(isUnknownMediaType('application/octet-stream'), true);
  assert.equal(isUnknownMediaType(''), true);
  assert.equal(isUnknownMediaType('video/webm'), false);
});

test('the multer filter defers unknown types and rejects contradicting ones', () => {
  assert.equal(isPlausibleMediaType('text/plain'), true);
  assert.equal(isPlausibleMediaType('video/webm;codecs=vp8,opus'), true);
  assert.equal(isPlausibleMediaType('application/pdf'), false);
});

test('sniffs recordings from their magic bytes', () => {
  assert.equal(sniffContentType(webmHead), 'video/webm');
  assert.equal(sniffContentType(Buffer.from('\x00\x00\x00 ftypmp42', 'latin1')), 'video/mp4');
  assert.equal(sniffContentType(Buffer.from('OggS\x00\x02\x00\x00\x00\x00\x00\x00', 'latin1')), 'audio/ogg');
  assert.equal(sniffContentType(Buffer.from('RIFF\x00\x00\x00\x00WAVE', 'latin1')), 'audio/wav');
  assert.equal(sniffContentType(Buffer.from('ID3\x03\x00\x00\x00\x00', 'latin1')), 'audio/mpeg');
  assert.equal(sniffContentType(notMedia), 'application/octet-stream');
});

test('resolves a browser recording whose declared type busboy dropped', () => {
  assert.equal(resolveMediaType('text/plain', webmHead), 'video/webm');
});

test('keeps a usable declared type', () => {
  assert.equal(resolveMediaType('video/webm;codecs=vp8,opus', webmHead), 'video/webm');
  assert.equal(resolveMediaType('AUDIO/MPEG', notMedia), 'audio/mpeg');
});

test('rejects content that is not a supported recording', () => {
  assert.equal(resolveMediaType('text/plain', notMedia), null);
  assert.equal(resolveMediaType('application/pdf', webmHead), null);
  assert.equal(resolveMediaType('text/plain', Buffer.alloc(0)), null);
});
