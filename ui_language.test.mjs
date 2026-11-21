// ui/shared.js before the worker has named a language: the browser's is used, so even
// "the worker is not answering" is said in words, not as a key. Its own process, so no
// language is loaded yet when it starts.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

globalThis.document = { documentElement: {} };
globalThis.chrome = { runtime: { getURL: (rel) => `chrome-extension://abc/${rel}` } };
globalThis.fetch = async (url) => {
  const file = new URL(`./${url.replace("chrome-extension://abc/", "")}`, import.meta.url);
  return { ok: true, json: async () => JSON.parse(fs.readFileSync(file, "utf8")) };
};
Object.defineProperty(globalThis, "navigator", { value: { languages: ["fr-FR", "en"] }, configurable: true });

const { t, useBrowserLanguage, useLanguage } = await import("./ui/shared.js");
const fr = JSON.parse(fs.readFileSync(new URL("./locales/fr.json", import.meta.url), "utf8"));
const ja = JSON.parse(fs.readFileSync(new URL("./locales/ja.json", import.meta.url), "utf8"));

test("with no language loaded yet, the browser's is; after, it is not replaced", async () => {
  assert.equal(t("common.workerDown"), "common.workerDown");
  await useBrowserLanguage();
  assert.equal(t("common.workerDown"), fr.common.workerDown);
  assert.equal(document.documentElement.lang, "fr");
  await useLanguage("ja");
  await useBrowserLanguage();
  assert.equal(t("common.workerDown"), ja.common.workerDown);
});
