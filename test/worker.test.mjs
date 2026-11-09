// The Worker's installer routes when GitHub is down: on 2026-11-09 the weekly 1ms-shell check found /i, /i.ps1 and /v
// answering 502 for about 90 seconds, because GitHub's release redirect failed and the Worker passed that on. These
// tests make GitHub fail on purpose (fetch and caches are stubbed: nothing here touches the network) and check that a
// visitor still gets somewhere: a retry first, then the last answer that worked; with nothing remembered, /i and
// /i.ps1 answer a 200 script that explains and exits 1 (a 5xx would pipe an empty script into sh, which "succeeds"),
// while /v answers 503 so a real outage still shows up in the weekly check.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

// what caches.default looks like here: the Cache API without expiry rules (a cached response is just found again).
// Keys are strings or Requests, as the Worker uses both; a Request is its URL, as in the real Cache API.
const cacheKey = key => String(typeof key === "string" ? key : key.url);
class MemoryCache {
  constructor() { this.map = new Map(); }
  async match(key) { const res = this.map.get(cacheKey(key)); return res && res.clone(); }
  async put(key, res) { this.map.set(cacheKey(key), res.clone()); }
}

const HOST = "https://dns.1ms.dog";
const PIN = tag => new Response(null, { status: 302, headers: { location: `https://github.com/yt1988/dns-test-cli/releases/tag/${tag}` } });
const STATUS = status => new Response(null, { status });

// a fresh Worker for one test: a memory cache, and a fetch that records every address it is asked for
function setup(handler) {
  const cache = new MemoryCache();
  const calls = [];
  globalThis.caches = { default: cache };
  globalThis.fetch = async (url, init = {}) => {
    calls.push(String(url));
    return handler(String(url), init, calls.length);
  };
  return { cache, calls };
}

// one request through the Worker, waiting for the cache writes it handed to waitUntil
async function get(path, method = "GET") {
  const pending = [];
  const res = await worker.fetch(new Request(HOST + path, { method }), {}, { waitUntil: p => pending.push(p) });
  const body = await res.text();
  await Promise.all(pending);
  return { res, body };
}

test("the newest version is asked once and remembered", async () => {
  const { calls } = setup(() => PIN("v0.2.3"));
  const first = await get("/v");
  assert.equal(first.res.status, 200);
  assert.equal(first.body, "0.2.3\n");
  assert.equal(calls.length, 1);
  const second = await get("/v");
  assert.equal(second.body, "0.2.3\n");
  assert.equal(calls.length, 1); // the cache answered
  assert.equal(second.res.headers.get("x-1ms-stale"), null);
});

test("a dropped connection is tried once more", async () => {
  const { calls } = setup((url, init, n) => { if (n === 1) throw new Error("no answer"); return PIN("v0.2.3"); });
  const { res, body } = await get("/v");
  assert.equal(res.status, 200);
  assert.equal(body, "0.2.3\n");
  assert.equal(calls.length, 2);
});

test("a 5xx is tried once more", async () => {
  const { calls } = setup((url, init, n) => n === 1 ? STATUS(503) : PIN("v0.2.4"));
  const { body } = await get("/v");
  assert.equal(body, "0.2.4\n");
  assert.equal(calls.length, 2);
});

test("when GitHub stays down, the version that last worked is used, marked stale", async () => {
  const { cache, calls } = setup(() => STATUS(500));
  await cache.put(`${HOST}/__latest-kept`, new Response("0.2.2"));
  const first = await get("/v");
  assert.equal(first.res.status, 200);
  assert.equal(first.body, "0.2.2\n");
  assert.equal(first.res.headers.get("x-1ms-stale"), "1");
  assert.equal(calls.length, 2); // asked twice, then fell back
  const second = await get("/v"); // the stale answer is remembered for a minute
  assert.equal(second.body, "0.2.2\n");
  assert.equal(second.res.headers.get("x-1ms-stale"), "1");
  assert.equal(calls.length, 2);
});

