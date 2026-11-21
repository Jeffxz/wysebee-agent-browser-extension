// Run with: node --test apps/browser_probe/extension/
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEVTOOLS_METHODS,
  HIDDEN,
  MAX_BODY,
  MAX_RESULT,
  RECORDING_DOMAINS,
  Recorder,
  checkViewport,
  evaluationResult,
  formatValue,
  redactBody,
  redactHeaders,
  responseBody,
} from "./devtools.js";
import { ALLOWED_METHODS } from "./native_input.js";

test("the method list is exactly what the developer tools need, and no cookie or interception call", () => {
  assert.deepEqual([...DEVTOOLS_METHODS].sort(), [
    "Emulation.clearDeviceMetricsOverride",
    "Emulation.setDeviceMetricsOverride",
    "Emulation.setTouchEmulationEnabled",
    "Emulation.setUserAgentOverride",
    "Log.enable",
    "Network.enable",
    "Network.getResponseBody",
    "Performance.enable",
    "Performance.getMetrics",
    "Runtime.enable",
    "Runtime.evaluate",
  ]);
  for (const m of DEVTOOLS_METHODS) assert.ok(!/cookie|Storage\.|Fetch\.|Target\.|Browser\./i.test(m), m);
  for (const m of RECORDING_DOMAINS) assert.ok(DEVTOOLS_METHODS.has(m), m);
  // Real mouse input keeps its own one-method list.
  assert.ok(!DEVTOOLS_METHODS.has("Input.dispatchMouseEvent"));
  assert.deepEqual([...ALLOWED_METHODS], ["Input.dispatchMouseEvent"]);
});

test("secret headers are hidden, request and response alike", () => {
  assert.deepEqual(
    redactHeaders({ Authorization: "Bearer x", Cookie: "s=1", "Set-Cookie": "s=2", "X-API-Key": "k", Accept: "*/*" }),
    { authorization: HIDDEN, cookie: HIDDEN, "set-cookie": HIDDEN, "x-api-key": HIDDEN, accept: "*/*" },
  );
  assert.deepEqual(redactHeaders(undefined), {});
  assert.ok(redactHeaders({ big: "x".repeat(2000) }).big.length < 1100);
});

test("password-like fields in a request body are hidden", () => {
  assert.equal(redactBody(null), null);
  assert.equal(redactBody(""), null);
  assert.equal(
    redactBody(JSON.stringify({ user: "a", password: "p", nested: [{ apiKey: "k", ok: 1 }] })),
    JSON.stringify({ user: "a", password: HIDDEN, nested: [{ apiKey: HIDDEN, ok: 1 }] }),
  );
  assert.equal(redactBody("user=a&passwd=p&csrf_token=t&x=1"), `user=a&passwd=${HIDDEN}&csrf_token=${HIDDEN}&x=1`);
  assert.equal(redactBody("%E0%A4%A=1"), "%E0%A4%A=1"); // undecodable name kept as sent
  assert.equal(redactBody("just some text"), "just some text");
  assert.equal(redactBody("42"), "42"); // JSON, but not an object
  assert.ok(redactBody("y".repeat(5000)).includes("more characters"));
});

test("console arguments read as DevTools shows them", () => {
  assert.equal(formatValue(null), "");
  assert.equal(formatValue({ type: "string", value: "hi" }), "hi");
  assert.equal(formatValue({ type: "number", value: 3 }), "3");
  assert.equal(formatValue({ type: "number", unserializableValue: "NaN" }), "NaN");
  assert.equal(formatValue({ type: "undefined" }), "undefined");
  assert.equal(formatValue({ type: "object", value: undefined }), "undefined");
  assert.equal(
    formatValue({
      type: "object",
      className: "Object",
      preview: { properties: [{ name: "a", type: "number", value: "1" }, { name: "b", type: "string", value: "x" }], overflow: true },
    }),
    '{a: 1, b: "x", …}',
  );
  assert.equal(
    formatValue({ type: "object", className: "Map", preview: { properties: [{ name: "k", type: "number", value: "2" }] } }),
    "Map {k: 2}",
  );
  assert.equal(
    formatValue({ type: "object", subtype: "array", className: "Array", preview: { subtype: "array", properties: [{ name: "0", type: "number", value: "1" }] } }),
    "[1]",
  );
  assert.equal(formatValue({ type: "function", description: "function f() {}" }), "function f() {}");
  assert.equal(formatValue({ type: "symbol" }), "symbol");
});

