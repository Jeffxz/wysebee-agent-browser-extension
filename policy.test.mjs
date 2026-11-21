// Run with: node --test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { format } from "./lang.js";

// Prompts are rendered from the extension UI's English locale, the one source of the text.
const EN = JSON.parse(
  fs.readFileSync(new URL("./locales/en.json", import.meta.url), "utf8"),
).approval.summary;
const describe = (op, origin, args) => {
  const { key, vars } = summary(op, origin, args);
  assert.ok(key in EN, `no English for ${key}`);
  return format(EN[key], vars);
};
import {
  BLOCKABLE,
  BOOKMARKS_ORIGIN,
  DEVTOOLS_OPS,
  NATIVE_INPUT,
  OPS,
  SITE_MODES,
  decide,
  fromOwnPage,
  summary,
  isBlocked,
  isTrusted,
  originOf,
  OFF_BY_DEFAULT,
  effectiveBlocked,
  splitBlocked,
} from "./policy.js";

const base = { sites: { "https://ok.example": "auto" } };

test("only this extension's own pages may ask the worker, the approval window's tab and all", () => {
  const base = "chrome-extension://me/";
  assert.equal(fromOwnPage({ id: "me", url: "chrome-extension://me/ui/sidepanel.html" }, "me", base), true);
  // The approval window is a popup window: its page has a tab, and is ours all the same.
  assert.equal(fromOwnPage({ id: "me", url: "chrome-extension://me/ui/approval.html", tab: { id: 7 } }, "me", base), true);
  // A content script carries our id but runs on a web page's address.
  assert.equal(fromOwnPage({ id: "me", url: "https://evil.example/", tab: { id: 8 } }, "me", base), false);
  assert.equal(fromOwnPage({ id: "other", url: "chrome-extension://other/x.html" }, "me", base), false);
  assert.equal(fromOwnPage({ id: "me" }, "me", base), false);
  assert.equal(fromOwnPage(undefined, "me", base), false);
});

test("originOf accepts only http(s)", () => {
  assert.equal(originOf("https://a.example/x?y=1"), "https://a.example");
  assert.equal(originOf("http://localhost:3000/a"), "http://localhost:3000");
  for (const bad of ["chrome://settings", "file:///etc/passwd", "about:blank", "javascript:1", "nope", "", undefined]) {
    assert.equal(originOf(bad), null, String(bad));
  }
});

test("there is no kill switch any more: a stale paused flag changes nothing", () => {
  // "Let Wysebee use this browser" was removed (2026-11-12); a browser paused before
  // then must not be left refusing everything with no switch to turn it back on.
  for (const op of ["browser_tabs", "browser_snapshot", "browser_click"]) {
    const d = decide({ op, tabOrigin: "https://ok.example", ...base, paused: true });
    assert.equal(d.verdict, "allow", op);
  }
});

test("listing tabs needs no approval", () => {
  assert.equal(decide({ op: "browser_tabs", tabOrigin: null, ...base }).verdict, "allow");
});

test("unknown operations are refused", () => {
  assert.equal(decide({ op: "rm_rf", tabOrigin: "https://ok.example", ...base }).verdict, "deny");
});

test("uncontrollable pages are refused outright, not asked about", () => {
  const d = decide({ op: "browser_snapshot", tabOrigin: null, ...base });
  assert.equal(d.verdict, "deny");
});

test("trusted sites run; everything else asks, reads included", () => {
  assert.equal(decide({ op: "browser_click", tabOrigin: "https://ok.example", ...base }).verdict, "allow");
  for (const op of ["browser_snapshot", "browser_screenshot", "browser_click", "browser_type", "browser_activate"]) {
    const d = decide({ op, tabOrigin: "https://other.example", ...base });
    assert.deepEqual([d.verdict, d.origin], ["ask", "https://other.example"], op);
  }
});

