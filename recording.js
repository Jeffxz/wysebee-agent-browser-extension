// When the extension captures a recording frame, for the desktop's opt-in recording of
// what an agent did (Settings → System → Record agent sessions).
//
// The desktop asks for a frame per op (`record: true` in the op's args) only while a
// recording is on; the extension never records on its own. After a pointer-visible op
// — the ones the agent pointer draws, plus navigation — background.js captures the tab
// once the action *and* its red-dot pulse are on screen, and returns the picture beside
// the op's result as `frame`. Best effort: no frame is never a failed op.
//
// Pure, like pointer.js: no chrome.*, no DOM, so `node --test` covers it.

// The ops a recording frame follows. A screenshot or snapshot the agent takes itself is
// already a picture, which the desktop keeps as a frame without asking for another.
export const FRAME_OPS = new Set([
  "browser_click",
  "browser_type",
  "browser_scroll",
  "browser_drag",
  "browser_mouse",
  "browser_navigate",
]);

// Chrome allows captureVisibleTab about twice a second
// (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND); a little more apart than that.
export const MIN_CAPTURE_GAP_MS = 550;
// A frame is smaller than the agent's own screenshots: it is for watching, not reading.
export const FRAME_MAX_EDGE = 1280;
export const FRAME_QUALITY = 0.75;
// Never hold an op longer than this for its frame.
export const MAX_WAIT_MS = 2000;
// A pulse ring (page.overlay, .5 s) is clearly visible this long after it starts.
const RING_VISIBLE_MS = 150;
// Between the pulses of a double click (page.overlay).
const PULSE_GAP_MS = 160;
// The caret is drawn at once and blinks every second; this catches it shown.
const CARET_VISIBLE_MS = 250;
// A navigation or an op with nothing drawn: let the page paint.
const PAINT_MS = 100;

/** Whether `op` should come back with a frame: the desktop asked, and it is one of
 * FRAME_OPS. */
export function wantsFrame(op, args) {
  return FRAME_OPS.has(op) && args?.record === true;
}

/**
 * How long after showPointer returns (the dot has arrived) the action's picture is
 * complete: a held gesture is released at the end of its travel, a click's pulses
 * follow one another, a caret is drawn at once.
 */
export function settleMs(cmd) {
  if (!cmd) return PAINT_MS;
  if (cmd.caret) return CARET_VISIBLE_MS;
  if (cmd.hold) return Math.max(0, Number(cmd.ms) || 0) + RING_VISIBLE_MS;
  const pulses = Math.min(3, Math.max(0, Number(cmd.pulses) || 0));
  return pulses ? (pulses - 1) * PULSE_GAP_MS + RING_VISIBLE_MS : PAINT_MS;
}

/**
 * How long to wait, from `now`, before capturing: until the action has settled
 * (`settlesAt`) and the capture rate limit allows another (`lastCaptureAt` + gap).
 * Never more than MAX_WAIT_MS.
 */
export function captureWait(now, settlesAt, lastCaptureAt, gap = MIN_CAPTURE_GAP_MS) {
  const wait = Math.max(0, (settlesAt || 0) - now, (lastCaptureAt || 0) + gap - now);
  return Math.min(MAX_WAIT_MS, wait);
}

// --- steps, for a Playwright test ----------------------------------------------------
//
// Beside each frame the extension returns a `step`: what the action did, described so
// the desktop can write it as Playwright code.
// Snapshot refs ("e12") only last until the page changes, so the elements are described
// by what a test can find them by — page.describe, run before the action. Text typed
// into a sensitive field is left out (`text: null`); the test reads it from the
// environment instead.

const SCROLL_SHARE = 0.85; // page.scroll moves most of a screen per page
const SWIPE = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

/** The snapshot refs `op` acts on, for page.describe. */
export function refsFor(op, args) {
  const refs = op === "browser_drag" ? [args?.from_ref, args?.to_ref] : [args?.ref];
  return refs.filter((r) => r != null && r !== "").map(String);
}

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const round = (v) => Math.round(v * 10) / 10;
const xy = (p) => (Array.isArray(p) && p.length === 2 ? [round(p[0]), round(p[1])] : null);

/**
 * The step for one recorded op, from its args and page.describe's answer `d` (taken
 * before the action), or null when there is nothing to say (no description).
 */
export function stepFor(op, args, d) {
  if (op === "browser_navigate") return { op: "navigate", url: String(args?.url ?? "") };
  if (!d || typeof d !== "object") return null;
  const t = (ref) => (ref == null ? null : (d.targets?.[String(ref)] ?? null));
  const base = { url: String(d.url ?? "") };
  switch (op) {
    case "browser_click":
      return { op: "click", ...base, target: t(args?.ref) };
    case "browser_type": {
      const target = t(args?.ref);
      const sensitive = !!target?.sensitive;
      return {
        op: "type",
        ...base,
        target,
        text: sensitive ? null : String(args?.text ?? ""),
        submit: !!args?.submit,
      };
    }
    case "browser_scroll": {
      const direction = SWIPE[args?.direction] ? args.direction : "down";
      const pages = Math.min(20, Math.max(0, num(args?.pages, 1))) || 1;
      const [w, h] = Array.isArray(d.viewport) ? d.viewport.map((v) => num(v)) : [0, 0];
      const [sx, sy] = SWIPE[direction];
      const delta = [Math.round(sx * w * SCROLL_SHARE * pages), Math.round(sy * h * SCROLL_SHARE * pages)];
      return { op: "scroll", ...base, target: t(args?.ref), direction, delta };
    }
    case "browser_drag":
      return {
        op: "drag",
        ...base,
        source: t(args?.from_ref),
        target: t(args?.to_ref),
        to_text: args?.to_text == null ? null : String(args.to_text),
        dx: num(args?.dx),
        dy: num(args?.dy),
      };
    case "browser_mouse": {
      const action = String(args?.action ?? "");
      const at = xy(d.point) ?? xy(t(args?.ref)?.at);
      const step = { op: "mouse", ...base, action, button: String(args?.button || "left") };
      if (action === "path") return { ...step, points: (d.points ?? []).map(xy).filter(Boolean) };
      return { ...step, at, delta: [num(args?.delta_x), num(args?.delta_y)] };
    }
    default:
      return null;
  }
}
