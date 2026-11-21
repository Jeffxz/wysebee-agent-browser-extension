// The link with Wysebee Cloud: the secret, the pairing code, the
// requests the extension makes and what each poll answer does to the pairing.
//
// Pure on purpose, like policy.js: no chrome.* and no network of its own (fetch is
// handed in), so `node --test` covers it. background.js stores the state this file
// shapes, and runs the loop. The cloud's base URL is handed in too: the Server
// tab's (cloud.js), else server.js's, set when the extension is built (scripts/build.mjs).

export const ROUTES = "/api/v1/browser-links";

/** The pairing code's letters: no 0/O, 1/I. */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 8;

/** How long the cloud may hold a poll (an MV3 worker dies when a fetch takes 30 s). */
export const POLL_WAIT_SECONDS = 20;
/** When a request is given up on, a little under those 30 s. */
export const REQUEST_TIMEOUT_MS = 28_000;
/** After a failed poll: 2 s, 5 s, 15 s, then 30 s. */
export const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000];
/** The most a result may weigh, as the cloud takes it. */
export const MAX_RESULT_BYTES = 16 * 1024 * 1024;
export const NAME_MAX = 60;

// --- the secret ------------------------------------------------------------------

function base64url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32 random bytes, base64url: the extension's secret. Never shown, never typed. */
export function makeSecret(random = (bytes) => crypto.getRandomValues(bytes)) {
  return base64url(random(new Uint8Array(32)));
}

/**
 * What the cloud keeps of the secret: the SHA-256, in hex, of the secret as it is sent
 * (the base64url text after "Bearer ").
 */
