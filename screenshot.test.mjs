// screenshot.js: a captured tab is scaled to fit a model's context and sent as JPEG,
// with how many screenshot pixels make one CSS pixel. The browser's image calls
// (createImageBitmap, OffscreenCanvas) are faked; what is checked is the sizing, what is
// drawn and asked for, and that the JPEG's bytes come back whole as base64.
import test from "node:test";
import assert from "node:assert/strict";
import { JPEG_QUALITY, MAX_EDGE, fitScreenshot } from "./screenshot.js";

let bitmap; // what the next createImageBitmap answers
let jpeg; // the bytes the next convertToBlob answers
const seen = {};
globalThis.createImageBitmap = async (blob) => {
  seen.blobType = blob.type;
  return bitmap;
};
globalThis.OffscreenCanvas = class {
  constructor(width, height) {
    seen.canvas = [width, height];
  }
  getContext(kind) {
    seen.context = kind;
    return {
      drawImage: (...args) => {
        seen.drawn = args;
      },
      set imageSmoothingQuality(q) {
        seen.smoothing = q;
      },
    };
  }
  async convertToBlob(options) {
    seen.options = options;
    return new Blob([jpeg], { type: options.type });
  }
};

const capture = "data:image/png;base64,iVBORw0KGgo=";

test("a big Retina capture is scaled to fit MAX_EDGE and sent as JPEG", async () => {
  let closed = false;
  bitmap = { width: 5120, height: 2880, close: () => (closed = true) };
  jpeg = new Uint8Array(70_000).map((_, i) => i % 251); // over one 32 KB chunk of btoa
  const out = await fitScreenshot(capture, 2560);
  const width = MAX_EDGE;
  const height = Math.round(2880 * (MAX_EDGE / 5120));
  assert.deepEqual([out.width, out.height, out.mime], [width, height, "image/jpeg"]);
  assert.equal(out.pxPerCss, width / 2560);
  assert.equal(seen.blobType, "image/png");
  assert.deepEqual(seen.canvas, [width, height]);
  assert.deepEqual([seen.context, seen.smoothing], ["2d", "high"]);
  assert.deepEqual(seen.drawn, [bitmap, 0, 0, width, height]);
  assert.deepEqual(seen.options, { type: "image/jpeg", quality: JPEG_QUALITY });
  assert.ok(closed, "the bitmap is let go");
  assert.deepEqual(new Uint8Array(Buffer.from(out.data, "base64")), jpeg);
});

test("a small capture keeps its size; with no viewport width the scale is the ratio", async () => {
  bitmap = { width: 800, height: 600 }; // no close(): an older browser
  jpeg = new Uint8Array([1, 2, 3]);
  const out = await fitScreenshot(capture, 0, MAX_EDGE, 0.5);
  assert.deepEqual([out.width, out.height, out.pxPerCss], [800, 600, 1]);
  assert.equal(seen.options.quality, 0.5);
  assert.equal(out.data, Buffer.from([1, 2, 3]).toString("base64"));
});

test("a sliver is never scaled to nothing", async () => {
  bitmap = { width: 10_000, height: 1 };
  jpeg = new Uint8Array(0);
  const out = await fitScreenshot(capture, 5000, 100);
  assert.deepEqual([out.width, out.height, out.pxPerCss, out.data], [100, 1, 100 / 5000, ""]);
});
