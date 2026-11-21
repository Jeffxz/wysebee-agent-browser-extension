// Fake network responses, for testing how a web app handles errors (browser_mock).
//
// An agent testing an app it is building can say "answer GET */api/orders* with a 500",
// "fail */api/login with ConnectionRefused" or "hold */api/search* for 3 s", then drive the
// page and see what the person would see. background.js carries it out with the Chrome
// DevTools Protocol's Fetch domain, on the tab's debugger session.
//
// Pure, like devtools.js: no chrome.*, so `node --test` covers it.
//
// **This rewrites traffic**, which devtools.js deliberately leaves out, so it is fenced in:
//
//   - MOCK_METHODS is its own boundary, separate from DEVTOOLS_METHODS: the Fetch calls
//     needed to answer, fail or hold a request, and none that reads a real response.
//   - policy.js asks every time unless the site is "allow everything" (meant for a web
//     app under automated test), and the prompt offers no "always".
//   - Rules belong to one tab and the site it was on: when the tab goes to another site,
//     or the agent is paused, unpaired or the debugger detached, they are all dropped.
//   - A page itself (resource type Document) is never faked, so the address bar always
//     shows a page that really came from that address. Only what a page loads — API
//     calls, scripts, images — is.

export const MOCK_METHODS = new Set([
  "Fetch.enable",
  "Fetch.disable",
  "Fetch.continueRequest",
  "Fetch.fulfillRequest",
  "Fetch.failRequest",
]);

export const MAX_RULES = 50;
export const MAX_MOCK_BODY = 1_000_000;
export const MAX_DELAY_MS = 30_000;

// Network.ErrorReason, as Fetch.failRequest takes it.
export const ERROR_REASONS = new Set([
  "Failed",
  "Aborted",
  "TimedOut",
  "AccessDenied",
  "ConnectionClosed",
  "ConnectionReset",
  "ConnectionRefused",
  "ConnectionAborted",
  "ConnectionFailed",
  "NameNotResolved",
  "InternetDisconnected",
  "AddressUnreachable",
  "BlockedByClient",
  "BlockedByResponse",
]);

// Network.ResourceType values a rule may name, Document deliberately absent (see above).
export const RESOURCE_TYPES = new Set([
  "XHR",
  "Fetch",
  "Script",
  "Stylesheet",
  "Image",
  "Media",
  "Font",
  "EventSource",
  "WebSocket",
  "Manifest",
  "Other",
]);

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
// Headers a fake response may not set: they would plant cookies or mislead security checks.
const FORBIDDEN_HEADERS = /^(set-cookie|set-cookie2|content-security-policy.*|strict-transport-security|access-control-allow-credentials)$/i;

/** A URL glob (`*` any run of characters, `?` one) as a RegExp over the whole URL. */
export function globToRegExp(glob) {
  const body = String(glob)
    .split("")
    .map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\/]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`);
}

/** UTF-8 text as base64, for Fetch.fulfillRequest. */
export function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const fail = (i, what) => {
  throw new Error(`Rule ${i + 1}: ${what}`);
};

/**
 * One rule from browser_mock's `rules`, checked and normalised. Throws saying what is wrong.
 *
 * `{url, method?, resource_type?, times?}` picks requests; then exactly one of
 * `status` (+ `headers`, `body` — a string, or JSON that is sent as JSON), `error`
 * (a Network.ErrorReason) or `delay_ms` alone (the real request, held back) says what
 * happens. `status` or `error` may also take `delay_ms`, to answer late.
 */
export function checkRule(raw, i = 0) {
  if (!raw || typeof raw !== "object") fail(i, "must be an object.");
  const url = String(raw.url ?? "").trim();
  if (!url || url.length > 2000) fail(i, "give `url`, a pattern such as */api/orders* (* matches anything).");
  if (!/^(\*|https?:)/.test(url)) fail(i, "`url` must start with http:, https: or *.");
  const method = raw.method == null ? null : String(raw.method).toUpperCase();
  if (method && !METHODS.has(method)) fail(i, `unknown method ${raw.method}.`);
  const type = raw.resource_type == null ? null : String(raw.resource_type);
  if (type && !RESOURCE_TYPES.has(type)) {
    fail(i, `resource_type must be one of ${[...RESOURCE_TYPES].join(", ")} (a page itself is never faked).`);
  }
  const times = raw.times == null ? null : Number(raw.times);
  if (times !== null && !(Number.isInteger(times) && times >= 1)) fail(i, "`times` must be a whole number from 1.");
  const delay = raw.delay_ms == null ? 0 : Number(raw.delay_ms);
  if (!(Number.isInteger(delay) && delay >= 0 && delay <= MAX_DELAY_MS)) {
    fail(i, `\`delay_ms\` must be a whole number from 0 to ${MAX_DELAY_MS}.`);
  }
  const rule = { url, method, resource_type: type, times, delay_ms: delay, hits: 0 };

  const hasStatus = raw.status != null;
  const hasError = raw.error != null;
  if (hasStatus && hasError) fail(i, "give `status` or `error`, not both.");
  if (hasError) {
    const error = String(raw.error);
    if (!ERROR_REASONS.has(error)) fail(i, `\`error\` must be one of ${[...ERROR_REASONS].join(", ")}.`);
    return { ...rule, action: "fail", error };
  }
  if (!hasStatus) {
    if (!delay) fail(i, "say what happens: `status` (a fake answer), `error` (a failed request) or `delay_ms`.");
    return { ...rule, action: "delay" };
  }
  const status = Number(raw.status);
  if (!(Number.isInteger(status) && status >= 100 && status <= 599)) fail(i, "`status` must be from 100 to 599.");
  const headers = {};
  if (raw.headers != null) {
    if (typeof raw.headers !== "object" || Array.isArray(raw.headers)) fail(i, "`headers` must be an object.");
    for (const [name, value] of Object.entries(raw.headers)) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) fail(i, `bad header name ${name}.`);
      if (FORBIDDEN_HEADERS.test(name)) fail(i, `a fake response may not set ${name}.`);
      headers[name.toLowerCase()] = String(value).replace(/[\r\n]/g, " ");
    }
  }
  let body = "";
  if (raw.body != null) {
    if (typeof raw.body === "string") body = raw.body;
    else {
      body = JSON.stringify(raw.body);
      headers["content-type"] ??= "application/json";
    }
  }
  if (body.length > MAX_MOCK_BODY) fail(i, `\`body\` is longer than ${MAX_MOCK_BODY} characters.`);
  return { ...rule, action: "respond", status, headers, body };
}