export async function secretHash(secret, subtle = crypto.subtle) {
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(String(secret)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- the pairing code and the agent's name -----------------------------------------

/** A code as the cloud sent or a person typed it: 8 letters of the alphabet, or "". */
export function normaliseCode(code) {
  const plain = String(code ?? "").toUpperCase().replace(/[\s-]/g, "");
  if (plain.length !== CODE_LENGTH) return "";
  for (const ch of plain) if (!CODE_ALPHABET.includes(ch)) return "";
  return plain;
}

/** XXXX-XXXX, as shown; "" for anything that is not a code. */
export function formatCode(code) {
  const plain = normaliseCode(code);
  return plain ? `${plain.slice(0, 4)}-${plain.slice(4)}` : "";
}

/** The agent name as sent: trimmed, one line, 1-60 characters; null otherwise. */
export function checkName(name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed || [...trimmed].length > NAME_MAX || /[\r\n\u2028\u2029]/.test(trimmed)) return null;
  return trimmed;
}

/** "Edge" or "Chrome", by the user agent. */
export function browserName(userAgent) {
  return /\bEdg\//.test(String(userAgent ?? "")) ? "Edge" : "Chrome";
}

// --- requests --------------------------------------------------------------------

const JSON_HEADERS = { "Content-Type": "application/json" };

function authed(secret, extra = {}) {
  return { Authorization: `Bearer ${secret}`, ...extra };
}

/** The agent type this extension pairs as:
 * Chrome's, in Edge too until a `wysebee-browser-edge` type is registered and sent. */
export const AGENT_TYPE = "wysebee-browser-chrome";

/** POST /start: no auth; the cloud answers the link's id and its code. */
export function startRequest(server, { name, secretHash: hash, browser, version }) {
  return {
    url: `${server}${ROUTES}/start`,
    init: {
      method: "POST",
      headers: { ...JSON_HEADERS },
      body: JSON.stringify({ name, secret_hash: hash, browser, extension_version: version, kind: AGENT_TYPE }),
    },
  };
}

/**
 * POST /{id}/poll?wait=n with the extension's status. `paused`: the person turned the
 * extension off (its Enabled switch) — sent once, on the last poll before it stops polling,
 * so Wysebee says it was switched off rather than that the browser is closed.
 */
export function pollRequest(server, id, secret, { version, browser, paused = false }, wait = POLL_WAIT_SECONDS) {
  const seconds = Math.min(Math.max(Math.round(Number(wait) || 0), 0), 25);
  return {
    url: `${server}${ROUTES}/${encodeURIComponent(id)}/poll?wait=${seconds}`,
    init: {
      method: "POST",
      headers: authed(secret, JSON_HEADERS),
      body: JSON.stringify({ status: { paused: !!paused, extension_version: version, browser } }),
    },
  };
}

/** A call's outcome as posted: `{ok: true, result}` or `{ok: false, error}`, within 16 MB. */
export function resultBody(outcome) {
  let body = outcome?.ok
    ? JSON.stringify({ ok: true, result: outcome.result === undefined ? null : outcome.result })
    : JSON.stringify({ ok: false, error: String(outcome?.error ?? "The operation failed.") });
  if (new TextEncoder().encode(body).length > MAX_RESULT_BYTES) {
    body = JSON.stringify({ ok: false, error: "The result was too large to send (over 16 MB)." });
  }
  return body;
}

/** POST /{id}/calls/{call_id}/result. */
export function resultRequest(server, id, secret, callId, outcome) {
  return {
    url: `${server}${ROUTES}/${encodeURIComponent(id)}/calls/${encodeURIComponent(callId)}/result`,
    init: { method: "POST", headers: authed(secret, JSON_HEADERS), body: resultBody(outcome) },
  };
}

/**
 * POST /{id}/recordings?…: a finished scenario video (video.js), for replaying in Wysebee.
 * The body (the WebM itself, `video/webm`) is the caller's to add: it is too big to copy
 * around. What it shows goes in the query: its name, when it started, how long it is, the
 * site it began on, and the call that stopped it (null if it ended by itself).
 */
export function recordingRequest(server, id, secret, { name, startedAt, durationMs, origin, callId = null }) {
  const q = new URLSearchParams({
    name: String(name ?? "").slice(0, 120),
    started_at: new Date(startedAt).toISOString(),
    duration_ms: String(Math.max(0, Math.round(Number(durationMs) || 0))),
  });
  if (origin) q.set("origin", String(origin));
  if (callId) q.set("call_id", String(callId));
  return {
    url: `${server}${ROUTES}/${encodeURIComponent(id)}/recordings?${q}`,
    init: { method: "POST", headers: authed(secret, { "Content-Type": "video/webm" }) },
  };
}

/** DELETE /{id}: unpair from the extension. */
export function unpairRequest(server, id, secret) {
  return {
    url: `${server}${ROUTES}/${encodeURIComponent(id)}`,
    init: { method: "DELETE", headers: authed(secret) },
  };
}

/**
 * Send one request with the fetch handed in. Answers `{status, body}` (body the JSON,
 * or null when there is none); throws when nothing answered (offline, timed out).
 */
export async function exchange(fetchFn, request, timeoutMs = REQUEST_TIMEOUT_MS) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), timeoutMs);
  try {
    const res = await fetchFn(request.url, { ...request.init, signal: control.signal });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* 204, or an answer that is not JSON. */
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// --- the pairing's state -----------------------------------------------------------
//
//   unpaired --start--> pending(code) --poll--> paired
//                           |                     |
//                           +--> refused / expired +--> unpaired (401: forgotten)
//
// `secret` and `id` are kept from /start until the pairing is forgotten. `notice` on an
// unpaired state says why it is unpaired when Wysebee did it ("unpaired").

export const UNPAIRED = Object.freeze({ phase: "unpaired" });

export const REFUSALS = ["name_taken", "reserved", "too_many", "invalid_name"];

/** Whether this state has a link to poll. */
export function polls(state) {
  return state?.phase === "pending" || state?.phase === "paired";
}

/** The state once /start answered, or null when its answer is not one. */
export function started(name, secret, answer, now) {
  const code = normaliseCode(answer?.code);
  const id = String(answer?.id ?? "");
  if (!code || !id) return null;
  const seconds = Number(answer?.expires_in) > 0 ? Number(answer.expires_in) : 600;
  return { phase: "pending", id, secret, name, code, expiresAt: now + seconds * 1000 };
}

function agentOf(raw) {
  return { name: String(raw?.name ?? ""), label: String(raw?.label ?? raw?.name ?? "") };
}

function callsOf(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((c) => c && typeof c.id === "string" && typeof c.op === "string")
    .map((c) => ({ id: c.id, op: c.op, args: c.args && typeof c.args === "object" ? c.args : {} }));
}

/**
 * What one poll's answer does. `answer` is `{status, body}`, or null when nothing
 * answered. Returns the next state, the calls to run, the ids cancelled, and `failed`
 * when the poll should back off.
 */
export function afterPoll(state, answer, now) {
  const out = (next, extra = {}) => ({ state: next, calls: [], cancelled: [], failed: false, ...extra });
  if (!polls(state)) return out(state);
  const pendingOver = state.phase === "pending" && now >= state.expiresAt;
  if (!answer) return pendingOver ? out({ phase: "expired", name: state.name }) : out(state, { failed: true });
  const { status, body } = answer;
  if (status === 401) {
    return out(state.phase === "paired" ? { phase: "unpaired", notice: "unpaired" } : { phase: "expired", name: state.name });
  }
  if (status === 410) return out({ phase: "expired", name: state.name ?? "" });
  if (status !== 200 || !body) {
    return pendingOver ? out({ phase: "expired", name: state.name }) : out(state, { failed: true });
  }
  if (body.state === "pending") {
    if (state.phase !== "pending") return out(state);
    const seconds = Number(body.expires_in);
    return out(Number.isFinite(seconds) ? { ...state, expiresAt: now + Math.max(seconds, 0) * 1000 } : state);
  }
  if (body.state === "refused") {
    return out({
      phase: "refused",
      name: state.name ?? "",
      reason: REFUSALS.includes(body.reason) ? body.reason : "other",
      message: String(body.message ?? ""),
    });
  }
  if (body.state === "paired") {
    return out(
      { phase: "paired", id: state.id, secret: state.secret, agent: agentOf(body.agent) },
      {
        calls: callsOf(body.calls),
        cancelled: (Array.isArray(body.cancelled) ? body.cancelled : []).map(String),
      },
    );
  }
  return out(state, { failed: true });
}

/** How long to wait after the `failures`-th failed poll in a row (from 1). */
export function backoff(failures) {
  const n = Math.max(Math.floor(Number(failures) || 1), 1);
  return BACKOFF_MS[Math.min(n, BACKOFF_MS.length) - 1];
}

/** What a page may see of the state: never the secret. */
export function publicState(state, now) {
  const s = state || UNPAIRED;
  switch (s.phase) {
    case "pending":
      return {
        phase: "pending",
        name: s.name,
        code: formatCode(s.code),
        expiresIn: Math.max(Math.ceil((s.expiresAt - now) / 1000), 0),
      };
    case "paired":
      return { phase: "paired", agent: s.agent };
    case "refused":
      return { phase: "refused", name: s.name, reason: s.reason, message: s.message };
    case "expired":
      return { phase: "expired", name: s.name };
    default:
      return { phase: "unpaired", ...(s.notice ? { notice: s.notice } : {}) };
  }
}
