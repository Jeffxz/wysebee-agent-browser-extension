// What the side panel and the approval window share: asking the worker, the
// translations (locales/<code>.json, read as the worker reads them) and the list of
// requests waiting for the person.

import { format, lookup, resolveLanguage } from "../lang.js";
import { BOOKMARKS_ORIGIN } from "../policy.js";

/** Ask the service worker; null when it does not answer. */
export async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    return null;
  }
}

/** The languages offered, each in its own name: never translated. */
export const LANGUAGE_NAMES = [
  { code: "en", name: "English" },
  { code: "fr", name: "Français" },
  { code: "ja", name: "日本語" },
  { code: "zh-CN", name: "简体中文" },
  { code: "zh-TW", name: "繁體中文" },
];

const tables = new Map();

async function table(code) {
  if (!tables.has(code)) {
    try {
      const res = await fetch(chrome.runtime.getURL(`locales/${code}.json`));
      tables.set(code, res.ok ? await res.json() : {});
    } catch {
      tables.set(code, {});
    }
  }
  return tables.get(code);
}

let current = {};
let english = {};
let currentCode = "";

/** Load `code`'s messages (English is the fallback). True when the language changed. */
export async function useLanguage(code) {
  if (code === currentCode) return false;
  [current, english] = await Promise.all([table(code), table("en")]);
  currentCode = code;
  document.documentElement.lang = code;
  return true;
}

/**
 * Load the browser's language when none is loaded yet — before the worker has said which
 * (it may not answer at all), so even "not answering" is said in words, not as a key.
 */
export async function useBrowserLanguage() {
  if (!currentCode) await useLanguage(resolveLanguage("", navigator.languages));
}

/** The themes offered: "" follows the computer's look. */
export const THEMES = ["", "light", "dark"];

/** Show the page in `theme` ("light" or "dark"), or by the computer's look for anything else. */
export function useTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  else delete root.dataset.theme;
}

/** One message in the page's language. */
export function t(key, vars) {
  return format(lookup(current, key, english), vars);
}

/** A small element builder: props are attributes, `on*` listeners, `text`, `class`. */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (name === "text") node.textContent = value;
    else if (name === "class") node.className = value;
    else if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
    else if (name === "checked" || name === "disabled" || name === "value" || name === "selected") node[name] = value;
    else node.setAttribute(name, value === true ? "" : String(value));
  }
  // Appended, not filled: a `text` prop is already in the node and must stay.
  node.append(...nodesOf(children));
  return node;
}

/**
 * A small icon button that copies `text` to the clipboard. Once copied its icon turns to a
 * check and its label to `copiedLabel` for `ms`, then back. A copy the browser refuses
 * changes nothing. The icons are style.css's (.icon-btn.copy, .copied).
 */
export function copyButton(text, label, copiedLabel, ms = 1500) {
  let timer = 0;
  const show = (copied) => {
    button.className = copied ? "icon-btn copy copied" : "icon-btn copy";
    button.setAttribute("aria-label", copied ? copiedLabel : label);
    button.setAttribute("title", copied ? copiedLabel : label);
  };
  const button = el("button", {
    type: "button",
    class: "icon-btn copy",
    "aria-label": label,
    title: label,
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        return;
      }
      show(true);
      clearTimeout(timer);
      timer = setTimeout(() => show(false), ms);
    },
  });
  return button;
}

/**
 * The children a part is drawn with: nodes, text, nested lists, and null or false for
 * "nothing here". Always this, never the DOM's own replaceChildren, which shows a null
 * as the text "null".
 */
export function children(...list) {
  return list.flat(Infinity).filter((c) => c != null && c !== false);
}

/** Replace `node`'s children with these (see children()). */
export function fill(node, ...list) {
  node.replaceChildren(...nodesOf(list));
}

function nodesOf(list) {
  return children(...list).map((c) => (c instanceof Node ? c : document.createTextNode(String(c))));
}

/**
 * What a person typed as a site, as a URL the worker can take the origin of:
 * "localhost:3000" is http, "example.com" https; null for anything but http(s).
 */
export function toSiteUrl(typed) {
  const text = String(typed ?? "").trim();
  if (!text) return null;
  let candidate = text;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const host = text.split(/[/:]/)[0].toLowerCase();
    const local = host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost");
    candidate = `${local ? "http" : "https"}://${text}`;
  }
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The requests waiting for the person, each with Allow once, Always allow (only where
 * policy offers it: never for closing a tab, never for bookmarks) and Deny.
 */
export function approvalList(approvals, onAnswer) {
  return approvals.map((a) =>
    el(
      "div",
      { class: "approval" },
      el("p", { class: "approval-summary", text: a.summary }),
      el("p", { class: "muted small", text: a.origin === BOOKMARKS_ORIGIN ? t("approval.bookmarksOrigin") : a.origin }),
      el(
        "div",
        { class: "row" },
        el("button", { class: "btn primary", text: t("approval.allowOnce"), onclick: () => onAnswer(a.id, "once") }),
        a.trustable &&
          el("button", {
            class: "btn",
            text: t("approval.alwaysAllow"),
            title: t("approval.alwaysAllowTitle", { origin: a.origin }),
            onclick: () => onAnswer(a.id, "always"),
          }),
        el("button", { class: "btn danger", text: t("approval.deny"), onclick: () => onAnswer(a.id, "deny") }),
      ),
    ),
  );
}
