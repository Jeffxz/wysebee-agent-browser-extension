// Video recordings of a scenario (browser_record), for a person to replay later.
//
// The agent says when a scenario starts and ends: `browser_record {action: "start", name}`
// before it, `{action: "stop"}` after. In between, Chrome's screencast (through the tab's
// debugger session, so the debugging bar shows) sends a picture of the tab each time it
// paints — the agent pointer included — and an offscreen page (ui/offscreen.js) draws them
// onto a canvas that MediaRecorder turns into a WebM video. On stop it is saved in the
// person's Downloads folder (Downloads/Wysebee Agent/…). It is uploaded to Wysebee Cloud,
// for replay there, only when the person turned that on (`uploadRecordings`, off by
// default: a video can show anything that was on the tab).
//
// Chrome's own tab capture would need the person to click the extension on every tab
// first, which an agent cannot do; the screencast needs no click.
//
// Pure, like mock.js: no chrome.*, so `node --test` covers it.

// The debugger calls a recording makes, and nothing else: its own boundary, beside
// DEVTOOLS_METHODS and MOCK_METHODS. None of them reads, clicks or changes the page.
export const VIDEO_METHODS = new Set(["Page.startScreencast", "Page.stopScreencast", "Page.screencastFrameAck"]);

// A recording that is never stopped ends by itself: this long in all, or this long after
// the agent's last action on the tab.
export const MAX_VIDEO_MS = 15 * 60_000;
export const VIDEO_IDLE_MS = 5 * 60_000;
// One recording a tab, and a few at once in all.
export const MAX_RECORDINGS = 3;
// What the screencast sends: big enough to read, small enough to move every frame.
export const SCREENCAST = { format: "jpeg", quality: 70, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 1 };
export const VIDEO_FPS = 30;
export const VIDEO_BITS_PER_SECOND = 2_500_000;
export const DOWNLOAD_FOLDER = "Wysebee Agent";

const ACTIONS = new Set(["start", "stop", "status"]);

/** browser_record's arguments, checked: `{action, name}`. Throws saying what is wrong. */
export function checkRecordArgs(args) {
  const action = args?.action == null ? "status" : String(args.action);
  if (!ACTIONS.has(action)) throw new Error("`action` is start, stop or status.");
  const name = String(args?.name ?? "").replace(/\s+/g, " ").trim();
  if (name.length > 120) throw new Error("`name` is at most 120 characters.");
  return { action, name: name || "scenario" };
}

const pad = (n) => String(n).padStart(2, "0");

/** Where in Downloads a recording goes: "Wysebee Agent/<name>-<yyyymmdd-hhmmss>.webm". */
export function videoFileName(name, startedAt) {
  const slug =
    String(name ?? "")
      .normalize("NFKC")
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 80) || "scenario";
  const d = new Date(startedAt);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${DOWNLOAD_FOLDER}/${slug}-${stamp}.webm`;
}

/**
 * Why a recording should end now, or null: it has run MAX_VIDEO_MS, or the agent has done
 * nothing on its tab for VIDEO_IDLE_MS.
 */
export function videoExpired(rec, now) {
  if (now - rec.startedAt >= MAX_VIDEO_MS) return "time_limit";
  if (now - rec.lastActionAt >= VIDEO_IDLE_MS) return "idle";
  return null;
}

/**
 * Whether a finished recording goes to Wysebee Cloud: null when it does, else why not —
 * "not paired", or "off" (the person has not turned on uploading, the default).
 */
export function uploadBlocked(paired, uploadRecordings) {
  if (!paired) return "not paired";
  return uploadRecordings === true ? null : "off";
}

/** What browser_record reports about one recording. */
export function videoStatus(rec, now) {
  return {
    recording: true,
    tab_id: rec.tabId,
    name: rec.name,
    started_at: new Date(rec.startedAt).toISOString(),
    elapsed_ms: Math.max(0, now - rec.startedAt),
    frames: rec.frames,
  };
}
