// Which Wysebee Cloud this browser pairs with: the hosted one (server.js's, the build's
// default) or a self-hosted one the person typed in the side panel's Server tab.
//
// Pure, like link.js: background.js keeps the choice in chrome.storage.local under
// SERVER_KEY and reads it before each request; the side panel checks what was typed with
// the same checkServer(). A pairing belongs to the server it was made with, so the worker
// unpairs before the server changes.

/** Where the choice is kept. Not "server": an earlier version's key, cleared at every start. */
export const SERVER_KEY = "cloudServer";

/**
 * Whether `hostname` (as URL.hostname gives it) is this computer or a private network:
 * localhost, 127/8, [::1], 10/8, 172.16/12, 192.168/16, *.localhost and *.local. Only
 * these may be plain http; anything else goes over the internet and must be https.
 */
export function isPrivateHost(hostname) {
  const host = String(hostname ?? "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "[::1]") return true;
  const ip = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!ip) return false;
  const [a, b] = [Number(ip[1]), Number(ip[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * A typed server as the origin requests go to ("https://cloud.example.com"), or null when it
 * is not one. Without a scheme it is https, or http for a private host ("192.168.1.20:8000").
 * A path, query, fragment and trailing slashes are dropped; a user or password is refused;
 * plain http is refused for anything but a private host.
 */
export function checkServer(typed) {
  const text = String(typed ?? "").trim();
  if (!text) return null;
  let candidate = text;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const host = text.split(/[/?#]/)[0].replace(/:\d*$/, "");
    candidate = `${isPrivateHost(host) ? "http" : "https"}://${text}`;
  }
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && isPrivateHost(url.hostname)) return url.origin;
  return null;
}

/**
 * The server to use: what was stored, when it is still a valid one, else `fallback`
 * (server.js's SERVER, the build's default).
 */
export function serverFrom(stored, fallback) {
  return typeof stored === "string" && checkServer(stored) === stored ? stored : fallback;
}
