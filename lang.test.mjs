// Run with: node --test apps/browser_probe/extension/
import test from "node:test";
import assert from "node:assert/strict";
import { LANGUAGES, chooseLanguage, format, lookup, resolveLanguage } from "./lang.js";

test("the desktop's choice wins; '' follows the browser, by the desktop's rule", () => {
  assert.deepEqual(LANGUAGES, ["en", "fr", "ja", "zh-CN", "zh-TW"]);
  assert.equal(resolveLanguage("ja", ["fr-FR"]), "ja");
  assert.equal(resolveLanguage("", ["de-DE", "fr-CA", "en"]), "fr");
  assert.equal(resolveLanguage("", ["zh-HK"]), "zh-TW");
  assert.equal(resolveLanguage("", ["zh-Hant"]), "zh-TW");
  assert.equal(resolveLanguage("", ["zh"]), "zh-CN");
  assert.equal(resolveLanguage("klingon", ["de", null]), "en");
  assert.equal(resolveLanguage(undefined), "en");
});

test("messages come from the language, then English, then the key", () => {
  const ja = { approval: { deny: "拒否" } };
  const en = { approval: { deny: "Deny", allowOnce: "Allow once" } };
  assert.equal(lookup(ja, "approval.deny", en), "拒否");
  assert.equal(lookup(ja, "approval.allowOnce", en), "Allow once");
  assert.equal(lookup(ja, "approval.missing", en), "approval.missing");
  assert.equal(lookup(ja, "approval"), "approval"); // a group is not a message
  assert.equal(lookup(ja, "approval.deny.more", en), "approval.deny.more"); // nothing below a message
});

test("placeholders are filled, missing ones left empty", () => {
  assert.equal(format("Open {{url}} on {{ origin }}", { url: "https://a.example", origin: 0 }), "Open https://a.example on 0");
  assert.equal(format("Hi {{who}}"), "Hi ");
});

test("the extension's own choice overrides the desktop's; '' follows the desktop again", () => {
  assert.equal(chooseLanguage("fr", "ja", ["en"]), "fr");
  assert.equal(chooseLanguage("", "ja", ["en"]), "ja");
  assert.equal(chooseLanguage("", "", ["zh-TW"]), "zh-TW");
  assert.equal(chooseLanguage("xx", "", ["de"]), "en"); // an unknown choice is no choice
  assert.equal(chooseLanguage(undefined, undefined), "en");
});