test("console, exceptions and browser log entries are recorded with levels", () => {
  const rec = new Recorder({ now: () => Date.UTC(2026, 0, 1) });
  rec.start();
  rec.start(); // a second start keeps the first moment
  assert.equal(rec.since, "2026-01-01T00:00:00.000Z");
  rec.onEvent("Runtime.consoleAPICalled", {
    type: "log",
    args: [{ type: "string", value: "hello" }, { type: "number", value: 2 }],
    timestamp: Date.UTC(2026, 0, 1),
    stackTrace: { callFrames: [{ url: "https://a.example/app.js", lineNumber: 9, columnNumber: 4 }] },
  });
  rec.onEvent("Runtime.consoleAPICalled", { type: "warning", args: [] });
  rec.onEvent("Runtime.consoleAPICalled", { type: "debug" });
  rec.onEvent("Runtime.exceptionThrown", {
    timestamp: 1,
    exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: x is undefined" }, url: "https://a.example/b.js", lineNumber: 2 },
  });
  rec.onEvent("Runtime.exceptionThrown", {});
  rec.onEvent("Log.entryAdded", { entry: { source: "network", level: "error", text: "Failed to load", url: "https://a.example/x.png", timestamp: 2 } });
  rec.onEvent("Log.entryAdded", { entry: { level: "verbose", text: "v", url: "https://a.example/", lineNumber: 0 } });
  rec.onEvent("Log.entryAdded", {});
  rec.onEvent("Something.else", {});

  const all = rec.console();
  assert.equal(all.total, 8);
  assert.equal(all.recording, true);
  assert.deepEqual(all.entries[0], {
    seq: 1,
    level: "info",
    type: "log",
    text: "hello 2",
    source: "console",
    location: "https://a.example/app.js:10:5",
    time: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(all.entries[3].text, "TypeError: x is undefined");
  assert.equal(all.entries[3].location, "https://a.example/b.js:3");
  assert.equal(all.entries[4].text, "Uncaught exception");
  assert.equal(all.entries[4].location, null);
  assert.equal(all.entries[5].source, "network");
  assert.equal(all.entries[6].location, "https://a.example/:1");
  assert.equal(all.entries[7].source, "other");

  assert.deepEqual(rec.console({ level: "error" }).entries.map((e) => e.seq), [4, 5, 6]);
  assert.deepEqual(rec.console({ level: "warning" }).entries.map((e) => e.seq), [2, 4, 5, 6]);
  assert.equal(rec.console({ level: "bogus" }).total, 8);
  assert.deepEqual(rec.console({ after: 6 }).entries.map((e) => e.seq), [7, 8]);
  const limited = rec.console({ limit: 2 });
  assert.deepEqual([limited.entries.length, limited.truncated], [2, true]);
  rec.console({ clear: true });
  assert.equal(rec.console().total, 0);
  rec.stop();
  assert.equal(rec.console().recording, false);
});

test("the console keeps the newest and counts what it dropped", () => {
  const rec = new Recorder({ maxConsole: 2 });
  for (const v of ["a", "b", "c"]) rec.onEvent("Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: v }] });
  const out = rec.console();
  assert.deepEqual([out.entries.map((e) => e.text), out.dropped], [["b", "c"], 1]);
  rec.console({ clear: true });
  assert.equal(rec.console().dropped, 0);
});

const sent = (id, url, extra = {}) => ({
  requestId: id,
  request: { url, method: "GET", headers: { Cookie: "s=1", Accept: "*/*" } },
  type: "Fetch",
  timestamp: 10,
  wallTime: 1767225600,
  initiator: { type: "script" },
  ...extra,
});

test("the network log follows a request from start to finish, with secrets hidden", () => {
  const rec = new Recorder();
  rec.start();
  rec.onEvent("Network.requestWillBeSent", sent("1", "https://api.example/users", { request: { url: "https://api.example/users", method: "POST", headers: { Authorization: "Bearer t" }, postData: '{"password":"p"}' } }));
  rec.onEvent("Network.responseReceived", {
    requestId: "1",
    type: "XHR",
    response: { status: 201, statusText: "Created", mimeType: "application/json", headers: { "Set-Cookie": "s=2" }, protocol: "h2", fromDiskCache: false },
  });
  rec.onEvent("Network.loadingFinished", { requestId: "1", timestamp: 10.25, encodedDataLength: 512 });
  rec.onEvent("Network.requestWillBeSent", sent("2", "https://cdn.example/x.js"));
  rec.onEvent("Network.loadingFailed", { requestId: "2", errorText: "net::ERR_FAILED", blockedReason: "csp", timestamp: 10.5 });
  rec.onEvent("Network.requestWillBeSent", sent("3", "https://cdn.example/y.js"));
  rec.onEvent("Network.loadingFailed", { requestId: "3", errorText: "net::ERR_ABORTED", canceled: true });
  rec.onEvent("Network.requestWillBeSent", sent("4", "https://cdn.example/z.js"));
  rec.onEvent("Network.loadingFailed", { requestId: "4" });
  rec.onEvent("Network.requestWillBeSent", { requestId: "5", timestamp: 11 }); // a bare one
  rec.onEvent("Network.requestWillBeSent", sent("6", "https://a.example/404"));
  rec.onEvent("Network.responseReceived", { requestId: "6", response: { status: 404, fromServiceWorker: true } });
  rec.onEvent("Network.loadingFinished", { requestId: "6" });
  // events for requests that were never seen are ignored
  rec.onEvent("Network.responseReceived", { requestId: "nope", response: {} });
  rec.onEvent("Network.loadingFinished", { requestId: "nope" });
  rec.onEvent("Network.loadingFailed", { requestId: "nope" });

  const plain = rec.network();
  assert.equal(plain.total, 6);
  const first = plain.requests[0];
  assert.deepEqual(first, {
    id: "1",
    url: "https://api.example/users",
    method: "POST",
    type: "XHR",
    state: "finished",
    status: 201,
    status_text: "Created",
    mime_type: "application/json",
    initiator: "script",
    started_at: "2026-01-01T00:00:00.000Z",
    duration_ms: 250,
    size: 512,
    from_cache: false,
    protocol: "h2",
    error: null,
  });
  assert.ok(!("request_headers" in first) && !("_t0" in first));
  const detailed = rec.network({ headers: true }).requests[0];
  assert.deepEqual(detailed.request_headers, { authorization: HIDDEN });
  assert.deepEqual(detailed.response_headers, { "set-cookie": HIDDEN });
  assert.equal(detailed.post_data, JSON.stringify({ password: HIDDEN }));
  assert.ok(!("_t0" in detailed));

  const errors = Object.fromEntries(plain.requests.map((r) => [r.id, r.error]));
  assert.equal(errors["2"], "net::ERR_FAILED (blocked: csp)");
  assert.equal(errors["3"], "net::ERR_ABORTED (canceled)");
  assert.equal(errors["4"], "failed");
  assert.equal(plain.requests.find((r) => r.id === "3").duration_ms, null);
  const bare = plain.requests.find((r) => r.id === "5");
  assert.deepEqual([bare.type, bare.started_at, bare.post_data], ["Other", null, undefined]);
  const cached = plain.requests.find((r) => r.id === "6");
  assert.deepEqual([cached.from_cache, cached.status_text, cached.size], [true, null, null]);

  assert.deepEqual(rec.network({ failedOnly: true }).requests.map((r) => r.id), ["2", "3", "4", "6"]);
  assert.deepEqual(rec.network({ filter: "CDN.example/Y" }).requests.map((r) => r.id), ["3"]);
  assert.deepEqual(rec.network({ type: "xhr" }).requests.map((r) => r.id), ["1"]);
  const limited = rec.network({ limit: 1 });
  assert.deepEqual([limited.requests.map((r) => r.id), limited.truncated], [["6"], true]);
  assert.ok(rec.hasRequest("1") && !rec.hasRequest("nope"));
  rec.network({ clear: true });
  assert.equal(rec.network().total, 0);
});

test("what went on the wire is merged in, whichever event comes first", () => {
  const rec = new Recorder();
  rec.start();
  const headersOf = (id) => rec.network({ headers: true }).requests.find((r) => r.id === id);
  // The page's own headers, then what the browser sent (an extension's rule, a cookie).
  rec.onEvent("Network.requestWillBeSent", sent("1", "https://api.example/a", { request: { url: "https://api.example/a", method: "GET", headers: { Accept: "*/*" } } }));
  rec.onEvent("Network.requestWillBeSentExtraInfo", { requestId: "1", headers: { accept: "*/*", "x-customer": "abc", cookie: "s=1" } });
  assert.deepEqual(headersOf("1").request_headers, { accept: "*/*", "x-customer": "abc", cookie: "(hidden)" });
  // The wire headers first: they wait for their request, and the response's for its response.
  rec.onEvent("Network.requestWillBeSentExtraInfo", { requestId: "2", headers: { "x-customer": "abc" } });
  rec.onEvent("Network.responseReceivedExtraInfo", { requestId: "2", headers: { "set-cookie": "s=2", "x-raw": "1" } });
  rec.onEvent("Network.requestWillBeSent", sent("2", "https://api.example/b"));
  assert.equal(headersOf("2").request_headers["x-customer"], "abc");
  assert.equal(headersOf("2").response_headers, null);
  rec.onEvent("Network.responseReceived", { requestId: "2", response: { status: 200, headers: { "Content-Type": "application/json" } } });
  assert.deepEqual(headersOf("2").response_headers, { "content-type": "application/json", "set-cookie": "(hidden)", "x-raw": "1" });
  assert.equal(rec.sent.size, 0);
  // Wire headers for a request never seen are bounded, and go with a clear.
  for (let i = 0; i < 250; i++) rec.onEvent("Network.requestWillBeSentExtraInfo", { requestId: `n${i}`, headers: {} });
  assert.equal(rec.sent.size, 200);
  rec.network({ clear: true });
  assert.equal(rec.sent.size, 0);
});

test("a redirect keeps each hop under its own key", () => {
  const rec = new Recorder();
  rec.onEvent("Network.requestWillBeSent", sent("1", "http://a.example/"));
  rec.onEvent(
    "Network.requestWillBeSent",
    sent("1", "https://a.example/", { timestamp: 10.1, redirectResponse: { status: 301, headers: { Location: "https://a.example/" } } }),
  );
  const [hop, final] = rec.network().requests;
  assert.deepEqual([hop.id, hop.state, hop.status, hop.duration_ms], ["1", "redirected", 301, 100]);
  assert.deepEqual([final.id, final.url, final.state], ["1", "https://a.example/", "pending"]);
  assert.ok(rec.hasRequest("1:redirect1"));
});

test("the network log keeps the newest and counts what it dropped", () => {
  const rec = new Recorder({ maxNetwork: 2 });
  for (const id of ["a", "b", "c"]) rec.onEvent("Network.requestWillBeSent", sent(id, `https://x.example/${id}`));
  const out = rec.network();
  assert.deepEqual([out.requests.map((r) => r.id), out.dropped], [["b", "c"], 1]);
  rec.network({ clear: true });
  assert.equal(rec.network().dropped, 0);
});

test("stopping forgets the viewport override, which went with the debugger", () => {
  const rec = new Recorder();
  rec.viewport = { userAgent: null };
  rec.stop();
  assert.equal(rec.viewport, null);
});

test("response bodies: text decoded and capped, binary only described", () => {
  const entry = { id: "1", mime_type: "application/json", size: 10 };
  assert.deepEqual(responseBody({ body: '{"a":1}', base64Encoded: false }, entry), {
    request_id: "1",
    mime_type: "application/json",
    body: '{"a":1}',
    truncated: false,
    length: 7,
  });
  const b64 = Buffer.from("héllo").toString("base64");
  assert.equal(responseBody({ body: b64, base64Encoded: true }, { id: "2", mime_type: "text/plain" }).body, "héllo");
  assert.deepEqual(responseBody({ body: "AAAA", base64Encoded: true }, { id: "3", mime_type: "image/png", size: 3 }), {
    request_id: "3",
    mime_type: "image/png",
    binary: true,
    size: 3,
  });
  assert.deepEqual(responseBody({ base64Encoded: true }, undefined), { request_id: null, mime_type: null, binary: true, size: null });
  const big = responseBody({ body: "x".repeat(MAX_BODY + 5) }, null);
  assert.deepEqual([big.body.length, big.truncated, big.length, big.mime_type], [MAX_BODY, true, MAX_BODY + 5, null]);
});

test("evaluation results come back as values, or as the error the page threw", () => {
  assert.deepEqual(evaluationResult({ result: { type: "number", value: 4 } }), { ok: true, type: "number", result: 4 });
  assert.deepEqual(evaluationResult({ result: { type: "number", unserializableValue: "-0" } }), { ok: true, type: "number", result: "-0" });
  assert.deepEqual(evaluationResult({ result: { type: "undefined" } }), { ok: true, type: "undefined", result: null });
  assert.deepEqual(evaluationResult({ result: { type: "object", subtype: "node", description: "div#app" } }), {
    ok: true,
    type: "node",
    result: "div#app",
  });
  assert.deepEqual(evaluationResult({ result: { type: "object", subtype: "promise" } }), { ok: true, type: "promise", result: "[promise]" });
  assert.deepEqual(evaluationResult({}), { ok: true, type: undefined, result: "[undefined]" });
  assert.deepEqual(evaluationResult({ exceptionDetails: { exception: { description: "ReferenceError: y" } } }), {
    ok: false,
    error: "ReferenceError: y",
  });
  assert.deepEqual(evaluationResult({ exceptionDetails: { text: "Uncaught" } }), { ok: false, error: "Uncaught" });
  assert.deepEqual(evaluationResult({ exceptionDetails: {} }), { ok: false, error: "The script threw." });
  const big = evaluationResult({ result: { type: "string", value: "z".repeat(MAX_RESULT + 10) } });
  assert.deepEqual([big.truncated, big.result_json.length, "result" in big], [true, MAX_RESULT, false]);
});

test("viewport sizes are checked", () => {
  assert.deepEqual(checkViewport({ width: 375, height: 812, device_scale_factor: 3, mobile: true }), {
    width: 375,
    height: 812,
    deviceScaleFactor: 3,
    mobile: true,
  });
  assert.deepEqual(checkViewport({ width: 1280, height: 800 }), { width: 1280, height: 800, deviceScaleFactor: 0, mobile: false });
  for (const bad of [{ width: 100, height: 800 }, { width: 1280.5, height: 800 }, { width: 1280 }, { width: 1280, height: 9000 }]) {
    assert.throws(() => checkViewport(bad), /between 200 and 5000/);
  }
  assert.throws(() => checkViewport({ width: 400, height: 400, device_scale_factor: 9 }), /device_scale_factor/);
});

test("missing fields in events fall back instead of breaking the log", () => {
  const rec = new Recorder();
  // A frame with a URL but no line or column reads as 1:1.
  rec.onEvent("Runtime.consoleAPICalled", { type: "log", args: [], stackTrace: { callFrames: [{ url: "https://a.example/a.js" }] } });
  // An exception's own stack wins over its url; a url with no line reads as line 1.
  rec.onEvent("Runtime.exceptionThrown", {
    exceptionDetails: { text: "boom", url: "https://a.example/b.js", stackTrace: { callFrames: [{ url: "https://a.example/c.js", lineNumber: 4, columnNumber: 0 }] } },
  });
  rec.onEvent("Runtime.exceptionThrown", { exceptionDetails: { text: "boom", url: "https://a.example/d.js" } });
  const locations = rec.console().entries.map((e) => e.location);
  assert.deepEqual(locations, ["https://a.example/a.js:1:1", "https://a.example/c.js:5:1", "https://a.example/d.js:1"]);

  // A response with no response object, and wire headers with no headers.
  rec.onEvent("Network.requestWillBeSent", sent("1", "https://a.example/x"));
  rec.onEvent("Network.responseReceived", { requestId: "1" });
  rec.onEvent("Network.responseReceivedExtraInfo", { requestId: "1" });
  const entry = rec.network({ headers: true }).requests[0];
  assert.deepEqual([entry.status, entry.status_text, entry.mime_type, entry.response_headers], [null, null, null, {}]);
  assert.equal(rec.sent.size, 0);
});

test("a limit that is not a number means the default of 200", () => {
  const rec = new Recorder();
  for (let i = 0; i < 205; i++) {
    rec.onEvent("Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: String(i) }] });
    rec.onEvent("Network.requestWillBeSent", sent(String(i), `https://a.example/${i}`));
  }
  for (const limit of [0, "lots"]) {
    assert.equal(rec.console({ limit }).entries.length, 200);
    assert.equal(rec.network({ limit }).requests.length, 200);
  }
});

test("a text body that is missing reads as empty; an undefined value as null", () => {
  assert.deepEqual(responseBody({ base64Encoded: false }, { id: "1", mime_type: "text/plain" }), {
    request_id: "1",
    mime_type: "text/plain",
    body: "",
    truncated: false,
    length: 0,
  });
  assert.deepEqual(evaluationResult({ result: { type: "object", value: undefined } }), { ok: true, type: "object", result: null });
});
