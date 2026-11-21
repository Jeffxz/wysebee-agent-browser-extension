// A duration for a WebM file Chrome's MediaRecorder made.
//
// MediaRecorder writes its WebM as it goes, so it never knows the length: the Segment's
// Info has no Duration, and players show no length and cannot seek. withDuration adds
// one (or overwrites a stale one) once the recording is finished, which is all a player
// needs to show a timeline and seek.
//
// Pure, no DOM: `node --test` covers it. EBML in brief: every element is an ID (a
// variable-length integer that keeps its length marker), a size (one that does not; all
// ones means "unknown", which MediaRecorder uses for the Segment) and that many bytes.

const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TIMECODE_SCALE = 0x2ad7b1;
const DURATION = 0x4489;
const DEFAULT_SCALE = 1_000_000; // nanoseconds per tick: ticks are milliseconds

/** A variable-length integer at `pos`: `{value, length, unknown}`; the ID form keeps its marker. */
function vint(bytes, pos, keepMarker) {
  const first = bytes[pos];
  if (first === undefined || first === 0) throw new Error("Not a WebM file.");
  let length = 1;
  while (!(first & (0x80 >> (length - 1)))) length++;
  if (pos + length > bytes.length) throw new Error("Not a WebM file.");
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[pos + i];
    if (bytes[pos + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

/** One element's header at `pos`: `{id, start, dataStart, size, end}` (`end` null if unknown). */
function element(bytes, pos) {
  const id = vint(bytes, pos, true);
  const size = vint(bytes, pos + id.length, false);
  const dataStart = pos + id.length + size.length;
  return {
    id: id.value,
    start: pos,
    dataStart,
    size: size.unknown ? null : size.value,
    end: size.unknown ? null : dataStart + size.value,
  };
}

/** `n` as an 8-byte EBML size. */
function size8(n) {
  const out = new Uint8Array(8);
  out[0] = 0x01;
  let v = n;
  for (let i = 7; i >= 1; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}

function float64(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value);
  return out;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function readUint(bytes, from, to) {
  let v = 0;
  for (let i = from; i < to; i++) v = v * 256 + bytes[i];
  return v;
}

/**
 * The same WebM with its Info's Duration set to `durationMs`. Throws on something that is
 * not a WebM with a Segment and an Info; a caller keeps the original file then.
 */
export function withDuration(bytes, durationMs) {
  if (!(bytes instanceof Uint8Array)) throw new Error("Not a WebM file.");
  if (!(Number.isFinite(durationMs) && durationMs >= 0)) throw new Error("A duration is a number of milliseconds.");
  const head = element(bytes, 0);
  if (head.id !== EBML || head.end === null) throw new Error("Not a WebM file.");
  const segment = element(bytes, head.end);
  if (segment.id !== SEGMENT) throw new Error("Not a WebM file.");
  // Info comes before the first Cluster; MediaRecorder puts it first.
  let info = null;
  for (let pos = segment.dataStart; pos < (segment.end ?? bytes.length); ) {
    const child = element(bytes, pos);
    if (child.end === null) break; // a Cluster of unknown size: Info would have been before it
    if (child.id === INFO) {
      info = child;
      break;
    }
    pos = child.end;
  }
  if (!info) throw new Error("This WebM has no Info.");

  let scale = DEFAULT_SCALE;
  let duration = null;
  for (let pos = info.dataStart; pos < info.end; ) {
    const child = element(bytes, pos);
    if (child.end === null || child.end > info.end) throw new Error("Not a WebM file.");
    if (child.id === TIMECODE_SCALE) scale = readUint(bytes, child.dataStart, child.end) || DEFAULT_SCALE;
    if (child.id === DURATION) duration = child;
    pos = child.end;
  }
  const ticks = (durationMs * 1_000_000) / scale;

  if (duration && (duration.size === 4 || duration.size === 8)) {
    const out = bytes.slice();
    const view = new DataView(out.buffer, duration.dataStart, duration.size);
    if (duration.size === 8) view.setFloat64(0, ticks);
    else view.setFloat32(0, ticks);
    return out;
  }
  // Add Duration (ID 0x4489, size 8, a float64) at the end of Info, dropping a Duration of
  // any other size, and say Info's new size in 8 bytes. A Segment of known size grows too.
  const kept = [];
  for (let pos = info.dataStart; pos < info.end; ) {
    const child = element(bytes, pos);
    if (child.id !== DURATION) kept.push(bytes.subarray(child.start, child.end));
    pos = child.end;
  }
  const body = concat([...kept, new Uint8Array([0x44, 0x89, 0x88]), float64(ticks)]);
  const newInfo = concat([new Uint8Array([0x15, 0x49, 0xa9, 0x66]), size8(body.length), body]);
  const grown = newInfo.length - (info.end - info.start);
  let segmentHead = bytes.subarray(segment.start, segment.dataStart);
  if (segment.end !== null) {
    const idLength = vint(bytes, segment.start, true).length;
    segmentHead = concat([bytes.subarray(segment.start, segment.start + idLength), size8(segment.size + grown)]);
  }
  return concat([
    bytes.subarray(0, segment.start),
    segmentHead,
    bytes.subarray(segment.dataStart, info.start),
    newInfo,
    bytes.subarray(info.end),
  ]);
}

/** The Duration a WebM's Info says, in milliseconds, or null: for tests and checks. */
export function durationOf(bytes) {
  const head = element(bytes, 0);
  const segment = element(bytes, head.end);
  for (let pos = segment.dataStart; pos < (segment.end ?? bytes.length); ) {
    const child = element(bytes, pos);
    if (child.end === null) break;
    if (child.id === INFO) {
      let scale = DEFAULT_SCALE;
      let ticks = null;
      for (let p = child.dataStart; p < child.end; ) {
        const c = element(bytes, p);
        if (c.id === TIMECODE_SCALE) scale = readUint(bytes, c.dataStart, c.end) || DEFAULT_SCALE;
        if (c.id === DURATION) {
          const view = new DataView(bytes.buffer, bytes.byteOffset + c.dataStart, c.size);
          ticks = c.size === 8 ? view.getFloat64(0) : view.getFloat32(0);
        }
        p = c.end;
      }
      return ticks === null ? null : (ticks * scale) / 1_000_000;
    }
    pos = child.end;
  }
  return null;
}