/**
 * The rules one tab answers with, and how often each has been used. The first rule that
 * matches a request (and has uses left) decides it; a request no rule matches goes on as
 * it would have.
 */
export class Mocks {
  constructor(origin) {
    this.origin = origin;
    this.rules = [];
  }

  /** Add rules from browser_mock's `rules`, checked first: none are added if one is wrong. */
  add(rawRules) {
    if (!Array.isArray(rawRules)) throw new Error("`rules` must be a list.");
    const checked = rawRules.map((r, i) => checkRule(r, i));
    if (this.rules.length + checked.length > MAX_RULES) throw new Error(`At most ${MAX_RULES} rules a tab.`);
    for (const r of checked) r.re = globToRegExp(r.url);
    this.rules.push(...checked);
  }

  clear() {
    this.rules = [];
  }

  get active() {
    return this.rules.some((r) => r.times === null || r.hits < r.times);
  }

  /** Fetch.enable's patterns: one per URL, at the request stage. */
  patterns() {
    return [...new Set(this.rules.map((r) => r.url))].map((urlPattern) => ({ urlPattern, requestStage: "Request" }));
  }

  /** The rule for a paused request (Fetch.requestPaused's params), counted as used; or null. */
  take({ request, resourceType }) {
    if (!request || resourceType === "Document") return null;
    const method = String(request.method || "GET").toUpperCase();
    for (const r of this.rules) {
      if (r.times !== null && r.hits >= r.times) continue;
      if (r.method && r.method !== method) continue;
      if (r.resource_type && r.resource_type !== resourceType) continue;
      if (!r.re.test(String(request.url))) continue;
      r.hits++;
      return r;
    }
    return null;
  }

  /** The rules as browser_mock reports them. */
  list() {
    return this.rules.map(({ re: _re, body, headers, ...r }) =>
      r.action === "respond" ? { ...r, headers, body_length: body.length } : r,
    );
  }
}

/** What to send for a paused request: `{method, params, delayMs}` for the Fetch domain. */
export function answerFor(rule, requestId) {
  if (!rule) return { method: "Fetch.continueRequest", params: { requestId }, delayMs: 0 };
  const delayMs = rule.delay_ms;
  if (rule.action === "fail") {
    return { method: "Fetch.failRequest", params: { requestId, errorReason: rule.error }, delayMs };
  }
  if (rule.action === "delay") return { method: "Fetch.continueRequest", params: { requestId }, delayMs };
  const headers = { ...rule.headers };
  headers["content-type"] ??= "text/plain; charset=utf-8";
  return {
    method: "Fetch.fulfillRequest",
    params: {
      requestId,
      responseCode: rule.status,
      responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })),
      body: toBase64(rule.body),
    },
    delayMs,
  };
}

/** One line per rule, for the approval prompt, such as "GET (glob) → 500". */
export function describeRules(rawRules) {
  if (!Array.isArray(rawRules)) return "";
  const line = (r) => {
    const what =
      r?.error != null ? String(r.error) : r?.status != null ? String(r.status) : `delay ${Number(r?.delay_ms) || 0} ms`;
    const extra = r?.status != null || r?.error != null ? (Number(r?.delay_ms) ? ` after ${Number(r.delay_ms)} ms` : "") : "";
    return `${r?.method ? `${String(r.method).toUpperCase()} ` : ""}${String(r?.url ?? "")} → ${what}${extra}`;
  };
  const text = rawRules.slice(0, 5).map(line).join("; ");
  return rawRules.length > 5 ? `${text}; and ${rawRules.length - 5} more` : text;
}
