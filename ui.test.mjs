// The pages' shared helpers (ui/shared.js): asking the worker, the translations, the
// element builder, typed sites and the approval list. "Nothing here" (null, false) is
// never drawn, in particular never as the text "null".
//
// No browser: a small fake DOM and a fake chrome.runtime, with the locale files read
// from this repository as the extension would fetch them.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

class FakeNode {
  constructor(text = "") {
    this.text = text;
    this.kids = [];
  }
  replaceChildren(...kids) {
    this.kids = kids.map((k) => (k instanceof FakeNode ? k : new FakeNode(String(k))));
  }
}

class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tag = tag;
    this.attrs = {};
    this.listeners = {};
  }
  append(...kids) {
    this.kids.push(...kids);
  }
  set textContent(v) {
    this.kids.push(new FakeNode(String(v)));
  }
  setAttribute(name, value) {
    this.attrs[name] = value;
  }
  addEventListener(type, fn) {
    this.listeners[type] = fn;
  }
  /** Every text below this node, in order. */
  get allText() {
    return this.kids.map((k) => (k instanceof FakeElement ? k.allText : k.text)).join("");
  }
}

globalThis.Node = FakeNode;
globalThis.document = {
  documentElement: { dataset: {} },
  createTextNode: (text) => new FakeNode(text),
  createElement: (tag) => new FakeElement(tag),
};

// The worker, and the extension's files.
const messages = [];
let worker = async (message) => ({ echo: message });
const fetched = [];
globalThis.chrome = {
  runtime: {
    sendMessage: (message) => {
      messages.push(message);
      return worker(message);
    },
    getURL: (rel) => `chrome-extension://abc/${rel}`,
  },
};
globalThis.fetch = async (url) => {
  fetched.push(url);
  const rel = url.replace("chrome-extension://abc/", "");
  if (rel === "locales/broken.json") throw new Error("the file could not be read");
  const file = new URL(`./${rel}`, import.meta.url);
  if (!fs.existsSync(file)) return { ok: false, json: async () => ({}) };
  return { ok: true, json: async () => JSON.parse(fs.readFileSync(file, "utf8")) };
};

const { BOOKMARKS_ORIGIN } = await import("./policy.js");
const { LANGUAGE_NAMES, THEMES, approvalList, children, copyButton, el, fill, send, t, toSiteUrl, useLanguage, useTheme } = await import("./ui/shared.js");
const en = JSON.parse(fs.readFileSync(new URL("./locales/en.json", import.meta.url), "utf8"));
const fr = JSON.parse(fs.readFileSync(new URL("./locales/fr.json", import.meta.url), "utf8"));
const withOrigin = (template, origin) => template.replace(/\{\{\s*origin\s*\}\}/, origin);

test("children() drops null and false, at any depth, and keeps 0 and text", () => {
  const a = new FakeNode("a");
  assert.deepEqual(children(null, a, false, [null, [undefined, "b", false]], 0), [a, "b", 0]);
  assert.deepEqual(children(null, false, [null]), []);
});

test("fill() never draws a null as text", () => {
  const box = new FakeNode();
  const p = new FakeNode("p");
  fill(box, null, p, false, [null, "hi"]);
  assert.deepEqual(box.kids.map((k) => k.text), ["p", "hi"]);
  assert.equal(box.kids[0], p);
  fill(box, null);
  assert.deepEqual(box.kids, []);
});