test("navigation is judged by its destination, not the tab it starts from", () => {
  const fromTrusted = decide({
    op: "browser_navigate", tabOrigin: "https://ok.example", destOrigin: "https://evil.example", ...base,
  });
  assert.deepEqual([fromTrusted.verdict, fromTrusted.origin], ["ask", "https://evil.example"]);
  const toTrusted = decide({
    op: "browser_navigate", tabOrigin: "https://other.example", destOrigin: "https://ok.example", ...base,
  });
  assert.equal(toTrusted.verdict, "allow");
  const fromNewTab = decide({ op: "browser_navigate", tabOrigin: null, destOrigin: "https://ok.example", ...base });
  assert.equal(fromNewTab.verdict, "allow");
  const badScheme = decide({ op: "browser_navigate", tabOrigin: "https://ok.example", destOrigin: null, ...base });
  assert.equal(badScheme.verdict, "deny");
});

test("only the exact strings 'auto' and 'full' trust a site", () => {
  for (const mode of ["ask", "AUTO", "FULL", true, 1, ""]) {
    const d = decide({ op: "browser_click", tabOrigin: "https://x.example", sites: { "https://x.example": mode } });
    assert.equal(d.verdict, "ask");
  }
});

test("prompts say what is about to happen", () => {
  assert.match(describe("browser_navigate", "https://a", { url: "https://a/x" }), /Open https:\/\/a\/x/);
  assert.match(describe("browser_click", "https://a", {}), /Click/);
  assert.match(describe("browser_type", "https://a", {}), /Type/);
  assert.match(describe("browser_screenshot", "https://a", {}), /screenshot/);
  assert.match(describe("browser_activate", "https://a", {}), /Switch/);
  assert.match(describe("browser_snapshot", "https://a", {}), /Read/);
});

test("opening a tab is judged by where it goes, like navigation", () => {
  assert.equal(decide({ op: "browser_open_tab", tabOrigin: null, destOrigin: "https://ok.example", ...base }).verdict, "allow");
  const elsewhere = decide({ op: "browser_open_tab", tabOrigin: null, destOrigin: "https://other.example", ...base });
  assert.deepEqual([elsewhere.verdict, elsewhere.origin], ["ask", "https://other.example"]);
  assert.equal(decide({ op: "browser_open_tab", tabOrigin: null, destOrigin: null, ...base }).verdict, "deny");
});

test("closing your tab always asks, even on a trusted site, and never offers 'always'", () => {
  for (const tabOrigin of ["https://ok.example", "https://other.example"]) {
    const d = decide({ op: "browser_close_tab", tabOrigin, ...base });
    assert.deepEqual([d.verdict, d.origin, d.trustable], ["ask", tabOrigin, false], tabOrigin);
  }
  // a tab you opened on a page the probe cannot control is not its to close
  assert.equal(decide({ op: "browser_close_tab", tabOrigin: null, ...base }).verdict, "deny");
});

test("a tab the probe opened itself closes without asking", () => {
  const ours = { op: "browser_close_tab", tabOrigin: "https://other.example", openedByProbe: true };
  assert.equal(decide({ ...ours, ...base }).verdict, "allow");
  assert.equal(decide({ ...ours, tabOrigin: null, ...base }).verdict, "allow");
  // the flag means nothing for any other operation
  const click = decide({ op: "browser_click", tabOrigin: "https://other.example", openedByProbe: true, ...base });
  assert.equal(click.verdict, "ask");
});

test("open and close prompts say what is about to happen", () => {
  assert.match(describe("browser_open_tab", "https://a", { url: "https://a/x" }), /new tab/);
  assert.match(describe("browser_close_tab", "https://a", { title: "Inbox" }), /Close the tab .Inbox. on https:\/\/a/);
  assert.match(describe("browser_close_tab", "https://a", {}), /Close a tab on https:\/\/a/);
});

test("scrolling and dragging are page actions: trusted runs, everything else asks", () => {
  for (const op of ["browser_scroll", "browser_drag"]) {
    assert.equal(decide({ op, tabOrigin: "https://ok.example", ...base }).verdict, "allow", op);
    const d = decide({ op, tabOrigin: "https://other.example", ...base });
    assert.deepEqual([d.verdict, d.origin], ["ask", "https://other.example"], op);
    assert.equal(decide({ op, tabOrigin: null, ...base }).verdict, "deny", op);
  }
  assert.match(describe("browser_scroll", "https://a", {}), /Scroll/);
  assert.match(describe("browser_drag", "https://a", {}), /Drag/);
});

