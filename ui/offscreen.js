// The recorder: an offscreen page (no window) that turns a tab's screencast into a WebM.
//
// background.js sends it each picture Chrome's screencast takes of the tab (video.js says
// why a screencast); it draws them onto a canvas, MediaRecorder films the canvas, and on
// stop it hands back the finished video as a blob: URL (for chrome.downloads, in the
// worker) and, when the worker hands it an upload request (only if the person turned
// uploading on), uploads the same bytes to Wysebee Cloud. Only
// the worker talks to it: every message it acts on says `target: "offscreen"`.

import { withDuration } from "../webm.js";

/** @type {Map<string, {canvas, ctx, recorder, chunks, startedAt, seq, drawn, fps, bits, url}>} */
const videos = new Map();

const MIME = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));

function begin(v, width, height) {
  v.canvas.width = width;
  v.canvas.height = height;
  v.ctx.fillStyle = "#fff";
  v.ctx.fillRect(0, 0, width, height);
  const stream = v.canvas.captureStream(v.fps);
  v.recorder = new MediaRecorder(stream, { mimeType: MIME, videoBitsPerSecond: v.bits });
  v.recorder.ondataavailable = (e) => {
    if (e.data.size) v.chunks.push(e.data);
  };
  v.recorder.start(1000);
  v.startedAt = performance.now();
}

async function frame(v, data) {
  const seq = ++v.seq;
  const bitmap = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${data}`)).blob());
  if (seq < v.drawn) return bitmap.close(); // a later picture is already on the canvas
  v.drawn = seq;
  if (!v.recorder) begin(v, bitmap.width, bitmap.height);
  const { width, height } = v.canvas;
  // The first picture sets the size; a later one of another size (the window was resized)
  // is fitted in, centred on white.
  const scale = Math.min(width / bitmap.width, height / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  if (w !== width || h !== height) {
    v.ctx.fillStyle = "#fff";
    v.ctx.fillRect(0, 0, width, height);
  }
  v.ctx.drawImage(bitmap, (width - w) / 2, (height - h) / 2, w, h);
  bitmap.close();
}

async function stop(key, upload) {
  const v = videos.get(key);
  if (!v) return { ok: false, error: "No such recording." };
  videos.delete(key);
  if (!v.recorder) return { ok: false, error: "Nothing was recorded: the tab showed no picture." };
  const durationMs = performance.now() - v.startedAt;
  await new Promise((resolve) => {
    v.recorder.onstop = resolve;
    v.recorder.stop();
  });
  let blob = new Blob(v.chunks, { type: "video/webm" });
  try {
    blob = new Blob([withDuration(new Uint8Array(await blob.arrayBuffer()), durationMs)], { type: "video/webm" });
  } catch (e) {
    console.warn("[wysebee] recording kept without a duration", e);
  }
  const url = URL.createObjectURL(blob);
  urls.set(key, url);
  if (upload) void send(key, blob, upload, durationMs);
  return { ok: true, url, bytes: blob.size, durationMs: Math.round(durationMs) };
}

/** The upload, reported to the worker when it is over (it can take a while). */
async function send(key, blob, { url, init }, durationMs) {
  let report;
  uploading++;
  try {
    // The worker guessed the length; this page knows it.
    const target = new URL(url);
    target.searchParams.set("duration_ms", String(Math.round(durationMs)));
    const res = await fetch(target, { ...init, body: blob });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* no JSON */
    }
    report = res.ok ? { ok: true, id: body?.id ?? null } : { ok: false, error: `Wysebee answered ${res.status}.` };
  } catch (e) {
    report = { ok: false, error: `Could not reach Wysebee: ${e?.message || e}` };
  } finally {
    uploading--;
  }
  void chrome.runtime.sendMessage({ type: "video_uploaded", key, ...report }).catch(() => {});
}

/** blob: URLs handed out, by recording, until the download has taken its copy. */
const urls = new Map();
let uploading = 0;

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== "offscreen") return false;
  switch (msg.type) {
    case "video_start":
      videos.set(msg.key, {
        canvas: document.createElement("canvas"),
        ctx: null,
        recorder: null,
        chunks: [],
        startedAt: 0,
        seq: 0,
        drawn: 0,
        fps: msg.fps,
        bits: msg.bitsPerSecond,
      });
      videos.get(msg.key).ctx = videos.get(msg.key).canvas.getContext("2d");
      reply({ ok: true });
      return false;
    case "video_frame": {
      const v = videos.get(msg.key);
      if (v) frame(v, msg.data).catch((e) => console.warn("[wysebee] frame dropped", e));
      return false;
    }
    case "video_stop":
      stop(msg.key, msg.upload).then(reply, (e) => reply({ ok: false, error: String(e?.message || e) }));
      return true;
    case "video_release": {
      const url = urls.get(msg.key);
      if (url) URL.revokeObjectURL(url);
      urls.delete(msg.key);
      reply({ ok: true });
      return false;
    }
    case "video_busy":
      reply({ busy: videos.size + urls.size + uploading });
      return false;
    default:
      return false;
  }
});