test("the pages draw only through fill() and el(), never replaceChildren", () => {
  for (const file of ["ui/panel.js", "ui/approval.js"]) {
    const source = fs.readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.ok(!/\.replaceChildren\(/.test(source), `${file} calls replaceChildren`);
  }
});

test("el() keeps its text when it has no children, and draws no null", () => {
  assert.deepEqual(el("button", { text: "Pair" }).kids.map((k) => k.text), ["Pair"]);
  assert.deepEqual(el("p", { text: "A" }, null, "b", false).kids.map((k) => k.text), ["A", "b"]);
  assert.deepEqual(el("p").kids, []);
});

test("el() sets classes, listeners, properties and attributes, and skips null and false", () => {
  let clicked = 0;
  const node = el("input", {
    class: "btn primary",
    onclick: () => clicked++,
    checked: true,
    disabled: true,
    value: "x",
    selected: true,
    hidden: true,
    maxlength: 60,
    title: null,
    placeholder: false,
  });
  assert.equal(node.className, "btn primary");
  node.listeners.click();
  assert.equal(clicked, 1);
  assert.deepEqual([node.checked, node.disabled, node.value, node.selected], [true, true, "x", true]);
  assert.deepEqual(node.attrs, { hidden: "", maxlength: "60" });
});

test("send() answers what the worker said, or null when it does not answer", async () => {
  assert.deepEqual(await send({ type: "get_state" }), { echo: { type: "get_state" } });
  worker = async () => {
    throw new Error("Could not establish connection. Receiving end does not exist.");
  };
  assert.equal(await send({ type: "get_state" }), null);
  assert.deepEqual(messages, [{ type: "get_state" }, { type: "get_state" }]);
});

test("messages come in the chosen language, then English, then the key", async () => {
  assert.equal(t("approval.deny"), "approval.deny"); // nothing loaded yet
  assert.equal(await useLanguage("fr"), true);
  assert.equal(document.documentElement.lang, "fr");
  assert.equal(t("approval.deny"), fr.approval.deny);
  assert.equal(t("approval.alwaysAllowTitle", { origin: "https://a.example" }), withOrigin(fr.approval.alwaysAllowTitle, "https://a.example"));
  assert.equal(t("no.such.key"), "no.such.key");
  assert.deepEqual([...fetched].sort(), ["chrome-extension://abc/locales/en.json", "chrome-extension://abc/locales/fr.json"]);

  // The same language again changes nothing and reads nothing.
  assert.equal(await useLanguage("fr"), false);
  assert.equal(fetched.length, 2);
});

test("a language whose file is missing or unreadable falls back to English, each read once", async () => {
  fetched.length = 0;
  assert.equal(await useLanguage("xx"), true);
  assert.equal(t("approval.deny"), en.approval.deny);
  assert.deepEqual(fetched, ["chrome-extension://abc/locales/xx.json"]); // English is kept
  assert.equal(await useLanguage("broken"), true);
  assert.equal(document.documentElement.lang, "broken");
  assert.equal(t("approval.deny"), en.approval.deny);
  // A language once read is not read again.
  fetched.length = 0;
  await useLanguage("fr");
  assert.equal(t("approval.deny"), fr.approval.deny);
  assert.deepEqual(fetched, []);
  await useLanguage("en");
});

test("a chosen theme is set on the page; anything else follows the computer's look", () => {
  const { dataset } = document.documentElement;
  assert.deepEqual(THEMES, ["", "light", "dark"]);
  useTheme("dark");
  assert.equal(dataset.theme, "dark");
  useTheme("light");
  assert.equal(dataset.theme, "light");
  for (const other of ["", undefined, "sepia"]) {
    useTheme("dark");
    useTheme(other);
    assert.equal("theme" in dataset, false);
  }
  // Every theme offered has its words.
  for (const theme of THEMES) assert.equal(typeof en.settings.theme[theme || "system"], "string");
});

test("the copy button copies the code as shown, shows a check for a moment, then goes back", async () => {
  const copied = [];
  let refuse = false;
  Object.defineProperty(globalThis, "navigator", {
    value: {
      clipboard: {
        writeText: async (text) => {
          if (refuse) throw new Error("Document is not focused.");
          copied.push(text);
        },
      },
    },
    configurable: true,
  });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const button = copyButton("ABCD-EFGH", en.pair.copy, en.pair.copied, 30);
  const look = () => [button.className, button.attrs["aria-label"], button.attrs.title];
  assert.equal(button.tag, "button");
  assert.equal(button.attrs.type, "button"); // never submits a form
  assert.deepEqual(look(), ["icon-btn copy", "Copy pairing code", "Copy pairing code"]);

  await button.listeners.click();
  assert.deepEqual(copied, ["ABCD-EFGH"]);
  assert.deepEqual(look(), ["icon-btn copy copied", en.pair.copied, en.pair.copied]);
  // A second click starts the moment again, rather than ending at the first one's time.
  await wait(20);
  await button.listeners.click();
  await wait(20);
  assert.deepEqual(look(), ["icon-btn copy copied", en.pair.copied, en.pair.copied]);
  await wait(30);
  assert.deepEqual(look(), ["icon-btn copy", en.pair.copy, en.pair.copy]);

  // A copy the browser refuses shows no check.
  refuse = true;
  await button.listeners.click();
  assert.deepEqual(look(), ["icon-btn copy", en.pair.copy, en.pair.copy]);
  assert.deepEqual(copied, ["ABCD-EFGH", "ABCD-EFGH"]);
});

test("every language offered is named in itself", () => {
  assert.deepEqual(LANGUAGE_NAMES.map((l) => l.code), ["en", "fr", "ja", "zh-CN", "zh-TW"]);
});

test("a typed site becomes an http(s) origin: local hosts are http, the rest https", () => {
  assert.equal(toSiteUrl("example.com"), "https://example.com");
  assert.equal(toSiteUrl("  Example.com/path?q=1 "), "https://example.com");
  assert.equal(toSiteUrl("localhost:3000"), "http://localhost:3000");
  assert.equal(toSiteUrl("127.0.0.1:8080/x"), "http://127.0.0.1:8080");
  assert.equal(toSiteUrl("app.localhost"), "http://app.localhost");
  assert.equal(toSiteUrl("http://example.com:8080/a"), "http://example.com:8080");
  assert.equal(toSiteUrl("HTTPS://Example.com"), "https://example.com");
  assert.equal(toSiteUrl("ftp://example.com"), null);
  assert.equal(toSiteUrl("chrome-extension://abc/page.html"), null);
  assert.equal(toSiteUrl("exa mple.com"), null);
  assert.equal(toSiteUrl(""), null);
  assert.equal(toSiteUrl("   "), null);
  assert.equal(toSiteUrl(undefined), null);
});

test("the approval list offers Always allow only where policy does, and answers by id", () => {
  const answers = [];
  const [site, close, bookmarks] = approvalList(
    [
      { id: "a1", summary: "Click on a.example", origin: "https://a.example", trustable: true },
      { id: "a2", summary: "Close a tab", origin: "https://a.example", trustable: false },
      { id: "a3", summary: "Read your bookmarks", origin: BOOKMARKS_ORIGIN },
    ],
    (id, decision) => answers.push([id, decision]),
  );
  const buttons = (card) => card.kids[2].kids;

  assert.equal(site.className, "approval");
  assert.equal(site.kids[0].allText, "Click on a.example");
  assert.equal(site.kids[1].allText, "https://a.example");
  assert.deepEqual(buttons(site).map((b) => b.allText), [en.approval.allowOnce, en.approval.alwaysAllow, en.approval.deny]);
  assert.equal(buttons(site)[1].attrs.title, withOrigin(en.approval.alwaysAllowTitle, "https://a.example"));
  for (const b of buttons(site)) b.listeners.click();

  assert.deepEqual(buttons(close).map((b) => b.allText), [en.approval.allowOnce, en.approval.deny]);
  buttons(close)[1].listeners.click();

  assert.equal(bookmarks.kids[1].allText, en.approval.bookmarksOrigin);
  assert.equal(buttons(bookmarks).length, 2);
  buttons(bookmarks)[0].listeners.click();

  assert.deepEqual(answers, [
    ["a1", "once"],
    ["a1", "always"],
    ["a1", "deny"],
    ["a2", "deny"],
    ["a3", "once"],
  ]);
});

test("the approval window shows what waits, redraws only on a change, and answers", async () => {
  const page = { approvals: new FakeElement("div"), title: new FakeElement("h1") };
  document.getElementById = (id) => page[id];
  let state = null;
  const sent = [];
  worker = async (message) => {
    sent.push(message);
    return message.type === "get_state" ? state : { ok: true };
  };
  const timers = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms) => timers.push({ fn, ms });
  try {
    await import("./ui/approval.js");
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const tick = async () => {
    timers[0].fn();
    await settle();
  };
  assert.deepEqual(timers.map((x) => x.ms), [1000]); // asks again every second

  // The worker is not answering (the page is in English, as the tests above left it).
  await settle();
  assert.equal(page.approvals.allText, en.common.workerDown);

  // Nothing waiting, in French.
  state = { language: "fr", approvals: [] };
  await tick();
  assert.equal(page.title.allText, fr.approval.title);
  assert.equal(page.approvals.allText, fr.approval.nothingWaiting);

  // The same state is not drawn again.
  const drawn = page.approvals.kids[0];
  await tick();
  assert.equal(page.approvals.kids[0], drawn);

  // A request: drawn, and answered.
  state = { language: "fr", approvals: [{ id: "a1", summary: "Click", origin: "https://a.example", trustable: false }] };
  await tick();
  const card = page.approvals.kids[0];
  assert.equal(card.className, "approval");
  sent.length = 0;
  state = { language: "fr", approvals: [] };
  card.kids[2].kids[0].listeners.click();
  await settle();
  assert.deepEqual(sent, [{ type: "answer", id: "a1", decision: "once" }, { type: "get_state" }]);
  assert.equal(page.approvals.allText, fr.approval.nothingWaiting);

  // A state with no list is the worker down too; the next good one is drawn again.
  state = { language: "fr" };
  await tick();
  assert.equal(page.approvals.allText, fr.common.workerDown);
  state = { language: "fr", approvals: [] };
  await tick();
  assert.equal(page.approvals.allText, fr.approval.nothingWaiting);
});
