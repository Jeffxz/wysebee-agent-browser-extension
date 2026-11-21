// Which language the extension's pages and prompts are in, and filling in a message.
//
// Pure, like policy.js, so `node --test` covers it. By default the language follows
// Wysebee Desktop's own setting (Settings → System), which the desktop sends with
// `configure` whenever it connects or the setting changes; "" there means "follow the
// computer", and then the browser's own languages decide, by the same rule as the
// desktop's resolveLanguage (ui/desktop/src/i18n/index.ts) — keep the two alike.
//
// The person can override that in the extension's settings (`languageOverride`, kept in
// this browser): a language chosen there wins over whatever the desktop sends, and ""
// goes back to following the desktop.
//
// The messages themselves are in locales/<code>.json, read by the service worker and
// the pages. Only what a *person* reads is translated: refusals returned to
// an agent stay in English, as the desktop's server messages do.

export const LANGUAGES = ["en", "fr", "ja", "zh-CN", "zh-TW"];

/** The language to show for a stored setting, given the browser's preferences. */
export function resolveLanguage(setting, preferred = []) {
  if (LANGUAGES.includes(setting)) return setting;
  for (const raw of preferred) {
    const tag = String(raw || "").toLowerCase();
    if (tag.startsWith("zh")) return /hant|-tw|-hk|-mo/.test(tag) ? "zh-TW" : "zh-CN";
    const base = tag.split("-")[0];
    if (LANGUAGES.includes(base)) return base;
  }
  return "en";
}

/** The language to show: the extension's own choice if it made one, else the desktop's. */
export function chooseLanguage(override, desktop, preferred = []) {
  return LANGUAGES.includes(override) ? override : resolveLanguage(desktop, preferred);
}

/** A dotted key's message in `table`, else in `fallback`, else the key itself. */
export function lookup(table, key, fallback = {}) {
  const find = (t) => key.split(".").reduce((node, part) => (node && typeof node === "object" ? node[part] : undefined), t);
  const hit = find(table);
  if (typeof hit === "string") return hit;
  const back = find(fallback);
  return typeof back === "string" ? back : key;
}

/** `{{name}}` placeholders filled from `vars`; one with no value is left empty. */
export function format(template, vars = {}) {
  return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => (vars[name] == null ? "" : String(vars[name])));
}
