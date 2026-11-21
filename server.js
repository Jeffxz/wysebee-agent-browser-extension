// Which Wysebee Cloud this build talks to, fixed when it is built: scripts/build.mjs
// writes this file into dist/prod and dist/local. Nobody types a server, and nothing
// else reads one. The source tree, loaded unpacked as it is, is the prod build.
export const ENV = "prod";
export const SERVER = "https://app.wysebee.com";
