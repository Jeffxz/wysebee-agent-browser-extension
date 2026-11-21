import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  BACKOFF_MS,
  CODE_ALPHABET,
  MAX_RESULT_BYTES,
  UNPAIRED,
  afterPoll,
  backoff,
  browserName,
  checkName,
  exchange,
  formatCode,
  makeSecret,
  normaliseCode,
  pollRequest,
  polls,
  publicState,
  resultBody,
  resultRequest,
  secretHash,
  startRequest,
  started,
  unpairRequest,
  recordingRequest,
} from "./link.js";

const S = "https://app.wysebee.com";

test("the secret is 32 random bytes, base64url", () => {
  const secret = makeSecret();
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(secret, makeSecret());
  const fixed = makeSecret((bytes) => bytes.fill(255));
  assert.equal(fixed, "_".repeat(42) + "8");
  assert.equal(Buffer.from(fixed, "base64url").length, 32);
});

test("the hash is the SHA-256 of the secret as sent, in hex", async () => {
  const secret = makeSecret();
  const hash = await secretHash(secret);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, createHash("sha256").update(secret, "utf8").digest("hex"));
});

test("a code is normalised and shown as XXXX-XXXX", () => {
  assert.equal(normaliseCode("abcd-efgh"), "ABCDEFGH");
  assert.equal(normaliseCode(" ABCD EFGH "), "ABCDEFGH");
  assert.equal(formatCode("ABCDEFGH"), "ABCD-EFGH");
  assert.equal(formatCode("abcd-2345"), "ABCD-2345");
  assert.equal(formatCode("ABCDEFG"), "");
  assert.equal(formatCode("ABCDEFG0"), ""); // 0 is not in the alphabet
  assert.equal(formatCode("ABCDEFGI"), "");
  assert.equal(formatCode(null), "");
  assert.equal(CODE_ALPHABET.length, 32);
});

test("an agent name is one line of 1 to 60 characters", () => {
  assert.equal(checkName("  Research helper "), "Research helper");
  assert.equal(checkName(""), null);
  assert.equal(checkName("   "), null);
  assert.equal(checkName("a\nb"), null);
  assert.equal(checkName("x".repeat(60)), "x".repeat(60));
  assert.equal(checkName("x".repeat(61)), null);
  assert.equal(checkName("蜂".repeat(60)), "蜂".repeat(60));
});

test("the browser is named by its user agent", () => {
  assert.equal(browserName("Mozilla/5.0 Chrome/130.0 Safari/537.36"), "Chrome");
  assert.equal(browserName("Mozilla/5.0 Chrome/130.0 Safari/537.36 Edg/130.0"), "Edge");
});

test("the start request carries the name, the hash and the agent type, and no auth", () => {
  const r = startRequest(S, { name: "Helper", secretHash: "ab".repeat(32), browser: "Chrome", version: "0.1.0" });
  assert.equal(r.url, "https://app.wysebee.com/api/v1/browser-links/start");
  assert.equal(r.init.method, "POST");
  assert.equal(r.init.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(r.init.body), {
    name: "Helper",
    secret_hash: "ab".repeat(32),
    browser: "Chrome",
    extension_version: "0.1.0",
    kind: "wysebee-browser-chrome",
  });
  // Edge pairs as Chrome's type until a wysebee-browser-edge one is registered.
  const edge = startRequest(S, { name: "Helper", secretHash: "ab".repeat(32), browser: "Edge", version: "0.1.0" });
  assert.equal(JSON.parse(edge.init.body).kind, "wysebee-browser-chrome");
});

