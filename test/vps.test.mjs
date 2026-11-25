// What the page takes from the 1ms.dog server (server/): the card for the device's own resolver, the CSP (which names
// no host of ours: the shell adds them from its metas), and /tokyo.json, the Worker's trimmed copy of server/watch's
// summary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker from "../src/worker.js";

const read = f => readFile(new URL("../public/" + f, import.meta.url), "utf8");

test("every page has the device-resolver card; the built CSP names no host of ours", async () => {
  for (const f of ["index.html", "zh-cn/index.html", "ru/google/index.html"]) assert.match(await read(f), /<section class="mine card" id="mine">/, f);
  const headers = await read("_headers"), csp = /connect-src [^;]*/.exec(headers)[0];
  assert.ok(!/1ms\.dog/.test(csp), "the shell injects the endpoints; the build must not name one: " + csp);
});

test("/tokyo.json: known resolvers only, last and uptime per protocol, cached; 502 when Tokyo doesn't answer", async () => {
  const store = new Map();
  globalThis.caches = { default: { match: async k => store.get(k.url), put: async (k, r) => { store.set(k.url, r); } } };
  const ctx = { waitUntil: p => p };
  const env = { DATA_URL: "https://data.example.com:2083" };
  let calls = 0;
  globalThis.fetch = async u => {
    calls++;
    assert.equal(u, "https://data.example.com:2083/dns/summary.json");
    return new Response(JSON.stringify({ t: "2026-11-04T06:02:00Z", r: {
      google: { doh: { last: 5, err: "", up24h: 1, up7d: 0.999, up30d: 0.998, med24h: 5 }, udp: { last: null, err: "timeout", up7d: 0.5, up30d: 0.4 } },
      unknown: { doh: { last: 1 } } } }));
  };
  const res = await worker.fetch(new Request("https://dns.1ms.dog/tokyo.json"), env, ctx);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.deepEqual(j, { t: "2026-11-04T06:02:00Z", r: { google: { doh: { last: 5, up7d: 0.999, up30d: 0.998 }, udp: { last: null, up7d: 0.5, up30d: 0.4 } } } });
  assert.match(res.headers.get("cache-control"), /max-age=120/);
  await worker.fetch(new Request("https://dns.1ms.dog/tokyo.json"), env, ctx);
  assert.equal(calls, 1, "served from the cache the second time");
  store.clear();
  globalThis.fetch = async () => { throw new Error("down"); };
  assert.equal((await worker.fetch(new Request("https://dns.1ms.dog/tokyo.json"), env, ctx)).status, 502);
});

test("/tokyo.json: no DATA_URL is an unavailable answer, not a request", async () => {
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("{}"); };
  const res = await worker.fetch(new Request("https://dns.1ms.dog/tokyo.json"), {}, { waitUntil: p => p });
  assert.equal(res.status, 502);
  assert.equal(calls, 0);
});