test("no memory and no GitHub: /v is a 503, /i and /i.ps1 are 200 scripts that explain and exit 1", async () => {
  const { calls } = setup(() => STATUS(500));
  const v = await get("/v");
  assert.equal(v.res.status, 503);
  assert.match(v.body, /GitHub is not answering/);
  assert.match(v.body, /Try again in a minute/);
  assert.equal(v.res.headers.get("retry-after"), "60");
  assert.match(v.res.headers.get("content-type"), /^text\/plain/);
  // a 5xx would make `curl -f` write nothing into the pipe and `sh` read an empty script as success: so the
  // installer route is a 200 script that says why and fails with exit 1 / throw
  const i = await get("/i");
  assert.equal(i.res.status, 200);
  assert.match(i.body, /^#!\/bin\/sh\n/);
  assert.match(i.body, /GitHub is not answering/);
  assert.match(i.body, /^exit 1$/m);
  const ps1 = await get("/i.ps1");
  assert.equal(ps1.res.status, 200);
  assert.match(ps1.body, /GitHub is not answering/);
  assert.match(ps1.body, /^throw /m);
  assert.equal(calls.length, 6); // two asks for each route, and no download to try
});

test("the installer download fails with nothing remembered: /i still explains, 200 and exit 1", async () => {
  const { cache, calls } = setup(url => url.endsWith("/releases/latest") ? PIN("v0.2.3") : STATUS(502));
  await cache.put(`${HOST}/__latest`, new Response("0.2.3")); // the version is known; only the file fails
  const { res, body } = await get("/i");
  assert.equal(res.status, 200);
  assert.match(body, /^#!\/bin\/sh\n/);
  assert.match(body, /^exit 1$/m);
  assert.equal(calls.filter(u => u.endsWith("/install.sh")).length, 2); // asked twice before giving up
});

test("a binary that GitHub fails to send is a 503, not a script", async () => {
  const { cache } = setup(() => STATUS(502));
  await cache.put(`${HOST}/__latest`, new Response("0.2.3"));
  const { res, body } = await get("/dl/v0.2.3/dnstest-linux-amd64");
  assert.equal(res.status, 503);
  assert.match(body, /GitHub is not answering/);
});

test("a 4xx is an answer: it is not retried", async () => {
  const { calls } = setup(() => STATUS(404));
  const { res, body } = await get("/v");
  assert.equal(calls.length, 1);
  assert.equal(res.status, 503); // nothing remembered, so the page says to retry
  assert.match(body, /Try again/);
});

test("the installer comes from GitHub and is kept", async () => {
  const { calls } = setup(url => url.endsWith("/releases/latest") ? PIN("v0.2.3") : new Response("#!/bin/sh\necho install\n"));
  const { res, body } = await get("/i");
  assert.equal(res.status, 200);
  assert.equal(body, "#!/bin/sh\necho install\n");
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.ok(calls.some(u => u.endsWith("/releases/download/v0.2.3/install.sh")));
});

test("GitHub failing on the installer file: the remembered copy is served", async () => {
  const { cache, calls } = setup(url => url.endsWith("/releases/latest") ? PIN("v0.2.3") : STATUS(500));
  await cache.put(`${HOST}/__i/install.sh`, new Response("#!/bin/sh\necho kept\n"));
  const { res, body } = await get("/i");
  assert.equal(res.status, 200);
  assert.equal(body, "#!/bin/sh\necho kept\n");
  assert.equal(res.headers.get("x-1ms-stale"), "1");
  assert.equal(calls.filter(u => u.endsWith("/install.sh")).length, 2); // asked twice before the kept copy
});

test("the PowerShell installer has the same fallback", async () => {
  const { cache } = setup(url => url.endsWith("/releases/latest") ? PIN("v0.2.3") : STATUS(502));
  await cache.put(`${HOST}/__i/install.ps1`, new Response("irm https://dns.1ms.dog/i.ps1 | iex"));
  const { res, body } = await get("/i.ps1");
  assert.equal(res.status, 200);
  assert.equal(body, "irm https://dns.1ms.dog/i.ps1 | iex");
  assert.equal(res.headers.get("x-1ms-stale"), "1");
});

test("/dl/latest redirects to the version that last worked", async () => {
  const { cache } = setup(() => STATUS(500));
  await cache.put(`${HOST}/__latest-kept`, new Response("0.2.2"));
  const { res } = await get("/dl/latest/dnstest-linux-amd64");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/dl/v0.2.2/dnstest-linux-amd64");
});

test("/dl/latest with nothing remembered says to retry", async () => {
  setup(() => STATUS(500));
  const { res, body } = await get("/dl/latest/dnstest-linux-amd64");
  assert.equal(res.status, 503);
  assert.match(body, /Try again/);
});

test("a release file is still passed on, and a missing one is a 404", async () => {
  setup(url => url.endsWith("/checksums.txt") ? new Response("abc  dnstest-linux-amd64\n") : STATUS(404));
  const ok = await get("/dl/v0.2.3/checksums.txt");
  assert.equal(ok.res.status, 200);
  assert.equal(ok.body, "abc  dnstest-linux-amd64\n");
  const missing = await get("/dl/v0.2.3/dnstest-linux-amd64");
  assert.equal(missing.res.status, 404);
  assert.match(missing.body, /GitHub answered 404/);
});

test("HEAD on the installer still answers", async () => {
  setup(url => url.endsWith("/releases/latest") ? PIN("v0.2.3") : new Response("#!/bin/sh\n"));
  const { res, body } = await get("/i", "HEAD");
  assert.equal(res.status, 200);
  assert.equal(body, "");
});