test("the poll request is authed and carries the status, paused only when switched off", () => {
  const r = pollRequest(S, "abc123", "sekret", { version: "0.1.0", browser: "Edge" });
  assert.equal(r.url, "https://app.wysebee.com/api/v1/browser-links/abc123/poll?wait=20");
  assert.equal(r.init.method, "POST");
  assert.equal(r.init.headers.Authorization, "Bearer sekret");
  assert.deepEqual(JSON.parse(r.init.body), {
    status: { paused: false, extension_version: "0.1.0", browser: "Edge" },
  });
  // The last poll before the Enabled switch stops polling says so.
  const off = pollRequest(S, "abc123", "sekret", { paused: true, version: "0.1.0", browser: "Edge" }, 0);
  assert.equal(JSON.parse(off.init.body).status.paused, true);
  assert.match(pollRequest(S, "a", "s", {}, 0).url, /wait=0$/);
  assert.match(pollRequest(S, "a", "s", {}, 99).url, /wait=25$/);
});

test("the result request posts the outcome", () => {
  const ok = resultRequest(S, "abc", "sekret", "call/1", { ok: true, result: { tabs: [] } });
  assert.equal(ok.url, "https://app.wysebee.com/api/v1/browser-links/abc/calls/call%2F1/result");
  assert.equal(ok.init.headers.Authorization, "Bearer sekret");
  assert.deepEqual(JSON.parse(ok.init.body), { ok: true, result: { tabs: [] } });
  assert.deepEqual(JSON.parse(resultBody({ ok: true })), { ok: true, result: null });
  assert.deepEqual(JSON.parse(resultBody({ ok: false, error: "The user declined." })), {
    ok: false,
    error: "The user declined.",
  });
});

test("a result over 16 MB becomes a failure", () => {
  const body = JSON.parse(resultBody({ ok: true, result: "x".repeat(MAX_RESULT_BYTES) }));
  assert.equal(body.ok, false);
  assert.match(body.error, /too large/);
});

test("the unpair request is a DELETE with the secret", () => {
  const r = unpairRequest(S, "abc", "sekret");
  assert.equal(r.url, "https://app.wysebee.com/api/v1/browser-links/abc");
  assert.deepEqual(r.init, { method: "DELETE", headers: { Authorization: "Bearer sekret" } });
});

test("a recording is posted as video/webm, what it shows in the query", () => {
  const r = recordingRequest(S, "a b", "sekret", {
    name: "checkout fails",
    startedAt: Date.UTC(2026, 10, 19, 8, 0, 0),
    durationMs: 1234.6,
    origin: "http://localhost:3000",
    callId: "c1",
  });
  assert.equal(
    r.url,
    "https://app.wysebee.com/api/v1/browser-links/a%20b/recordings?name=checkout+fails&started_at=2026-11-19T08%3A00%3A00.000Z&duration_ms=1235&origin=http%3A%2F%2Flocalhost%3A3000&call_id=c1",
  );
  assert.deepEqual(r.init, { method: "POST", headers: { Authorization: "Bearer sekret", "Content-Type": "video/webm" } });
  const bare = recordingRequest(S, "x", "s", { name: null, startedAt: 0, durationMs: "nope" });
  assert.equal(bare.url, `${S}/api/v1/browser-links/x/recordings?name=&started_at=1970-01-01T00%3A00%3A00.000Z&duration_ms=0`);
});

test("exchange sends with the fetch handed in and reads the JSON", async () => {
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push({ url, init });
    return { status: 200, json: async () => ({ state: "pending" }) };
  };
  const answer = await exchange(fetchFn, { url: "https://x/y", init: { method: "POST" } });
  assert.deepEqual(answer, { status: 200, body: { state: "pending" } });
  assert.equal(seen[0].url, "https://x/y");
  assert.ok(seen[0].init.signal instanceof AbortSignal);

  const empty = await exchange(async () => ({ status: 204, json: async () => { throw new Error("no body"); } }), { url: "u", init: {} });
  assert.deepEqual(empty, { status: 204, body: null });

  await assert.rejects(exchange(async () => { throw new Error("offline"); }, { url: "u", init: {} }));
});

test("exchange gives up when nothing answers in time", async () => {
  const fetchFn = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  await assert.rejects(exchange(fetchFn, { url: "u", init: {} }, 10), /aborted/);
});

