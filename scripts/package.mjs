// Builds prod and zips it for the Chrome Web Store:
//
//   node scripts/package.mjs      # or: npm run package
//
// Writes wysebee-agent-<version>.zip at the repository root, with manifest.json at the
// root of the zip (what the store expects). The version is the manifest's. Only prod is
// packaged: the dev build is loaded unpacked.
//
// No dependencies: uses the system's `zip`.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "./build.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const out = build("prod");
const { version } = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
const zip = path.join(ROOT, `wysebee-agent-${version}.zip`);

// zip adds to an existing archive, so a stale one would keep files since removed.
fs.rmSync(zip, { force: true });
execFileSync("zip", ["-qrX", zip, ".", "-x", "*.DS_Store"], { cwd: out, stdio: "inherit" });

const kb = (fs.statSync(zip).size / 1024).toFixed(0);
console.log(`prod ${version}: ${path.relative(process.cwd(), zip)} (${kb} kB)`);
