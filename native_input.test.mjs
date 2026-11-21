// Run with: agent --test apps/browser_probe/extension/
import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTIONS,
  ALLOWED_METHODS,
  MAX_PATH_POINTS,
  checkPath,
  nativeMouse,
  segmentSteps,
} from "./native_input.js";

function recorder() {
  const sent = [];
  const send = async (method, params) => {
    sent.push({ method, ...params });
  };
  return { sent, send };
}
const fresh = () => ({ buttons: 0, x: null, y: null });
const noSleep = async () => {};
const types = (sent) => sent.map((e) => e.type);

test("the only command this module can produce is the whitelisted one", async () => {
  assert.deepEqual([...ALLOWED_METHODS], ["Input.dispatchMouseEvent"]);
  const { sent, send } = recorder();
  const state = fresh();
  for (const action of ACTIONS) {
    await nativeMouse({ action, x: 10, y: 10, points: [[10, 10], [20, 20]] }, state, send, noSleep);
  }
  assert.ok(sent.length > 0);
  assert.ok(sent.every((e) => ALLOWED_METHODS.has(e.method)));
});

test("a click arrives, presses and releases like a person", async () => {
  const { sent, send } = recorder();
  const state = fresh();
  const out = await nativeMouse({ action: "click", x: 40, y: 50 }, state, send, noSleep);
  assert.deepEqual(types(sent), ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert.deepEqual([sent[1].button, sent[1].buttons, sent[1].clickCount], ["left", 1, 1]);
  assert.deepEqual([sent[2].buttons, sent[2].x, sent[2].y], [0, 40, 50]);
  assert.equal(out.pressed, false);
});

test("a double click is two pairs, the second with clickCount 2", async () => {
  const { sent, send } = recorder();
  await nativeMouse({ action: "double_click", x: 5, y: 5 }, fresh(), send, noSleep);
  assert.deepEqual(types(sent), ["mouseMoved", "mousePressed", "mouseReleased", "mousePressed", "mouseReleased"]);
  assert.deepEqual(sent.slice(1).map((e) => e.clickCount), [1, 1, 2, 2]);
});

test("a drag holds the button through a stepped path and releases at the end", async () => {
  const { sent, send } = recorder();
  const state = fresh();
  assert.equal((await nativeMouse({ action: "press", x: 0, y: 0 }, state, send, noSleep)).pressed, true);
  sent.length = 0;
  await nativeMouse({ action: "move", x: 100, y: 0 }, state, send, noSleep);
  assert.equal(sent.length, 10); // libraries ignore a jump
  assert.ok(sent.every((e) => e.type === "mouseMoved" && e.buttons === 1 && e.button === "left"));
  assert.deepEqual([sent[0].x, sent.at(-1).x], [10, 100]);
  sent.length = 0;
  const out = await nativeMouse({ action: "release", x: 100, y: 0 }, state, send, noSleep);
  assert.deepEqual(types(sent), ["mouseReleased"]); // already there: no extra move
  assert.equal(out.pressed, false);
});

test("a move with nothing held is one hop, reporting no button", async () => {
  const { sent, send } = recorder();
  const state = { buttons: 0, x: 0, y: 0 };
  await nativeMouse({ action: "move", x: 300, y: 200 }, state, send, noSleep);
  assert.deepEqual(sent.map((e) => [e.type, e.button, e.buttons]), [["mouseMoved", "none", 0]]);
});

test("right and middle buttons carry their own names and masks", async () => {
  for (const [button, mask] of [["right", 2], ["middle", 4]]) {
    const { sent, send } = recorder();
    await nativeMouse({ action: "press", x: 1, y: 1, button }, fresh(), send, noSleep);
    assert.deepEqual([sent.at(-1).button, sent.at(-1).buttons], [button, mask], button);
  }
});

test("the wheel scrolls by its deltas at the pointer", async () => {
  const { sent, send } = recorder();
  await nativeMouse({ action: "wheel", x: 20, y: 30, deltaY: 400 }, fresh(), send, noSleep);
  const wheel = sent.at(-1);
  assert.deepEqual([wheel.type, wheel.x, wheel.y, wheel.deltaX, wheel.deltaY], ["mouseWheel", 20, 30, 0, 400]);
});

test("an unknown action is refused before anything is sent", async () => {
  const { sent, send } = recorder();
  await assert.rejects(nativeMouse({ action: "teleport", x: 1, y: 1 }, fresh(), send, noSleep));
  assert.equal(sent.length, 0);
});

test("a path is one stroke: press at the first point, move through the rest, release at the last", async () => {
  const { send, sent } = recorder();
  const state = fresh();
  const out = await nativeMouse(
    { action: "path", points: [[0, 0], [16, 0], [16, 16]] },
    state,
    send,
    noSleep,
  );
  const types = sent.map((s) => s.type);
  assert.equal(types[0], "mouseMoved");
  assert.equal(types[1], "mousePressed");
  assert.equal(types.at(-1), "mouseReleased");
  assert.deepEqual([sent[1].x, sent[1].y], [0, 0]);
  assert.deepEqual([sent.at(-1).x, sent.at(-1).y], [16, 16]);
  // Every move between press and release holds the button.
  const moves = sent.slice(2, -1);
  assert.ok(moves.length >= 2 && moves.every((m) => m.type === "mouseMoved" && m.buttons === 1));
  // It passes through each point in order.
  assert.ok(moves.some((m) => m.x === 16 && m.y === 0));
  assert.equal(out.pressed, false);
  assert.deepEqual([state.x, state.y, state.buttons], [16, 16, 0]);
});

test("a long path is paced by distance, not ten moves per point", async () => {
  const { send, sent } = recorder();
  const points = Array.from({ length: 200 }, (_, i) => [i * 2, 0]); // 2 px apart
  await nativeMouse({ action: "path", points }, fresh(), send, noSleep);
  const moves = sent.filter((s) => s.type === "mouseMoved");
  assert.ok(moves.length < 220, `got ${moves.length} moves for 199 short segments`);
});

test("segments get about one move per 8 px, between 1 and 10", () => {
  assert.equal(segmentSteps(0, 0, 0, 0), 1);
  assert.equal(segmentSteps(0, 0, 8, 0), 1);
  assert.equal(segmentSteps(0, 0, 24, 0), 3);
  assert.equal(segmentSteps(0, 0, 1000, 0), 10);
});

test("a bad path is refused before anything is sent", async () => {
  const { send, sent } = recorder();
  for (const points of [undefined, [], [[1, 1]], [[1, 1], [2]], [[1, 1], ["a", 2]], "x"]) {
    await assert.rejects(nativeMouse({ action: "path", points }, fresh(), send, noSleep));
  }
  const tooMany = Array.from({ length: MAX_PATH_POINTS + 1 }, () => [1, 1]);
  await assert.rejects(nativeMouse({ action: "path", points: tooMany }, fresh(), send, noSleep), /at most/);
  assert.deepEqual(sent, []);
});

test("a path will not start while a button is already held", async () => {
  const { send } = recorder();
  const state = fresh();
  await nativeMouse({ action: "press", x: 1, y: 1 }, state, send, noSleep);
  await assert.rejects(
    nativeMouse({ action: "path", points: [[1, 1], [5, 5]] }, state, send, noSleep),
    /already held/,
  );
});

test("checkPath returns the points as numbers", () => {
  assert.deepEqual(checkPath([["1", 2], [3, "4"]]), [[1, 2], [3, 4]]);
});

test("moves while the middle or right button is held report that button", async () => {
  for (const [button, mask] of [["middle", 4], ["right", 2]]) {
    const { sent, send } = recorder();
    const state = fresh();
    await nativeMouse({ action: "press", x: 0, y: 0, button }, state, send, noSleep);
    await nativeMouse({ action: "move", x: 50, y: 0 }, state, send, noSleep);
    const moves = sent.filter((e) => e.type === "mouseMoved").slice(1);
    assert.ok(moves.length === 10 && moves.every((e) => e.button === button && e.buttons === mask), button);
  }
});

test("a point that is not a pair is refused by checkPath", () => {
  assert.throws(() => checkPath([[1, 1], { x: 2, y: 2 }]), /Point 1 of the path is not \[x, y\]/);
});

test("without a sleep handed in, a stroke really waits between points", async () => {
  const { sent, send } = recorder();
  const t0 = performance.now();
  await nativeMouse({ action: "path", points: [[0, 0], [4, 0], [8, 0]] }, fresh(), send);
  assert.ok(performance.now() - t0 >= 14, "two 8 ms pauses");
  assert.equal(sent.at(-1).type, "mouseReleased");
});