test("start makes a pending state with the code", () => {
  const state = started("Helper", "sekret", { id: "f".repeat(32), code: "ABCDEFGH", expires_in: 600 }, 1000);
  assert.deepEqual(state, {
    phase: "pending",
    id: "f".repeat(32),
    secret: "sekret",
    name: "Helper",
    code: "ABCDEFGH",
    expiresAt: 601_000,
  });
  assert.equal(started("Helper", "s", { id: "x", code: "bad" }, 0), null);
  assert.equal(started("Helper", "s", { code: "ABCDEFGH" }, 0), null);
  assert.equal(started("Helper", "s", null, 0), null);
});

const pending = { phase: "pending", id: "id1", secret: "sek", name: "Helper", code: "ABCDEFGH", expiresAt: 600_000 };
const paired = { phase: "paired", id: "id1", secret: "sek", agent: { name: "helper", label: "Helper" } };
const ok = (body) => ({ status: 200, body });

test("pending stays pending, with the cloud's clock", () => {
  const out = afterPoll(pending, ok({ state: "pending", expires_in: 100 }), 5_000);
  assert.equal(out.state.phase, "pending");
  assert.equal(out.state.expiresAt, 105_000);
  assert.equal(out.failed, false);
  assert.deepEqual(out.calls, []);
});

test("pending becomes paired when claimed", () => {
  const out = afterPoll(pending, ok({ state: "paired", agent: { name: "helper", label: "Helper" }, calls: [], cancelled: [] }), 1);
  assert.deepEqual(out.state, paired);
});

test("a refused claim says why", () => {
  const out = afterPoll(pending, ok({ state: "refused", reason: "name_taken", message: "An agent has that name." }), 1);
  assert.deepEqual(out.state, { phase: "refused", name: "Helper", reason: "name_taken", message: "An agent has that name." });
  const odd = afterPoll(pending, ok({ state: "refused", reason: "new_reason" }), 1);
  assert.equal(odd.state.reason, "other");
});

test("410 expires a pending code; so does its time running out with no answer", () => {
  assert.deepEqual(afterPoll(pending, { status: 410, body: { code: "expired" } }, 1).state, { phase: "expired", name: "Helper" });
  assert.deepEqual(afterPoll(pending, null, 600_001).state, { phase: "expired", name: "Helper" });
  assert.deepEqual(afterPoll(pending, { status: 502, body: null }, 600_001).state, { phase: "expired", name: "Helper" });
  assert.deepEqual(afterPoll(pending, { status: 401, body: { code: "unpaired" } }, 1).state, { phase: "expired", name: "Helper" });
});

test("a paired poll hands out calls and cancelled ids", () => {
  const out = afterPoll(
    paired,
    ok({
      state: "paired",
      agent: { name: "helper", label: "Renamed" },
      calls: [{ id: "c1", op: "browser_tabs", args: {} }, { id: "c2", op: "ping" }, { op: "no id" }, null],
      cancelled: ["c0"],
    }),
    1,
  );
  assert.equal(out.state.agent.label, "Renamed");
  assert.equal(out.state.secret, "sek");
  assert.deepEqual(out.calls, [
    { id: "c1", op: "browser_tabs", args: {} },
    { id: "c2", op: "ping", args: {} },
  ]);
  assert.deepEqual(out.cancelled, ["c0"]);
  assert.equal(out.failed, false);
});

test("401 forgets a pairing", () => {
  const out = afterPoll(paired, { status: 401, body: { code: "unpaired" } }, 1);
  assert.deepEqual(out.state, { phase: "unpaired", notice: "unpaired" });
  assert.equal(polls(out.state), false);
});

test("no answer, or a server error, backs off and keeps the pairing", () => {
  for (const answer of [null, { status: 500, body: null }, { status: 200, body: null }, ok({ state: "what" })]) {
    const out = afterPoll(paired, answer, 1);
    assert.equal(out.failed, true);
    assert.deepEqual(out.state, paired);
  }
  assert.equal(afterPoll(pending, null, 1).failed, true);
});

