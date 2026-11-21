// Which Wysebee Cloud this build talks to by default, set when it is built:
// scripts/build.mjs writes this file into dist/prod and dist/local. The side panel's
// Server tab can point the extension at a self-hosted one instead (cloud.js). The source
// tree, loaded unpacked as it is, is the prod build.
export const ENV = "prod";
export const SERVER = "https://app.wysebee.com";