test("one approved mouse action covers the rest of the gesture, and nothing else", () => {
  const other = { op: "browser_mouse", tabOrigin: "https://other.example", ...base };
  assert.equal(decide(other).verdict, "ask");
  assert.equal(decide({ ...other, gestureGranted: true }).verdict, "allow");
  // the grant is for the mouse only
  assert.equal(decide({ ...other, op: "browser_click", gestureGranted: true }).verdict, "ask");
  // a page the probe may not touch is still refused
  assert.equal(decide({ ...other, tabOrigin: null, gestureGranted: true }).verdict, "deny");
  // trusted sites never asked in the first place
  assert.equal(decide({ ...other, tabOrigin: "https://ok.example" }).verdict, "allow");
  assert.match(describe("browser_mouse", "https://a", {}), /mouse/);
});

test("reading bookmarks always asks and offers no 'always'", () => {
  const d = decide({ op: "browser_bookmarks", tabOrigin: null, ...base });
  assert.deepEqual([d.verdict, d.origin, d.trustable], ["ask", BOOKMARKS_ORIGIN, false]);
  // no trusted site, however broad, covers it
  const trustAll = decide({ op: "browser_bookmarks", tabOrigin: "https://ok.example", ...base });
  assert.equal(trustAll.verdict, "ask");
  assert.match(describe("browser_bookmarks", BOOKMARKS_ORIGIN, {}), /Read your bookmarks/);
  assert.match(describe("browser_bookmarks", BOOKMARKS_ORIGIN, { query: "python" }), /Search your bookmarks for .python./);
});

test("a prompt for real mouse input says so", () => {
  assert.match(describe("browser_mouse", "https://a", { native: true }), /real input/);
  assert.doesNotMatch(describe("browser_mouse", "https://a", {}), /real input/);
});

test("a blocked kind of request is refused everywhere, trusted sites included", () => {
  const trusted = { op: "browser_click", tabOrigin: "https://ok.example", ...base };
  assert.equal(decide(trusted).verdict, "allow");
  const d = decide({ ...trusted, blocked: ["browser_click"] });
  assert.equal(d.verdict, "deny");
  assert.match(d.reason, /blocked this kind of request/);
  // other kinds are untouched
  assert.equal(decide({ ...trusted, op: "browser_type", blocked: ["browser_click"] }).verdict, "allow");
  // a Set works as well as an array
  assert.equal(decide({ ...trusted, blocked: new Set(["browser_click"]) }).verdict, "deny");
});

test("blocking beats every other allow: listing tabs, gestures, probe-opened tabs", () => {
  assert.equal(decide({ op: "browser_tabs", tabOrigin: null, ...base, blocked: ["browser_tabs"] }).verdict, "deny");
  const mouse = { op: "browser_mouse", tabOrigin: "https://x.example", ...base, gestureGranted: true };
  assert.equal(decide({ ...mouse, blocked: ["browser_mouse"] }).verdict, "deny");
  const close = { op: "browser_close_tab", tabOrigin: "https://x.example", ...base, openedByProbe: true };
  assert.equal(decide(close).verdict, "allow");
  assert.equal(decide({ ...close, blocked: ["browser_close_tab"] }).verdict, "deny");
  // asked-about requests are refused rather than asked about
  assert.equal(decide({ op: "browser_bookmarks", tabOrigin: null, ...base, blocked: ["browser_bookmarks"] }).verdict, "deny");
});

test("real mouse input can be blocked without blocking the simulated mouse", () => {
  const mouse = { op: "browser_mouse", tabOrigin: "https://ok.example", ...base, blocked: [NATIVE_INPUT] };
  assert.equal(decide(mouse).verdict, "allow");
  assert.equal(decide({ ...mouse, native: true }).verdict, "deny");
  // the flag means nothing for any other operation
  assert.equal(decide({ ...mouse, op: "browser_click", native: true }).verdict, "allow");
  assert.equal(isBlocked("browser_mouse", true, [NATIVE_INPUT]), true);
  assert.equal(isBlocked("browser_mouse", false, [NATIVE_INPUT]), false);
  assert.equal(isBlocked("browser_click", false, undefined), false);
});

test("a blocked kind of request comes first, with its own reason", () => {
  const d = decide({ op: "browser_click", tabOrigin: "https://ok.example", ...base, blocked: ["browser_click"] });
  assert.match(d.reason, /blocked this kind of request/);
});

