import test from "node:test";
import assert from "node:assert/strict";
import {
  ERROR_REASONS,
  MAX_DELAY_MS,
  MAX_MOCK_BODY,
  MAX_RULES,
  MOCK_METHODS,
  Mocks,
  answerFor,
  checkRule,
  describeRules,
  globToRegExp,
  toBase64,
} from "./mock.js";
import { DEVTOOLS_METHODS } from "./devtools.js";
import { ALLOWED_METHODS } from "./native_input.js";

const paused = (url, method = "GET", resourceType = "Fetch") => ({ request: { url, method }, resourceType });

test("faking traffic has its own method list: answer, fail or hold, never read a real response", () => {
  assert.deepEqual([...MOCK_METHODS].sort(), [
    "Fetch.continueRequest",
    "Fetch.disable",
    "Fetch.enable",
    "Fetch.failRequest",
    "Fetch.fulfillRequest",
  ]);
  for (const m of MOCK_METHODS) {
    assert.ok(!DEVTOOLS_METHODS.has(m), m);
    assert.ok(!ALLOWED_METHODS.has(m), m);
  }
});

test("a URL glob matches the whole URL, * and ? as wildcards, everything else literally", () => {
  const re = globToRegExp("*/api/orders?id=*");
  assert.ok(re.test("https://a.example/api/orders?id=7"));
  assert.ok(!re.test("https://a.example/api/orders/7"));
  assert.ok(globToRegExp("https://a.example/x.js").test("https://a.example/x.js"));
  assert.ok(!globToRegExp("https://a.example/x.js").test("https://a.example/xajs"));
  assert.ok(globToRegExp("https://a.example/?").test("https://a.example/a"));
});

test("a body goes to Chrome as base64 of its UTF-8", () => {
  assert.equal(atob(toBase64("hi")), "hi");
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(toBase64("é✓")), (c) => c.charCodeAt(0))), "é✓");
});

test("a status rule is a fake answer; JSON bodies are sent as JSON", () => {
  const r = checkRule({ url: "*/api/*", method: "post", status: 500, body: { error: "boom" }, headers: { "X-A": "1\n2" } });
  assert.equal(r.action, "respond");
  assert.equal(r.method, "POST");
  assert.equal(r.body, '{"error":"boom"}');
  assert.deepEqual(r.headers, { "x-a": "1 2", "content-type": "application/json" });
  const s = checkRule({ url: "*", status: 404, body: "nope", headers: { "content-type": "text/html" } });
  assert.deepEqual(s.headers, { "content-type": "text/html" });
  assert.equal(s.body, "nope");
  assert.equal(checkRule({ url: "*", status: 204 }).body, "");
});

test("an error rule fails the request, a delay-only rule holds the real one", () => {
  assert.equal(checkRule({ url: "*", error: "ConnectionRefused" }).action, "fail");
  const d = checkRule({ url: "*", delay_ms: 2000, times: 2, resource_type: "XHR" });
  assert.equal(d.action, "delay");
  assert.equal(d.times, 2);
  assert.equal(d.resource_type, "XHR");
});

test("a wrong rule says which and what", () => {
  const bad = [
    [null, /object/],
    [{}, /url/],
    [{ url: "x".repeat(2001) }, /url/],
    [{ url: "ftp://x" }, /start with/],
    [{ url: "*", method: "BREW", status: 200 }, /method/],
    [{ url: "*", resource_type: "Document", status: 200 }, /never faked/],
    [{ url: "*", times: 0, status: 200 }, /times/],
    [{ url: "*", delay_ms: MAX_DELAY_MS + 1, status: 200 }, /delay_ms/],
    [{ url: "*", delay_ms: 1.5 }, /delay_ms/],
    [{ url: "*", status: 500, error: "Failed" }, /not both/],
    [{ url: "*", error: "Oops" }, /error/],
    [{ url: "*" }, /say what happens/],
    [{ url: "*", status: 99 }, /status/],
    [{ url: "*", status: 200, headers: [] }, /headers/],
    [{ url: "*", status: 200, headers: { "bad name": "x" } }, /header name/],
    [{ url: "*", status: 200, headers: { "Set-Cookie": "s=1" } }, /may not set/],
    [{ url: "*", status: 200, headers: { "Content-Security-Policy-Report-Only": "x" } }, /may not set/],
    [{ url: "*", status: 200, body: "x".repeat(MAX_MOCK_BODY + 1) }, /longer/],
  ];
  for (const [raw, re] of bad) assert.throws(() => checkRule(raw, 2), (e) => /^Rule 3: /.test(e.message) && re.test(e.message));
  assert.ok(ERROR_REASONS.has("TimedOut"));
});

