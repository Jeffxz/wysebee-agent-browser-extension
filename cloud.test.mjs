// cloud.js: which Wysebee Cloud this browser pairs with. A typed server becomes an origin;
// plain http only for this computer or a private network; a stored one that is no longer
// valid falls back to the build's default. The requests then go to that origin.
import test from "node:test";
import assert from "node:assert/strict";
import { SERVER_KEY, checkServer, isPrivateHost, serverFrom } from "./cloud.js";
import { SERVER } from "./server.js";
import { pollRequest, recordingRequest, resultRequest, startRequest, unpairRequest } from "./link.js";

test("the choice is kept under its own key, not the old cleared \"server\"", () => {
  assert.equal(SERVER_KEY, "cloudServer");
});

test("private hosts: this computer, 10/8, 172.16/12, 192.168/16, .local, .localhost", () => {
  for (const host of [
    "localhost",
    "LOCALHOST",
    "app.localhost",
    "127.0.0.1",
    "127.1.2.3",
    "[::1]",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.20",
    "nas.local",
  ]) {
    assert.equal(isPrivateHost(host), true, host);
  }
  for (const host of [
    "app.wysebee.com",
    "example.com",
    "172.15.0.1",
    "172.32.0.1",
    "192.169.0.1",
    "11.0.0.1",
    "8.8.8.8",
    "local",
    "localhost.example.com",
    "",
    undefined,
    null,
  ]) {
    assert.equal(isPrivateHost(host), false, String(host));
  }
});

test("a typed server becomes an origin: paths, queries and trailing slashes dropped", () => {
  assert.equal(checkServer("https://app.wysebee.com"), "https://app.wysebee.com");
  assert.equal(checkServer("  https://Cloud.Example.com/// "), "https://cloud.example.com");
  assert.equal(checkServer("https://cloud.example.com/some/path/?q=1#x"), "https://cloud.example.com");
  assert.equal(checkServer("https://cloud.example.com:8443/"), "https://cloud.example.com:8443");
  assert.equal(checkServer("https://cloud.example.com:443"), "https://cloud.example.com");
  assert.equal(checkServer("HTTPS://cloud.example.com"), "https://cloud.example.com");
});

test("without a scheme: http for a private host, https for the rest", () => {
  assert.equal(checkServer("cloud.example.com"), "https://cloud.example.com");
  assert.equal(checkServer("cloud.example.com/path"), "https://cloud.example.com");
  assert.equal(checkServer("localhost:8000"), "http://localhost:8000");
  assert.equal(checkServer("localhost:8000/"), "http://localhost:8000");
  assert.equal(checkServer("192.168.1.20:8000?x"), "http://192.168.1.20:8000");
  assert.equal(checkServer("nas.local"), "http://nas.local");
  assert.equal(checkServer("[::1]:8000"), "http://[::1]:8000");
});

test("plain http only for this computer or a private network", () => {
  for (const ok of [
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "http://[::1]:8000",
    "http://10.1.2.3",
    "http://172.20.0.4:8000",
    "http://192.168.0.10",
    "http://wysebee.local:8000",
    "http://app.localhost",
  ]) {
    assert.equal(checkServer(ok), ok, ok);
  }
  for (const bad of ["http://app.wysebee.com", "http://cloud.example.com:8000", "http://172.32.0.1", "http://8.8.8.8"]) {
    assert.equal(checkServer(bad), null, bad);
  }
});

test("anything but an http(s) origin is refused", () => {
  for (const bad of [
    "",
    "   ",
    undefined,
    null,
    "ftp://cloud.example.com",
    "javascript:alert(1)",
    "chrome-extension://abc/page.html",
    "file:///etc/passwd",
    "https://user:pass@cloud.example.com",
    "https://user@cloud.example.com",
    "user@localhost:8000",
    "exa mple.com",
    "https://",
  ]) {
    assert.equal(checkServer(bad), null, String(bad));
  }
});

test("the stored server is used while valid; otherwise the build's default", () => {
  assert.equal(serverFrom("http://localhost:8000", SERVER), "http://localhost:8000");
  assert.equal(serverFrom("https://cloud.example.com", SERVER), "https://cloud.example.com");
  assert.equal(serverFrom(undefined, SERVER), SERVER);
  assert.equal(serverFrom("", SERVER), SERVER);
  assert.equal(serverFrom(42, SERVER), SERVER);
  // Not an origin as checkServer gives it: someone wrote storage by hand.
  assert.equal(serverFrom("https://cloud.example.com/", SERVER), SERVER);
  assert.equal(serverFrom("http://cloud.example.com", SERVER), SERVER);
  assert.equal(serverFrom("localhost:8000", SERVER), SERVER);
});

test("unchanged by default: the source tree pairs with https://app.wysebee.com", () => {
  assert.equal(serverFrom(undefined, SERVER), "https://app.wysebee.com");
  const r = startRequest(serverFrom(undefined, SERVER), { name: "Helper", secretHash: "ab", browser: "Chrome", version: "1" });
  assert.equal(r.url, "https://app.wysebee.com/api/v1/browser-links/start");
});

test("set to http://localhost:8000, every request goes to that origin", () => {
  const server = serverFrom(checkServer("http://localhost:8000/"), SERVER);
  const urls = [
    startRequest(server, { name: "Helper", secretHash: "ab", browser: "Chrome", version: "1" }).url,
    pollRequest(server, "id1", "s", { version: "1", browser: "Chrome" }).url,
    resultRequest(server, "id1", "s", "c1", { ok: true, result: 1 }).url,
    recordingRequest(server, "id1", "s", { name: "n", startedAt: 0, durationMs: 1, origin: "https://x.test" }).url,
    unpairRequest(server, "id1", "s").url,
  ];
  for (const url of urls) assert.equal(new URL(url).origin, "http://localhost:8000", url);
});
