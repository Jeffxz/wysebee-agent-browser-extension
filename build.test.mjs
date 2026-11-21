// scripts/build.mjs: each build points at its own cloud, fixed when it is built, and none
// has a server setting. prod never reaches a local wysebee-cloud; the local build
// reaches only the server it was built with.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BUILDS, LOCAL, build, decodePng, encodePng, localServer, main, recolourPng } from "./scripts/build.mjs";
import { SERVER as SOURCE_SERVER, ENV as SOURCE_ENV } from "./server.js";

const built = {};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wysebee-agent-build-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const LOCAL_SERVER = "https://cloud.example.test";

function out(env) {
  built[env] ??= build(env, path.join(tmp, env), env === "local" ? `${LOCAL_SERVER}/` : undefined);
  return built[env];
}

/** Every text file of a build, relative path -> contents. */
function texts(dir) {
  const files = {};
  for (const rel of fs.readdirSync(dir, { recursive: true })) {
    if (/\.(js|html|json|css)$/.test(rel)) files[rel] = fs.readFileSync(path.join(dir, rel), "utf8");
  }
  return files;
}

test("there is one published build: prod, on https; local needs a server", () => {
  assert.deepEqual(Object.keys(BUILDS), ["prod"]);
  assert.equal(BUILDS.prod.server, "https://app.wysebee.com");
  assert.throws(() => build("dev", path.join(tmp, "dev")), /Unknown build "dev": one of prod, local/);
  assert.throws(() => build("staging", path.join(tmp, "staging")), /Unknown build "staging": one of prod, local/);
  assert.throws(() => build("local", path.join(tmp, "local-none")), /The local build needs a server/);
  assert.ok(!fs.existsSync(path.join(tmp, "local-none")));
});

test("a local build's server is an http or https URL, kept as origin and path", () => {
  assert.equal(localServer("http://localhost:8000"), "http://localhost:8000");
  assert.equal(localServer("https://cloud.example.test/"), "https://cloud.example.test");
  assert.equal(localServer("https://example.test/cloud//"), "https://example.test/cloud");
  assert.throws(() => localServer("localhost:8000"), /is not http or https/);
  assert.throws(() => localServer("not a url"), /is not a URL/);
  assert.throws(() => localServer("ftp://example.test"), /is not http or https/);
  for (const odd of ["https://me:pw@example.test", "https://example.test/?a=1", "https://example.test/#x"]) {
    assert.throws(() => localServer(odd), /has a user, query or fragment/, odd);
  }
});

test("the local build talks to the server it was built with, named and coloured apart", async () => {
  const dir = out("local");
  const { SERVER, ENV } = await import(path.join(dir, "server.js"));
  assert.equal(SERVER, LOCAL_SERVER);
  assert.equal(ENV, "local");
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.name, LOCAL.name);
  assert.equal(manifest.action.default_title, LOCAL.name);
  for (const [rel, text] of Object.entries(texts(dir))) {
    for (const other of Object.values(BUILDS)) assert.ok(!text.includes(other.server), `${rel} names ${other.server}`);
  }
  // Its bee is pink: green and blue swapped.
  const orig = decodePng(fs.readFileSync(new URL("./icon.png", import.meta.url)));
  const local = decodePng(fs.readFileSync(path.join(dir, "icon.png")));
  for (let i = 0; i < orig.pixels.length; i += 4) {
    assert.equal(local.pixels[i], orig.pixels[i]);
    assert.equal(local.pixels[i + 1], orig.pixels[i + 2]);
    assert.equal(local.pixels[i + 2], orig.pixels[i + 1]);
    assert.equal(local.pixels[i + 3], orig.pixels[i + 3]);
  }
});

test("the source tree, loaded unpacked, is the prod build", () => {
  assert.equal(SOURCE_ENV, "prod");
  assert.equal(SOURCE_SERVER, BUILDS.prod.server);
});

for (const env of ["prod"]) {
  test(`the ${env} build talks to ${BUILDS[env].server} only`, async () => {
    const dir = out(env);
    const { SERVER, ENV } = await import(path.join(dir, "server.js"));
    assert.equal(SERVER, BUILDS[env].server);
    assert.equal(ENV, env);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    assert.equal(manifest.name, BUILDS[env].name);
    assert.equal(manifest.action.default_title, BUILDS[env].name);
    for (const [rel, text] of Object.entries(texts(dir))) {
      assert.ok(!/localhost:8000|127\.0\.0\.1:8000/.test(text), `${rel} names a local wysebee-cloud`);
    }
  });

  test(`the ${env} build has no server setting`, () => {
    const files = texts(out(env));
    for (const [rel, text] of Object.entries(files)) {
      assert.ok(!text.includes("set_server"), `${rel}: set_server`);
      assert.ok(!text.includes("normaliseServer"), `${rel}: normaliseServer`);
      assert.ok(!text.includes("DEFAULT_SERVER"), `${rel}: DEFAULT_SERVER`);
      assert.ok(!/storage\.local\.(get|set)\(\s*["{[]?\s*"?server/.test(text), `${rel}: reads or writes a stored server`);
    }
    assert.ok(!files["ui/panel.js"].includes('"advanced"'), "the panel has no Advanced tab");
    const en = JSON.parse(files["locales/en.json"]);
    assert.equal(en.settings.server, undefined);
    assert.equal(en.settings.tabs.advanced, undefined);
    // The old "Let Wysebee use this browser" card, which kept polling and refused every call,
    // is gone (its stored flag cleared at every start)...
    assert.equal(en.access, undefined);
    assert.equal(en.settings.pausedNote, undefined);
    assert.ok(!files["ui/sidepanel.html"].includes('id="access"'));
    assert.ok(!/type: "pause"|msg\.type === "pause"/.test(files["ui/panel.js"] + files["background.js"]));
    assert.match(files["background.js"], /storage\.local\.remove\(\["server", "paused"\]\)/);
    // ...and the Enabled switch (2026-11-14) stops polling instead, staying paired.
    assert.ok(en.link.enabled && en.link.disabledHint && en.link.turnedOff);
    assert.match(files["ui/panel.js"], /type: "set_enabled"/);
    assert.match(files["background.js"], /msg\.type === "set_enabled"/);
    assert.match(files["background.js"], /if \(!polls\(link\) \|\| !\(await isEnabled\(\)\)\) return;/);
    assert.match(files["background.js"], /paused: true \}, 0\)/);
    // The worker reaches the cloud through server.js and nothing else.
    assert.match(files["background.js"], /import \{ SERVER \} from "\.\/server\.js";/);
  });

  test(`the ${env} build carries what the extension ships, and no tests`, () => {
    const dir = out(env);
    const all = fs.readdirSync(dir, { recursive: true });
    for (const need of ["background.js", "link.js", "policy.js", "ui/sidepanel.html", "ui/panel.js", "locales/en.json", "icon.png"]) {
      assert.ok(all.includes(need), need);
    }
    assert.ok(!all.some((f) => f.endsWith(".test.mjs") || f.startsWith("docs") || f.startsWith("scripts")));
  });
}