test("the first matching rule with uses left decides; pages themselves are never faked", () => {
  const m = new Mocks("http://localhost:3000");
  m.add([
    { url: "*/api/orders*", method: "GET", status: 500, times: 1 },
    { url: "*/api/orders*", status: 200, body: "[]" },
    { url: "*.png", resource_type: "Image", error: "Failed" },
  ]);
  assert.equal(m.origin, "http://localhost:3000");
  assert.equal(m.take(paused("http://localhost:3000/api/orders", "POST")).status, 200); // not the GET-only rule
  m.rules[1].hits = 0;
  assert.equal(m.take(paused("http://localhost:3000/api/orders")).status, 500);
  assert.equal(m.take(paused("http://localhost:3000/api/orders")).status, 200);
  assert.equal(m.take(paused("http://localhost:3000/api/orders", "post")).status, 200);
  assert.equal(m.take(paused("http://localhost:3000/a.png", "GET", "Image")).action, "fail");
  assert.equal(m.take(paused("http://localhost:3000/a.png", "GET", "Fetch")), null);
  assert.equal(m.take(paused("http://localhost:3000/api/orders", "GET", "Document")), null);
  assert.equal(m.take({}), null);
  assert.equal(m.take({ request: { url: "http://localhost:3000/api/orders" } }).status, 200);
  assert.deepEqual(m.patterns(), [
    { urlPattern: "*/api/orders*", requestStage: "Request" },
    { urlPattern: "*.png", requestStage: "Request" },
  ]);
  const listed = m.list();
  assert.equal(listed[0].hits, 1);
  assert.equal(listed[1].body_length, 2);
  assert.equal(listed[2].body_length, undefined);
  assert.ok(!("re" in listed[0]));
  assert.ok(m.active);
  m.clear();
  assert.ok(!m.active);
  assert.deepEqual(m.list(), []);
});

test("rules used up are no longer active; a wrong batch adds nothing; there is a limit", () => {
  const m = new Mocks("https://a.example");
  m.add([{ url: "*", status: 500, times: 1 }]);
  m.take(paused("https://a.example/x"));
  assert.ok(!m.active);
  assert.throws(() => m.add([{ url: "*", status: 200 }, { url: "*" }]), /Rule 2/);
  assert.equal(m.rules.length, 1);
  assert.throws(() => m.add("nope"), /list/);
  assert.throws(() => m.add(Array.from({ length: MAX_RULES }, () => ({ url: "*", status: 200 }))), /At most/);
});

test("each kind of rule becomes the right Fetch call", () => {
  assert.deepEqual(answerFor(null, "r1"), { method: "Fetch.continueRequest", params: { requestId: "r1" }, delayMs: 0 });
  assert.deepEqual(answerFor(checkRule({ url: "*", delay_ms: 300 }), "r2"), {
    method: "Fetch.continueRequest",
    params: { requestId: "r2" },
    delayMs: 300,
  });
  assert.deepEqual(answerFor(checkRule({ url: "*", error: "TimedOut", delay_ms: 50 }), "r3"), {
    method: "Fetch.failRequest",
    params: { requestId: "r3", errorReason: "TimedOut" },
    delayMs: 50,
  });
  const a = answerFor(checkRule({ url: "*", status: 503, body: "down" }), "r4");
  assert.equal(a.method, "Fetch.fulfillRequest");
  assert.equal(a.params.responseCode, 503);
  assert.equal(atob(a.params.body), "down");
  assert.deepEqual(a.params.responseHeaders, [{ name: "content-type", value: "text/plain; charset=utf-8" }]);
});

test("the prompt lists what will be faked, briefly", () => {
  assert.equal(
    describeRules([
      { url: "*/api/orders*", method: "get", status: 500 },
      { url: "*/api/login", error: "ConnectionRefused", delay_ms: 2000 },
      { url: "*/api/search*", delay_ms: 3000 },
      { url: "*", status: 200 },
    ]),
    "GET */api/orders* → 500; */api/login → ConnectionRefused after 2000 ms; */api/search* → delay 3000 ms; * → 200",
  );
  assert.equal(describeRules(Array.from({ length: 7 }, () => ({}))).endsWith("; and 2 more"), true);
  assert.equal(describeRules(Array.from({ length: 1 }, () => ({})))," → delay 0 ms");
  assert.equal(describeRules(null), "");
});