test("every operation, and real input, can be blocked", () => {
  for (const op of OPS) assert.ok(BLOCKABLE.has(op), op);
  assert.ok(BLOCKABLE.has(NATIVE_INPUT));
  assert.equal(BLOCKABLE.size, OPS.size + 1);
});

test("an 'allow everything' site also closes tabs without asking", () => {
  const sites = { "https://app.test": "full", "https://ok.example": "auto" };
  const close = { op: "browser_close_tab", sites };
  assert.deepEqual(decide({ ...close, tabOrigin: "https://app.test" }), { verdict: "allow", origin: "https://app.test" });
  // plain trust still asks, with no "always"
  const plain = decide({ ...close, tabOrigin: "https://ok.example" });
  assert.deepEqual([plain.verdict, plain.trustable], ["ask", false]);
  // every ordinary operation runs, like a trusted site
  for (const op of ["browser_click", "browser_type", "browser_snapshot", "browser_screenshot", "browser_mouse"]) {
    assert.equal(decide({ op, tabOrigin: "https://app.test", sites }).verdict, "allow", op);
  }
  assert.equal(
    decide({ op: "browser_navigate", tabOrigin: "https://x.example", destOrigin: "https://app.test", sites }).verdict,
    "allow",
  );
});

test("'allow everything' does not get round a block, or bookmarks", () => {
  const sites = { "https://app.test": "full" };
  const at = { tabOrigin: "https://app.test", sites };
  assert.equal(decide({ ...at, op: "browser_close_tab", blocked: ["browser_close_tab"] }).verdict, "deny");
  assert.equal(decide({ ...at, op: "browser_mouse", native: true, blocked: [NATIVE_INPUT] }).verdict, "deny");
  assert.equal(decide({ ...at, op: "browser_bookmarks" }).verdict, "ask");
  // and leaving the site for one that is not trusted still asks
  assert.equal(decide({ ...at, op: "browser_navigate", destOrigin: "https://other.example" }).verdict, "ask");
});

test("site levels", () => {
  assert.deepEqual(SITE_MODES, ["auto", "full"]);
  assert.equal(isTrusted("auto"), true);
  assert.equal(isTrusted("full"), true);
  assert.equal(isTrusted("ask"), false);
  assert.equal(isTrusted(undefined), false);
});

test("bookmarks are allowed only by their own switch, never by a site's level", () => {
  const read = { op: "browser_bookmarks", tabOrigin: null, sites: {} };

  // Off by default, and no "always" on the prompt: there is no site to attach one to.
  const asked = decide(read);
  assert.equal(asked.verdict, "ask");
  assert.equal(asked.trustable, false);

  assert.equal(decide({ ...read, bookmarksAllowed: true }).verdict, "allow");

  // **The escalation this shape exists to prevent.** A site at "allow everything"
  // must not reach them, or navigating to any fully-trusted page would hand over
  // every bookmark URL you have.
  assert.equal(
    decide({
      ...read,
      tabOrigin: "https://app.example",
      sites: { "https://app.example": "full" },
    }).verdict,
    "ask",
  );

  // The switch is below a block.
  assert.equal(
    decide({ ...read, bookmarksAllowed: true, blocked: ["browser_bookmarks"] }).verdict,
    "deny",
  );
});

test("the developer tools are page operations: trusted runs, elsewhere asks, never on chrome://", () => {
  for (const op of [...DEVTOOLS_OPS].filter((o) => o !== "browser_mock")) {
    assert.ok(OPS.has(op), op);
    assert.equal(decide({ op, tabOrigin: "https://ok.example", ...base }).verdict, "allow", op);
    const d = decide({ op, tabOrigin: "https://other.example", ...base });
    assert.deepEqual([d.verdict, d.origin, d.trustable], ["ask", "https://other.example", undefined], op);
    assert.equal(decide({ op, tabOrigin: null, ...base }).verdict, "deny", op);
    assert.equal(decide({ op, tabOrigin: "https://ok.example", ...base, blocked: [op] }).verdict, "deny", op);
  }
});

