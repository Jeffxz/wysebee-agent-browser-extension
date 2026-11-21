// Run with: node --test apps/browser_probe/extension/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  FRAME_OPS,
  MAX_WAIT_MS,
  MIN_CAPTURE_GAP_MS,
  captureWait,
  refsFor,
  settleMs,
  stepFor,
  wantsFrame,
} from "./recording.js";
import { caretCommand, dragCommand, pointerCommand, refClickCommand, scrollCommand } from "./pointer.js";

test("a frame is wanted only when the desktop asked, and only after a pointer-visible op", () => {
  for (const op of FRAME_OPS) assert.equal(wantsFrame(op, { record: true }), true);
  assert.equal(wantsFrame("browser_click", {}), false);
  assert.equal(wantsFrame("browser_click", { record: "yes" }), false);
  assert.equal(wantsFrame("browser_click", undefined), false);
  assert.equal(wantsFrame("browser_snapshot", { record: true }), false);
  assert.equal(wantsFrame("browser_screenshot", { record: true }), false);
  assert.equal(wantsFrame("browser_evaluate", { record: true }), false);
});

test("a held gesture settles after its travel and the release pulse", () => {
  const drag = dragCommand({ from: [0, 0], to: [10, 10] });
  assert.equal(settleMs(drag), drag.ms + 150);
  const scroll = scrollCommand({ x: 5, y: 5 }, "down");
  assert.equal(settleMs(scroll), scroll.ms + 150);
  assert.equal(settleMs({ hold: true, ms: "x" }), 150);
});

test("a click settles once its last pulse is visible", () => {
  assert.equal(settleMs(refClickCommand("e1")), 150);
  assert.equal(settleMs(pointerCommand("click", { x: 1, y: 2 })), 150);
  assert.equal(settleMs(pointerCommand("double_click", { x: 1, y: 2 })), 310);
  assert.equal(settleMs({ pulses: 9 }), 2 * 160 + 150);
});

test("a move, a caret and nothing drawn settle quickly", () => {
  assert.equal(settleMs(pointerCommand("move", { x: 1, y: 2 })), 100);
  assert.equal(settleMs(caretCommand("e3")), 250);
  assert.equal(settleMs(null), 100);
});

test("capture waits for the action and for the rate limit, never too long", () => {
  assert.equal(captureWait(1000, 900, 0), 0);
  assert.equal(captureWait(1000, 1200, 0), 200);
  assert.equal(captureWait(1000, 0, 800), 800 + MIN_CAPTURE_GAP_MS - 1000);
  assert.equal(captureWait(1000, 1100, 800), 350);
  assert.equal(captureWait(1000, 99999, 0), MAX_WAIT_MS);
  assert.equal(captureWait(1000, undefined, undefined), 0);
  assert.equal(captureWait(1000, 0, 900, 50), 0);
});

const button = { role: "button", name: "Sign in", css: "form > button", at: [10, 20] };
const d = (extra) => ({ url: "https://a.example/", viewport: [1000, 800], targets: { 1: button }, ...extra });

test("the refs to describe are the op's own", () => {
  assert.deepEqual(refsFor("browser_click", { ref: "1" }), ["1"]);
  assert.deepEqual(refsFor("browser_drag", { from_ref: 1, to_ref: "2" }), ["1", "2"]);
  assert.deepEqual(refsFor("browser_drag", { from_ref: "1", to_ref: null }), ["1"]);
  assert.deepEqual(refsFor("browser_scroll", {}), []);
  assert.deepEqual(refsFor("browser_mouse", { ref: "" }), []);
  assert.deepEqual(refsFor("browser_mouse", undefined), []);
});

test("navigation needs no description; anything else without one is no step", () => {
  assert.deepEqual(stepFor("browser_navigate", { url: "https://b.example/" }, null), {
    op: "navigate", url: "https://b.example/",
  });
  assert.deepEqual(stepFor("browser_navigate", {}, null), { op: "navigate", url: "" });
  assert.equal(stepFor("browser_click", { ref: "1" }, null), null);
  assert.equal(stepFor("browser_click", { ref: "1" }, "odd"), null);
  assert.equal(stepFor("browser_evaluate", {}, d()), null);
});

test("a click names its element, or null when it was gone", () => {
  assert.deepEqual(stepFor("browser_click", { ref: "1" }, d()), {
    op: "click", url: "https://a.example/", target: button,
  });
  assert.equal(stepFor("browser_click", { ref: "9" }, d()).target, null);
  assert.equal(stepFor("browser_click", {}, { targets: {} }).url, "");
});

test("typing keeps its text, except into a sensitive field", () => {
  const step = stepFor("browser_type", { ref: "1", text: "hello", submit: true }, d());
  assert.deepEqual([step.text, step.submit], ["hello", true]);
  const secret = d({ targets: { 1: { ...button, sensitive: true } } });
  assert.equal(stepFor("browser_type", { ref: "1", text: "hunter2" }, secret).text, null);
  assert.equal(stepFor("browser_type", { ref: "1" }, d()).text, "");
});

test("a scroll says how far, in page pixels", () => {
  assert.deepEqual(stepFor("browser_scroll", { direction: "down", pages: 2 }, d()), {
    op: "scroll", url: "https://a.example/", target: null, direction: "down", delta: [0, 1360],
  });
  assert.deepEqual(stepFor("browser_scroll", { direction: "left", ref: "1" }, d()).delta, [-850, 0]);
  const odd = stepFor("browser_scroll", { direction: "sideways", pages: "x" }, d({ viewport: null }));
  assert.equal(odd.direction, "down");
  assert.deepEqual(odd.delta, [0, 0]);
  assert.deepEqual(stepFor("browser_scroll", { pages: 0 }, d()).delta, [0, 680]);
});

test("a drag names its source and where it went", () => {
  const step = stepFor("browser_drag", { from_ref: "1", to_text: "Done", dx: "5" }, d());
  assert.deepEqual(step, {
    op: "drag", url: "https://a.example/", source: button, target: null, to_text: "Done", dx: 5, dy: 0,
  });
  assert.equal(stepFor("browser_drag", { from_ref: "1" }, d()).to_text, null);
});

test("a mouse action is in page pixels, a ref's centre when it had no point", () => {
  assert.deepEqual(stepFor("browser_mouse", { action: "click", x: 1, y: 2 }, d({ point: [5.04, 6] })), {
    op: "mouse", url: "https://a.example/", action: "click", button: "left", at: [5, 6], delta: [0, 0],
  });
  const byRef = stepFor("browser_mouse", { action: "wheel", ref: "1", delta_y: 40, button: "right" }, d());
  assert.deepEqual([byRef.at, byRef.delta, byRef.button], [[10, 20], [0, 40], "right"]);
  assert.equal(stepFor("browser_mouse", { action: "move" }, d()).at, null);
  const path = stepFor("browser_mouse", { action: "path" }, d({ points: [[1, 2], [3, 4], "x"] }));
  assert.deepEqual(path.points, [[1, 2], [3, 4]]);
  assert.deepEqual(stepFor("browser_mouse", { action: "path" }, d()).points, []);
  assert.equal(stepFor("browser_mouse", {}, d()).action, "");
});