test("a state with no link is left alone", () => {
  assert.deepEqual(afterPoll(UNPAIRED, ok({ state: "paired" }), 1).state, UNPAIRED);
  assert.equal(polls(UNPAIRED), false);
  assert.equal(polls(pending), true);
  assert.equal(polls(paired), true);
  assert.equal(polls({ phase: "refused" }), false);
  assert.equal(polls(null), false);
});

test("backoff is 2 s, 5 s, 15 s, then 30 s", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 50].map(backoff), [2000, 5000, 15000, 30000, 30000, 30000]);
  assert.equal(backoff(0), 2000);
  assert.deepEqual(BACKOFF_MS, [2000, 5000, 15000, 30000]);
});

test("a page never sees the secret", () => {
  assert.deepEqual(publicState(pending, 0), { phase: "pending", name: "Helper", code: "ABCD-EFGH", expiresIn: 600 });
  assert.equal(publicState(pending, 700_000).expiresIn, 0);
  assert.deepEqual(publicState(paired, 0), { phase: "paired", agent: { name: "helper", label: "Helper" } });
  assert.deepEqual(publicState({ phase: "refused", name: "n", reason: "reserved", message: "m" }, 0), {
    phase: "refused",
    name: "n",
    reason: "reserved",
    message: "m",
  });
  assert.deepEqual(publicState({ phase: "expired", name: "n" }, 0), { phase: "expired", name: "n" });
  assert.deepEqual(publicState(null, 0), { phase: "unpaired" });
  assert.deepEqual(publicState({ phase: "unpaired", notice: "unpaired" }, 0), { phase: "unpaired", notice: "unpaired" });
  for (const s of [pending, paired]) assert.equal(JSON.stringify(publicState(s, 0)).includes("sek"), false);
});

test("missing inputs read as nothing, not as errors", () => {
  assert.equal(checkName(undefined), null);
  assert.equal(browserName(undefined), "Chrome");
  assert.deepEqual(JSON.parse(resultBody({ ok: false })), { ok: false, error: "The operation failed." });
  assert.deepEqual(JSON.parse(resultBody(undefined)), { ok: false, error: "The operation failed." });
  // A code with no lifetime is good for ten minutes.
  assert.equal(started("Helper", "s", { id: "x", code: "ABCDEFGH" }, 0).expiresAt, 600_000);
});

test("a paired answer with odd parts keeps what it can", () => {
  const bare = afterPoll(paired, ok({ state: "paired", calls: "none", cancelled: "c1" }), 1);
  assert.deepEqual(bare.state.agent, { name: "", label: "" });
  assert.deepEqual([bare.calls, bare.cancelled, bare.failed], [[], [], false]);
  const named = afterPoll(paired, ok({ state: "paired", agent: { name: "helper" }, cancelled: [7] }), 1);
  assert.deepEqual(named.state.agent, { name: "helper", label: "helper" }); // no label: the name
  assert.deepEqual(named.cancelled, ["7"]);
});

test("a pending answer changes only a pending state, and only with a lifetime", () => {
  assert.deepEqual(afterPoll(paired, ok({ state: "pending", expires_in: 100 }), 1), {
    state: paired,
    calls: [],
    cancelled: [],
    failed: false,
  });
  assert.deepEqual(afterPoll(pending, ok({ state: "pending" }), 1).state, pending);
  assert.equal(afterPoll(pending, ok({ state: "pending", expires_in: -5 }), 9).state.expiresAt, 9);
});

test("410 or a refusal of a link with no name leaves the name empty", () => {
  assert.deepEqual(afterPoll(paired, { status: 410, body: null }, 1).state, { phase: "expired", name: "" });
  assert.deepEqual(afterPoll(paired, ok({ state: "refused", reason: "too_many" }), 1).state, {
    phase: "refused",
    name: "",
    reason: "too_many",
    message: "",
  });
});