test("faking responses runs unasked only where everything is allowed, and never offers always", () => {
  const sites = { "https://ok.example": "auto", "http://localhost:3000": "full" };
  const op = "browser_mock";
  assert.ok(DEVTOOLS_OPS.has(op) && OPS.has(op));
  assert.equal(decide({ op, tabOrigin: "http://localhost:3000", sites }).verdict, "allow");
  for (const tabOrigin of ["https://ok.example", "https://other.example"]) {
    const d = decide({ op, tabOrigin, sites });
    assert.deepEqual([d.verdict, d.origin, d.trustable], ["ask", tabOrigin, false]);
  }
  assert.equal(decide({ op, tabOrigin: null, sites }).verdict, "deny");
  assert.equal(decide({ op, tabOrigin: "http://localhost:3000", sites, blocked: [op] }).verdict, "deny");
});

test("the fake-response prompt lists the rules", () => {
  const o = "https://a.example";
  const rules = [{ url: "*/api/*", status: 500 }];
  assert.equal(describe("browser_mock", o, { rules }), "Fake network responses on https://a.example: */api/* → 500");
  assert.equal(
    describe("browser_mock", o, { rules, clear: true }),
    "Replace the fake network responses on https://a.example with: */api/* → 500",
  );
  assert.equal(describe("browser_mock", o, { clear: true }), "Stop faking network responses on https://a.example");
});

test("developer-tool prompts say what is about to happen, script included", () => {
  const o = "https://a.example";
  assert.equal(describe("browser_console", o, {}), "Read the console on https://a.example");
  assert.equal(describe("browser_network", o, {}), "Read network activity on https://a.example");
  assert.equal(describe("browser_network_body", o, {}), "Read network activity on https://a.example");
  assert.equal(
    describe("browser_evaluate", o, { expression: "document\n   .title" }),
    "Run JavaScript on https://a.example: document .title",
  );
  const long = describe("browser_evaluate", o, { expression: "x".repeat(400) });
  assert.ok(long.endsWith("…") && long.length < 220);
  assert.equal(describe("browser_evaluate", o, {}), "Run JavaScript on https://a.example: ");
  assert.equal(describe("browser_viewport", o, {}), "Change the window size on https://a.example");
  assert.equal(describe("browser_viewport", o, { reset: true }), "Restore the window size on https://a.example");
  assert.equal(describe("browser_inspect", o, {}), "Inspect an element on https://a.example");
  assert.equal(describe("browser_audit", o, {}), "Audit the page on https://a.example");
  assert.equal(describe("browser_performance", o, {}), "Measure performance on https://a.example");
  assert.equal(describe("browser_reload", o, {}), "Reload the page on https://a.example");
});

test("with no sites stored yet, every site asks", () => {
  const d = decide({ op: "browser_click", tabOrigin: "https://x.example" });
  assert.deepEqual([d.verdict, d.origin], ["ask", "https://x.example"]);
});

test("recording and faking responses are blocked until turned on, old saved lists included", () => {
  assert.deepEqual([...OFF_BY_DEFAULT].sort(), ["browser_mock", "browser_record"]);
  for (const op of OFF_BY_DEFAULT) assert.ok(BLOCKABLE.has(op), op);
  // Nothing stored yet, or a list saved before these kinds existed: both off.
  assert.deepEqual(effectiveBlocked(undefined, undefined), ["browser_mock", "browser_record"]);
  assert.deepEqual(effectiveBlocked(["browser_click"], []), ["browser_click", "browser_mock", "browser_record"]);
  // Turned on: off the list.
  assert.deepEqual(effectiveBlocked(["browser_click"], ["browser_record"]), ["browser_click", "browser_mock"]);
  assert.deepEqual(effectiveBlocked([], ["browser_record", "browser_mock"]), []);
});

test("the panel's blocked list is stored as blocked kinds plus off-by-default kinds turned on", () => {
  assert.deepEqual(splitBlocked(["browser_click", "browser_mock"]), {
    blocked: ["browser_click"],
    allowedKinds: ["browser_record"],
  });
  assert.deepEqual(splitBlocked(["browser_mock", "browser_record"]), { blocked: [], allowedKinds: [] });
  // Round trip: what is stored gives back what the panel sent.
  const sent = ["browser_bookmarks", "browser_record"];
  const { blocked, allowedKinds } = splitBlocked(sent);
  assert.deepEqual(effectiveBlocked(blocked, allowedKinds), sent);
});
