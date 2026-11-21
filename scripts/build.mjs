// Builds the extension:
//
//   node scripts/build.mjs            # dist/prod
//   node scripts/build.mjs prod       # dist/prod
//   node scripts/build.mjs local <server URL>   # dist/local, for development
//   WYSEBEE_CLOUD_URL=<server URL> node scripts/build.mjs local   # the same
//
// Each build is a copy of what the extension ships (no tests, no docs) with server.js
// rewritten to its cloud: the server it talks to unless the person sets a self-hosted one
// in the side panel's Server tab (cloud.js).
// The local build talks to whichever Wysebee Cloud it is given when built; it is named
// "Wysebee Agent Local", its bee is pink, so it can be loaded beside the prod one and
// told apart in the toolbar, and it is never built unless asked for by name.
//
// No dependencies: the icons are recoloured with node's own zlib.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The published build, and the cloud it defaults to. */
export const BUILDS = {
  prod: { server: "https://app.wysebee.com", name: "Wysebee Agent" },
};

/** The local build: for development, against the server it is built with. */
export const LOCAL = { name: "Wysebee Agent Local" };

/**
 * The environment variable the local build's server can come from instead of the command
 * line, named as Wysebee Desktop's (WYSEBEE_CLOUD_URL=http://localhost:8001). Only the
 * local build reads it: prod's server is fixed.
 */
export const CLOUD_URL_VAR = "WYSEBEE_CLOUD_URL";

const LOCAL_USAGE =
  `Usage: node scripts/build.mjs local <server URL>, or ${CLOUD_URL_VAR}=<server URL> node scripts/build.mjs local; ` +
  "e.g. http://localhost:8000";

/**
 * A local build's server: an http or https URL, with no user, query or fragment, given as
 * its origin and path without a trailing slash (the extension appends "/api/v1/...").
 */
export function localServer(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a URL. ${LOCAL_USAGE}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`"${url}" is not http or https. ${LOCAL_USAGE}`);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error(`"${url}" has a user, query or fragment. ${LOCAL_USAGE}`);
  return (parsed.origin + parsed.pathname).replace(/\/+$/, "");
}

/** What `env` is built as: its server and name. `server` is the local build's only. */
function specOf(env, server) {
  if (env === "local") {
    if (server === undefined) throw new Error(`The local build needs a server. ${LOCAL_USAGE}`);
    return { ...LOCAL, server: localServer(server) };
  }
  const spec = BUILDS[env];
  if (!spec) throw new Error(`Unknown build "${env}": one of ${[...Object.keys(BUILDS), "local"].join(", ")}.`);
  return spec;
}

/** What a build carries, relative to the repository: the rest is tests, docs, tooling. */
function shipped() {
  const files = ["manifest.json"];
  for (const f of fs.readdirSync(ROOT)) {
    if ((f.endsWith(".js") && f !== "server.js") || /^icon\d*\.png$/.test(f)) files.push(f);
  }
  for (const dir of ["locales", "ui"]) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      if (!f.startsWith(".") && !f.endsWith(".test.mjs")) files.push(`${dir}/${f}`);
    }
  }
  return files.sort();
}

export function serverModule(env, server) {
  return (
    `// Which Wysebee Cloud this build talks to by default, set when it was built (scripts/build.mjs).\n` +
    `export const ENV = ${JSON.stringify(env)};\n` +
    `export const SERVER = ${JSON.stringify(server)};\n`
  );
}

/** Build `env` into `out` (emptied first); `server` is the local build's. Returns `out`. */
export function build(env, out = path.join(ROOT, "dist", env), server) {
  const spec = specOf(env, server);
  fs.rmSync(out, { recursive: true, force: true });
  for (const rel of shipped()) {
    const to = path.join(out, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    let bytes = fs.readFileSync(path.join(ROOT, rel));
    if (env !== "prod" && rel.endsWith(".png")) bytes = recolourPng(bytes, SWAPS[env]);
    fs.writeFileSync(to, bytes);
  }
  fs.writeFileSync(path.join(out, "server.js"), serverModule(env, spec.server));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  manifest.name = spec.name;
  manifest.action = { ...manifest.action, default_title: spec.name };
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return out;
}

// --- the local icon: a pink bee ---------------------------------------------------

/** The two colour channels each build's bee swaps: green and blue (pink). */
const SWAPS = { local: [1, 2] };

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunks(png) {
  const out = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    out.push({ type: png.toString("latin1", at + 4, at + 8), data: png.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return out;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** An 8-bit RGBA, non-interlaced PNG's pixels (what the icons are). */
export function decodePng(png) {
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG");
  const all = chunks(png);
  const ihdr = all.find((c) => c.type === "IHDR").data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  if (ihdr[8] !== 8 || ihdr[9] !== 6 || ihdr[12] !== 0) throw new Error("only 8-bit RGBA, non-interlaced");
  const raw = zlib.inflateSync(Buffer.concat(all.filter((c) => c.type === "IDAT").map((c) => c.data)));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? pixels[y * stride + x - 4] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[y * stride + x] = v & 255;
    }
  }
  return { width, height, pixels };
}

export function encodePng({ width, height, pixels }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * The bee's yellow recoloured by swapping two channels: by default red and blue, which turns
 * it blue; its black, and grey, kept.
 */
export function recolourPng(png, [a, b] = [0, 2]) {
  const image = decodePng(png);
  const p = image.pixels;
  for (let i = 0; i < p.length; i += 4) [p[i + a], p[i + b]] = [p[i + b], p[i + a]];
  return encodePng(image);
}

/**
 * The command line: build each env asked for (prod when none is), saying where,
 * relative to `cwd`. `local` is built alone, with the server that follows it, else the one
 * in WYSEBEE_CLOUD_URL (the command line wins when both are given).
 */
export function main(asked, { outOf = (env) => path.join(ROOT, "dist", env), log = console.log, cwd = process.cwd(), env = process.env } = {}) {
  if (asked[0] === "local") {
    const server = asked[1] ?? (env[CLOUD_URL_VAR] || undefined);
    if (asked.length > 2 || server === undefined) throw new Error(LOCAL_USAGE);
    const out = build("local", outOf("local"), server);
    log(`local: ${path.relative(cwd, out) || "."} -> ${localServer(server)}`);
    return;
  }
  for (const env of asked.length ? asked : Object.keys(BUILDS)) {
    const out = build(env, outOf(env));
    log(`${env}: ${path.relative(cwd, out) || "."} -> ${specOf(env).server}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
