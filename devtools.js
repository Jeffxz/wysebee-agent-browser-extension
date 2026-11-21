// Developer tools for an agent: the console, the network log, running script, the
// viewport and performance counters, through the Chrome DevTools Protocol.
//
// Pure, like policy.js and native_input.js: it never touches chrome.*. background.js
// wires the recorder to chrome.debugger.onEvent and sends only DEVTOOLS_METHODS — so
// `node --test` can check exactly what is recorded and what is hidden.
//
// **DEVTOOLS_METHODS is the boundary**, separate from native_input.js's one-method list
// so that real mouse input can never send anything but mouse events. It is what an agent
// with "Web development tools" turned on may do, and nothing more. Deliberately absent:
//
//   - Network.getCookies / getAllCookies / Storage.*  — every cookie, HttpOnly included,
//     for every site. Page script (Runtime.evaluate) still sees `document.cookie`, which
//     is the page's own business; HttpOnly session cookies stay out of reach.
//   - Fetch.* / Network.setRequestInterception        — rewriting traffic.
//   - Target.* / Browser.*                              — reaching other tabs or the browser.
//   - Page.navigate & co.                               — navigation has its own, judged op.
//
// Adding a method is a decision, not a detail; the test pins the list.

export const DEVTOOLS_METHODS = new Set([
  "Runtime.enable",
  "Runtime.evaluate",
  "Log.enable",
  "Network.enable",
  "Network.getResponseBody",
  "Performance.enable",
  "Performance.getMetrics",
  "Emulation.setDeviceMetricsOverride",
  "Emulation.clearDeviceMetricsOverride",
  "Emulation.setTouchEmulationEnabled",
  "Emulation.setUserAgentOverride",
]);

// The domains a recording turns on, in order.
export const RECORDING_DOMAINS = ["Runtime.enable", "Log.enable", "Network.enable", "Performance.enable"];

// Kept so a response body can still be read after the page has moved on.
export const NETWORK_BUFFER = { maxTotalBufferSize: 20_000_000, maxResourceBufferSize: 5_000_000 };

export const MAX_CONSOLE = 1000;
export const MAX_NETWORK = 1000;
export const MAX_TEXT = 4000;
export const MAX_BODY = 100_000;
export const MAX_RESULT = 50_000;
export const MAX_EXPRESSION = 100_000;

// Values a model is never shown: they sign the person in. Hidden in the network log,
// request and response alike, whatever the site.
export const SECRET_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
  "x-xsrf-token",
]);
export const HIDDEN = "(hidden)";

// Fields of a request body hidden the same way: a login form posts a password.
const SECRET_FIELD = /pass(word|wd)?|secret|token|api[-_]?key|authorization|credential/i;

const LEVELS = { error: 3, warning: 2, info: 1, debug: 0 };

