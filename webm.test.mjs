import test from "node:test";
import assert from "node:assert/strict";
import { durationOf, withDuration } from "./webm.js";

// A tiny WebM, built by hand: EBML header, a Segment holding Info and a Cluster.
const bytes = (...parts) => Uint8Array.from(parts.flat());
const el = (id, body, size = null) => {
  const head = [];
  for (let v = id; v; v = Math.floor(v / 256)) head.unshift(v % 256);
  return [...head, ...(size ?? [0x80 | body.length]), ...body];
};
const EBML = el(0x1a45dfa3, el(0x4282, [0x77, 0x65, 0x62, 0x6d])); // DocType "webm"
const SCALE = el(0x2ad7b1, [0x0f, 0x42, 0x40]); // 1,000,000 ns
const APP = el(0x4d80, [0x43, 0x68]); // MuxingApp "Ch"
const CLUSTER = el(0x1f43b675, [0xe7, 0x81, 0x00]); // Timecode 0
const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const webm = (info, { known = false, before = [] } = {}) => {
  const children = [...before, ...el(0x1549a966, info), ...CLUSTER];
  return bytes(EBML, el(0x18538067, children, known ? [0x80 | children.length] : UNKNOWN));
};

test("MediaRecorder's file (no Duration, Segment of unknown size) gets one", () => {
  const src = webm([...SCALE, ...APP]);
  assert.equal(durationOf(src), null);
  const out = withDuration(src, 4321.5);
  assert.equal(durationOf(out), 4321.5);
  // Everything after Info is untouched.
  assert.deepEqual([...out.slice(out.length - CLUSTER.length)], CLUSTER);
});

test("a Segment of known size grows with its Info; a SeekHead before Info is kept", () => {
  const seek = el(0x114d9b74, [0xec, 0x80]); // SeekHead holding an empty Void
  const src = webm([...APP], { known: true, before: seek });
  const out = withDuration(src, 1000);
  assert.equal(durationOf(out), 1000);
  // Segment's size now says 8 bytes, and covers the rest of the file.
  const segAt = EBML.length + 4;
  assert.equal(out[segAt], 0x01);
  let size = 0;
  for (let i = 1; i < 8; i++) size = size * 256 + out[segAt + i];
  assert.equal(segAt + 8 + size, out.length);
  assert.ok(withDuration(src, 0)); // zero is a length too
});

test("an 8- or 4-byte Duration is overwritten in place; another size is replaced", () => {
  const d8 = el(0x4489, [0, 0, 0, 0, 0, 0, 0, 0]);
  const d4 = el(0x4489, [0, 0, 0, 0]);
  const d2 = el(0x4489, [0, 0]);
  const scale2 = el(0x2ad7b1, [0x07, 0xa1, 0x20]); // 500,000 ns a tick
  for (const [info, expect] of [
    [[...SCALE, ...d8], 2500],
    [[...SCALE, ...d4], 2500],
    [[...scale2, ...d8], 2500],
  ]) {
    const src = webm(info);
    const out = withDuration(src, 2500);
    assert.equal(out.length, src.length);
    assert.equal(durationOf(out), expect);
  }
  const out = withDuration(webm([...SCALE, ...d2]), 2500);
  assert.equal(durationOf(out), 2500);
  const zero = el(0x2ad7b1, [0x00]); // a scale of 0 means the default
  assert.equal(durationOf(withDuration(webm([...zero]), 10)), 10);
});

test("what is not a WebM is refused, and the caller keeps its file", () => {
  assert.throws(() => withDuration("nope", 1), /Not a WebM/);
  assert.throws(() => withDuration(webm([]), -1), /milliseconds/);
  assert.throws(() => withDuration(new Uint8Array([0x00]), 1), /Not a WebM/);
  assert.throws(() => withDuration(new Uint8Array([0x1a, 0x45]), 1), /Not a WebM/);
  assert.throws(() => withDuration(bytes(el(0x1a45dfa3, [], UNKNOWN)), 1), /Not a WebM/);
  assert.throws(() => withDuration(bytes(EBML, el(0x1f43b675, [])), 1), /Not a WebM/);
  // A Segment whose first child is of unknown size: no Info before it.
  assert.throws(() => withDuration(bytes(EBML, el(0x18538067, el(0x1f43b675, [], UNKNOWN), UNKNOWN)), 1), /no Info/);
  assert.throws(() => withDuration(bytes(EBML, el(0x18538067, CLUSTER, UNKNOWN)), 1), /no Info/);
  // An Info whose child runs past it.
  const bad = bytes(EBML, el(0x18538067, el(0x1549a966, [0x4d, 0x80, 0x85, 0x41]), UNKNOWN));
  assert.throws(() => withDuration(bad, 1), /Not a WebM/);
  assert.equal(durationOf(bytes(EBML, el(0x18538067, CLUSTER, UNKNOWN))), null);
  assert.equal(durationOf(bytes(EBML, el(0x18538067, el(0x1f43b675, [], UNKNOWN), UNKNOWN))), null);
});