test("prod's icons are the source's", () => {
  for (const name of ["icon16.png", "icon32.png", "icon48.png", "icon.png"]) {
    assert.ok(fs.readFileSync(path.join(out("prod"), name)).equals(fs.readFileSync(new URL(`./${name}`, import.meta.url))), name);
  }
});

test("a PNG survives a decode and encode, and recolouring twice is the original", () => {
  for (const name of ["icon16.png", "icon32.png", "icon48.png", "icon.png"]) {
    const png = fs.readFileSync(new URL(`./${name}`, import.meta.url));
    const image = decodePng(png);
    assert.deepEqual(decodePng(encodePng(image)).pixels, image.pixels);
    assert.deepEqual(decodePng(recolourPng(recolourPng(png))).pixels, image.pixels);
  }
});

test("each build's manifest fits the Chrome Web Store's limits", () => {
  for (const env of Object.keys(BUILDS)) {
    const manifest = JSON.parse(fs.readFileSync(path.join(out(env), "manifest.json"), "utf8"));
    assert.ok(manifest.description.length <= 132, `${env}: description is ${manifest.description.length} characters, over 132`);
    assert.ok(manifest.name.length <= 75, `${env}: name is ${manifest.name.length} characters, over 75`);
  }
});

/** A PNG from raw scanlines (each a filter byte, then the row), for filters encodePng never writes. */
function pngOf(width, height, scanlines, { depth = 8, colour = 6, interlace = 0 } = {}) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([depth, colour, 0, 0, interlace], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.from(scanlines))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("the average filter is undone: each byte plus the mean of left and above", () => {
  // 2x2: row 0 plain; row 1 averaged. Row 1's first pixel has no left (0) and adds
  // half of the pixel above; its second adds half of (left + above).
  const png = pngOf(2, 2, [
    0, 10, 20, 30, 40, 50, 60, 70, 80,
    3, 1, 1, 1, 1, 2, 2, 2, 2,
  ]);
  const { pixels } = decodePng(png);
  assert.deepEqual([...pixels.subarray(8)], [6, 11, 16, 21, 2 + ((6 + 50) >> 1), 2 + ((11 + 60) >> 1), 2 + ((16 + 70) >> 1), 2 + ((21 + 80) >> 1)]);
});

test("anything but an 8-bit RGBA, non-interlaced PNG is refused", () => {
  assert.throws(() => decodePng(Buffer.from("GIF89a, not a PNG at all")), /not a PNG/);
  for (const odd of [{ depth: 16 }, { colour: 2 }, { interlace: 1 }]) {
    assert.throws(() => decodePng(pngOf(1, 1, [0, 1, 2, 3, 4], odd)), /only 8-bit RGBA/, JSON.stringify(odd));
  }
});

test("the command line builds what it is asked for, or every build, and says where", () => {
  const logged = [];
  const log = (line) => logged.push(line);
  const outOf = (env) => path.join(tmp, "cli", env);
  main([], { outOf, log, cwd: tmp });
  assert.deepEqual(logged, [`prod: ${path.join("cli", "prod")} -> ${BUILDS.prod.server}`]);
  assert.ok(fs.existsSync(path.join(outOf("prod"), "manifest.json")));
  // Built into the folder it is run from, it says ".".
  logged.length = 0;
  main(["prod"], { outOf, log, cwd: outOf("prod") });
  assert.deepEqual(logged, [`prod: . -> ${BUILDS.prod.server}`]);
  // local, alone, with its server.
  logged.length = 0;
  main(["local", "http://localhost:8000/"], { outOf, log, cwd: tmp });
  assert.deepEqual(logged, [`local: ${path.join("cli", "local")} -> http://localhost:8000`]);
  for (const bad of [["local"], ["local", "http://localhost:8000", "prod"]]) {
    assert.throws(() => main(bad, { outOf, log, cwd: tmp }), /Usage: node scripts\/build\.mjs local <server URL>/);
  }
});

test("run as a script, an unknown build is refused before anything is written", () => {
  const script = fileURLToPath(new URL("./scripts/build.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [script, "staging"], { encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Unknown build "staging"/);
  assert.ok(!fs.existsSync(fileURLToPath(new URL("./dist/staging", import.meta.url))));
});
