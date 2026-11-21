import test from "node:test";
import assert from "node:assert/strict";
import {
  DOWNLOAD_FOLDER,
  MAX_VIDEO_MS,
  VIDEO_IDLE_MS,
  VIDEO_METHODS,
  checkRecordArgs,
  uploadBlocked,
  videoExpired,
  videoFileName,
  videoStatus,
} from "./video.js";
import { DEVTOOLS_METHODS } from "./devtools.js";
import { MOCK_METHODS } from "./mock.js";
import { ALLOWED_METHODS } from "./native_input.js";

test("recording only films: its own three debugger calls, none shared with another list", () => {
  assert.deepEqual([...VIDEO_METHODS].sort(), ["Page.screencastFrameAck", "Page.startScreencast", "Page.stopScreencast"]);
  for (const m of VIDEO_METHODS) {
    assert.ok(!DEVTOOLS_METHODS.has(m) && !MOCK_METHODS.has(m) && !ALLOWED_METHODS.has(m), m);
  }
});

test("browser_record takes start, stop or status, and a short name", () => {
  assert.deepEqual(checkRecordArgs({ action: "start", name: "  checkout \n fails " }), { action: "start", name: "checkout fails" });
  assert.deepEqual(checkRecordArgs({ action: "stop" }), { action: "stop", name: "scenario" });
  assert.deepEqual(checkRecordArgs(undefined), { action: "status", name: "scenario" });
  assert.throws(() => checkRecordArgs({ action: "pause" }), /start, stop or status/);
  assert.throws(() => checkRecordArgs({ action: "start", name: "x".repeat(121) }), /120/);
});

test("the file goes in its own Downloads folder, named for the scenario and when it began", () => {
  const at = new Date(2026, 10, 19, 8, 5, 9).getTime();
  assert.equal(videoFileName("Checkout fails: 500 / retry", at), `${DOWNLOAD_FOLDER}/Checkout-fails-500-retry-20261119-080509.webm`);
  assert.equal(videoFileName("..", at), `${DOWNLOAD_FOLDER}/scenario-20261119-080509.webm`);
  assert.equal(videoFileName(null, at), `${DOWNLOAD_FOLDER}/scenario-20261119-080509.webm`);
  assert.equal(videoFileName("注文 エラー", at), `${DOWNLOAD_FOLDER}/注文-エラー-20261119-080509.webm`);
  assert.ok(videoFileName("x".repeat(200), at).length < 120);
});

test("a recording left running ends by itself: too long in all, or the agent gone quiet", () => {
  const rec = { tabId: 4, name: "s", startedAt: 0, lastActionAt: 0, frames: 12 };
  assert.equal(videoExpired(rec, 1000), null);
  assert.equal(videoExpired(rec, VIDEO_IDLE_MS), "idle");
  assert.equal(videoExpired({ ...rec, lastActionAt: MAX_VIDEO_MS }, MAX_VIDEO_MS), "time_limit");
  assert.deepEqual(videoStatus(rec, 2500), {
    recording: true,
    tab_id: 4,
    name: "s",
    started_at: "1970-01-01T00:00:00.000Z",
    elapsed_ms: 2500,
    frames: 12,
  });
  assert.equal(videoStatus({ ...rec, startedAt: 10 }, 0).elapsed_ms, 0);
});

test("a recording is uploaded only when paired and the person turned uploading on", () => {
  assert.equal(uploadBlocked(true, true), null);
  // Off by default: never set, or anything but true.
  for (const setting of [undefined, false, "true", 1]) assert.equal(uploadBlocked(true, setting), "off");
  assert.equal(uploadBlocked(false, true), "not paired");
  assert.equal(uploadBlocked(false, undefined), "not paired");
});