const clip = (text, max = MAX_TEXT) => {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max)}… (${s.length - max} more characters)` : s;
};

/** Headers with every secret one's value replaced, names lower-cased. */
export function redactHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const key = name.toLowerCase();
    out[key] = SECRET_HEADERS.has(key) ? HIDDEN : clip(value, 1000);
  }
  return out;
}

/** A request body with password-like fields hidden: JSON and form-encoded are understood. */
export function redactBody(body) {
  if (body == null || body === "") return null;
  const text = String(body);
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const walk = (v) => {
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === "object") {
          return Object.fromEntries(
            Object.entries(v).map(([k, x]) => [k, SECRET_FIELD.test(k) ? HIDDEN : walk(x)]),
          );
        }
        return v;
      };
      return clip(JSON.stringify(walk(parsed)));
    }
  } catch {
    /* not JSON */
  }
  if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(text)) {
    return clip(
      text
        .split("&")
        .map((pair) => {
          const [k] = pair.split("=", 1);
          let name = k;
          try {
            name = decodeURIComponent(k.replace(/\+/g, " "));
          } catch {
            /* keep it as sent */
          }
          return SECRET_FIELD.test(name) ? `${k}=${HIDDEN}` : pair;
        })
        .join("&"),
    );
  }
  return clip(text);
}

/** One console argument (a CDP RemoteObject), as text. */
export function formatValue(obj) {
  if (!obj) return "";
  if (obj.type === "string") return String(obj.value);
  if ("unserializableValue" in obj) return String(obj.unserializableValue);
  if ("value" in obj) return obj.value === undefined ? "undefined" : JSON.stringify(obj.value);
  if (obj.type === "undefined") return "undefined";
  const p = obj.preview;
  if (p && Array.isArray(p.properties)) {
    const show = (prop) => (prop.type === "string" ? JSON.stringify(prop.value) : prop.value);
    const inner = p.properties
      .map((prop) => (p.subtype === "array" ? show(prop) : `${prop.name}: ${show(prop)}`))
      .join(", ");
    const more = p.overflow ? ", …" : "";
    return p.subtype === "array" ? `[${inner}${more}]` : `${obj.className === "Object" ? "" : `${obj.className} `}{${inner}${more}}`;
  }
  return String(obj.description ?? obj.className ?? obj.type);
}

const levelOf = (type) =>
  type === "error" || type === "assert"
    ? "error"
    : type === "warning" || type === "warn"
      ? "warning"
      : type === "debug" || type === "verbose"
        ? "debug"
        : "info";

const where = (frame) =>
  frame && frame.url ? `${frame.url}:${(frame.lineNumber ?? 0) + 1}:${(frame.columnNumber ?? 0) + 1}` : null;

const isoTime = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/**
 * What one tab's debugger session has seen since recording started: console messages,
 * uncaught exceptions, browser log entries (failed loads, CSP, deprecations) and the
 * network log. Bounded; the oldest go first, and how many were dropped is reported.
 */
// How many requests' wire headers may wait for their request at once.
const MAX_SENT = 200;

export class Recorder {
  constructor({ maxConsole = MAX_CONSOLE, maxNetwork = MAX_NETWORK, now = () => Date.now() } = {}) {
    this.maxConsole = maxConsole;
    this.maxNetwork = maxNetwork;
    this.now = now;
    this.recording = false;
    this.since = null;
    this.consoleLog = [];
    this.consoleDropped = 0;
    this.requests = new Map(); // key -> entry, insertion-ordered
    this.networkDropped = 0;
    this.seq = 0;
    this.redirects = 0;
    // What went on the wire (the *ExtraInfo events): headers the browser added after the
    // page asked — extension rules such as the Header Modifier's, cookies — which the
    // page-side events never show. They can arrive before the event they belong to, so
    // they wait here (bounded) until it does. requestId -> { request?, response? }
    this.sent = new Map();
    // Set while browser_viewport has changed the tab: what to put back.
    this.viewport = null;
  }

  start() {
    this.recording = true;
    if (!this.since) this.since = isoTime(this.now());
  }

  stop() {
    this.recording = false;
    this.viewport = null; // a detached debugger takes every override with it
  }

  pushConsole(entry) {
    this.consoleLog.push({ seq: ++this.seq, ...entry });
    if (this.consoleLog.length > this.maxConsole) {
      this.consoleLog.shift();
      this.consoleDropped++;
    }
  }

  onEvent(method, params = {}) {
    switch (method) {
      case "Runtime.consoleAPICalled": {
        const frame = params.stackTrace?.callFrames?.[0];
        this.pushConsole({
          level: levelOf(params.type),
          type: params.type,
          text: clip((params.args || []).map(formatValue).join(" ")),
          source: "console",
          location: where(frame),
          time: isoTime(params.timestamp),
        });
        return;
      }
      case "Runtime.exceptionThrown": {
        const d = params.exceptionDetails || {};
        const frame = d.stackTrace?.callFrames?.[0];
        this.pushConsole({
          level: "error",
          type: "exception",
          text: clip(d.exception?.description || d.text || "Uncaught exception"),
          source: "exception",
          location: where(frame) || (d.url ? `${d.url}:${(d.lineNumber ?? 0) + 1}` : null),
          time: isoTime(params.timestamp),
        });
        return;
      }
      case "Log.entryAdded": {
        const e = params.entry || {};
        this.pushConsole({
          level: levelOf(e.level),
          type: e.level,
          text: clip(e.text),
          source: e.source || "other",
          location: e.url ? `${e.url}${e.lineNumber != null ? `:${e.lineNumber + 1}` : ""}` : null,
          time: isoTime(e.timestamp),
        });
        return;
      }
      case "Network.requestWillBeSent": {
        const id = params.requestId;
        const prev = this.requests.get(id);
        if (prev && params.redirectResponse) {
          // The same id carries on through a redirect: file the hop under its own key.
          this.requests.delete(id);
          this.applyResponse(prev, params.redirectResponse);
          prev.state = "redirected";
          prev.duration_ms = this.elapsed(prev, params.timestamp);
          this.addRequest(`${id}:redirect${++this.redirects}`, prev);
        }
        const r = params.request || {};
        this.addRequest(id, {
          id,
          url: clip(r.url, 2000),
          method: r.method,
          type: params.type || "Other",
          state: "pending",
          status: null,
          status_text: null,
          mime_type: null,
          initiator: params.initiator?.type || null,
          started_at: isoTime((params.wallTime ?? NaN) * 1000),
          duration_ms: null,
          size: null,
          from_cache: false,
          protocol: null,
          error: null,
          request_headers: redactHeaders(r.headers),
          response_headers: null,
          post_data: redactBody(r.postData),
          _t0: params.timestamp,
        });
        this.applySent(id);
        return;
      }
      case "Network.responseReceived": {
        const entry = this.requests.get(params.requestId);
        if (!entry) return;
        this.applyResponse(entry, params.response || {});
        if (params.type) entry.type = params.type;
        this.applySent(params.requestId);
        return;
      }
      case "Network.requestWillBeSentExtraInfo":
      case "Network.responseReceivedExtraInfo": {
        const kind = method === "Network.requestWillBeSentExtraInfo" ? "request" : "response";
        const id = params.requestId;
        this.sent.set(id, { ...this.sent.get(id), [kind]: params.headers || {} });
        if (this.sent.size > MAX_SENT) this.sent.delete(this.sent.keys().next().value);
        this.applySent(id);
        return;
      }
      case "Network.loadingFinished": {
        const entry = this.requests.get(params.requestId);
        if (!entry) return;
        entry.state = "finished";
        entry.size = params.encodedDataLength ?? entry.size;
        entry.duration_ms = this.elapsed(entry, params.timestamp);
        return;
      }
      case "Network.loadingFailed": {
        const entry = this.requests.get(params.requestId);
        if (!entry) return;
        entry.state = "failed";
        entry.error = params.blockedReason
          ? `${params.errorText} (blocked: ${params.blockedReason})`
          : params.canceled
            ? `${params.errorText} (canceled)`
            : params.errorText || "failed";
        entry.duration_ms = this.elapsed(entry, params.timestamp);
        return;
      }
      default:
    }
  }

  applyResponse(entry, res) {
    entry.status = res.status ?? null;
    entry.status_text = res.statusText || null;
    entry.mime_type = res.mimeType || null;
    entry.from_cache = !!(res.fromDiskCache || res.fromServiceWorker || res.fromPrefetchCache);
    entry.protocol = res.protocol || null;
    entry.response_headers = redactHeaders(res.headers);
  }

  /** Merge what went on the wire into the entry, once the entry (and, for response
   * headers, its response) is there; what is merged is forgotten. */
  applySent(id) {
    const entry = this.requests.get(id);
    const sent = this.sent.get(id);
    if (!entry || !sent) return;
    if (sent.request) {
      entry.request_headers = { ...entry.request_headers, ...redactHeaders(sent.request) };
      delete sent.request;
    }
    if (sent.response && entry.response_headers) {
      entry.response_headers = { ...entry.response_headers, ...redactHeaders(sent.response) };
      delete sent.response;
    }
    if (!sent.request && !sent.response) this.sent.delete(id);
  }

  elapsed(entry, t) {
    return Number.isFinite(t) && Number.isFinite(entry._t0) ? Math.round((t - entry._t0) * 1000) : null;
  }

  addRequest(key, entry) {
    this.requests.set(key, entry);
    if (this.requests.size > this.maxNetwork) {
      this.requests.delete(this.requests.keys().next().value);
      this.networkDropped++;
    }
  }

  /** Console entries at `level` or worse, newest last, optionally only after `after`. */
  console({ level = "all", limit = 200, after = 0, clear = false } = {}) {
    const min = level === "all" ? -1 : (LEVELS[level] ?? -1);
    const matched = this.consoleLog.filter((e) => e.seq > after && LEVELS[e.level] >= min);
    const n = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    const out = {
      recording: this.recording,
      recording_since: this.since,
      total: matched.length,
      dropped: this.consoleDropped,
      entries: matched.slice(-n),
      truncated: matched.length > n,
    };
    if (clear) {
      this.consoleLog = [];
      this.consoleDropped = 0;
    }
    return out;
  }

  /** The network log, filtered; headers only when asked for. */
  network({ filter = "", type = "", failedOnly = false, headers = false, limit = 200, clear = false } = {}) {
    const needle = String(filter || "").toLowerCase();
    const kind = String(type || "").toLowerCase();
    const matched = [...this.requests.values()].filter(
      (e) =>
        (!needle || e.url.toLowerCase().includes(needle)) &&
        (!kind || String(e.type).toLowerCase() === kind) &&
        (!failedOnly || e.state === "failed" || (e.status ?? 0) >= 400),
    );
    const n = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    const out = {
      recording: this.recording,
      recording_since: this.since,
      total: matched.length,
      dropped: this.networkDropped,
      requests: matched.slice(-n).map(({ _t0, request_headers, response_headers, post_data, ...e }) =>
        headers ? { ...e, request_headers, response_headers, post_data } : e,
      ),
      truncated: matched.length > n,
    };
    if (clear) {
      this.requests.clear();
      this.sent.clear();
      this.networkDropped = 0;
    }
    return out;
  }

  hasRequest(id) {
    return this.requests.has(id);
  }
}

/** A Network.getResponseBody answer, as something a model can read. */
export function responseBody(res, entry) {
  const mime = entry?.mime_type || "";
  const textual = /^(text\/|application\/(json|javascript|xml|.*\+json|.*\+xml|x-www-form-urlencoded))|svg/i.test(mime);
  if (res.base64Encoded && !textual) {
    return { request_id: entry?.id ?? null, mime_type: mime || null, binary: true, size: entry?.size ?? null };
  }
  let body = String(res.body ?? "");
  if (res.base64Encoded) {
    const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
    body = new TextDecoder().decode(bytes);
  }
  return {
    request_id: entry?.id ?? null,
    mime_type: mime || null,
    body: body.length > MAX_BODY ? body.slice(0, MAX_BODY) : body,
    truncated: body.length > MAX_BODY,
    length: body.length,
  };
}

/** A Runtime.evaluate answer, as a result or an error a model can read. */
export function evaluationResult(res) {
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    return { ok: false, error: clip(d.exception?.description || d.text || "The script threw.") };
  }
  const r = res.result || {};
  let value;
  if ("unserializableValue" in r) value = String(r.unserializableValue);
  else if ("value" in r) value = r.value;
  else value = r.description ?? (r.type === "undefined" ? null : `[${r.subtype || r.type}]`);
  let text = JSON.stringify(value === undefined ? null : value);
  const truncated = text.length > MAX_RESULT;
  if (truncated) text = text.slice(0, MAX_RESULT);
  return truncated
    ? { ok: true, type: r.subtype || r.type, result_json: text, truncated: true }
    : { ok: true, type: r.subtype || r.type, result: value === undefined ? null : value };
}

/** browser_viewport's arguments, checked. Throws saying what is wrong. */
export function checkViewport({ width, height, device_scale_factor = 0, mobile = false }) {
  const w = Number(width);
  const h = Number(height);
  const dpr = Number(device_scale_factor) || 0;
  if (!Number.isInteger(w) || w < 200 || w > 5000 || !Number.isInteger(h) || h < 200 || h > 5000) {
    throw new Error("width and height must be whole numbers of CSS pixels between 200 and 5000.");
  }
  if (dpr !== 0 && (dpr < 0.5 || dpr > 4)) {
    throw new Error("device_scale_factor must be between 0.5 and 4 (or 0 for the screen's own).");
  }
  return { width: w, height: h, deviceScaleFactor: dpr, mobile: !!mobile };
}
