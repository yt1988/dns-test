// DNS messages, statistics and the direct rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { query, parse, b64url, mixCase, dohURL } from "../src/dns.mjs";
import { quantile, score } from "../src/measure.mjs";
import { items, ruleSets, inline, FORMATS } from "../src/rules.mjs";

test("a query is a well-formed DNS message", () => {
  const q = query("www.example.com", "TXT");
  assert.equal(q[0] << 8 | q[1], 0, "ID 0 for GET");
  assert.equal(q[2], 0x01, "RD");
  assert.equal(q[3], 0x20, "AD asked");
  assert.deepEqual([...q.slice(4, 12)], [0, 1, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual([...q.slice(12, 17)], [3, 119, 119, 119, 7]);
  assert.equal(q.length, 12 + 17 + 4 + 11);
  assert.match(b64url(q), /^[A-Za-z0-9_-]+$/);
  assert.ok(dohURL("https://x/dns-query", "a.b").startsWith("https://x/dns-query?dns="));
  assert.ok(dohURL("https://x/q?x=1", "a.b").includes("?x=1&dns="));
});

test("mixCase keeps the name, changes only letter case", () => {
  let i = 0;
  const s = mixCase("www.apple-1.com", () => (i++ % 2 ? 0 : 1));
  assert.equal(s.toLowerCase(), "www.apple-1.com");
  assert.notEqual(s, "www.apple-1.com");
});

test("parse reads rcode, AD, addresses and TXT", () => {
  // answer to example.com A: 93.184.215.14, with a compressed name pointer; then a TXT record
  const m = new Uint8Array([0, 0, 0x81, 0xa0, 0, 1, 0, 2, 0, 0, 0, 0,
    7, ...Buffer.from("example"), 3, ...Buffer.from("com"), 0, 0, 1, 0, 1,
    0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 93, 184, 215, 14,
    0xc0, 12, 0, 16, 0, 1, 0, 0, 0, 60, 0, 6, 5, ...Buffer.from("hello")]);
  const p = parse(m.buffer);
  assert.equal(p.rcode, 0);
  assert.equal(p.ad, true);
  assert.deepEqual(p.addrs, ["93.184.215.14"]);
  assert.deepEqual(p.txt, ["hello"]);
  assert.equal(parse(new Uint8Array([0, 0, 1, 0]).buffer), null, "not a response");
});

test("score ranks by median and punishes loss", () => {
  assert.equal(quantile([3, 1, 2], .5), 2);
  const t = (cached, lost = 0) => ({ up: true, cached, sent: cached.length + lost, lost });
  assert.equal(score(t([10, 10, 50])), 10);
  assert.ok(Math.abs(score(t([10, 10, 10, 10, 10, 10, 10, 10, 10], 1)) - 13) < 1e-9);
  assert.equal(score(t([10], 2)), null, "half lost: not ranked");
  assert.equal(score({ up: false, cached: [], sent: 0, lost: 0 }), null);
});

test("direct rules name only exact hosts and single addresses", () => {
  const it = items();
  assert.ok(it.length > 15);
  for (const i of it) assert.ok(i.d ? /^[a-z0-9.-]+$/.test(i.d) : /\/(32|128)$/.test(i.ip), JSON.stringify(i));
  const sets = ruleSets("https://dns.1ms.dog");
  assert.ok(sets["clash.yaml"].includes("  - IP-CIDR,1.1.1.1/32,no-resolve"));
  assert.ok(sets["surge.list"].includes("DOMAIN,dns.google\n"));
  assert.ok(!/DOMAIN-SUFFIX|DOMAIN-KEYWORD/.test(Object.values(sets).join("")));
  assert.deepEqual(JSON.parse(sets["singbox.json"]).rules[0].ip_cidr.slice(0, 1), ["1.1.1.1/32"]);
  for (const f of FORMATS) assert.ok(inline(f, { top: "t", fakeip: "f" }).length > 100, f);
});

test("a shared result survives the link, unknown resolvers are skipped, other formats refused", async () => {
  const { encode, decode, sharePath } = await import("../src/share.mjs");
  const known = new Set(["alidns", "adguard-nf", "google"]);
  const r = { ts: 1793500000000, cc: "CN", rows: [
    { id: "alidns", doh: 6.5, udp: 6.5, dot: 6.4, unc: 269, loss: 0 },
    { id: "gone", doh: 3, udp: null, dot: null, unc: null, loss: 0 },
    { id: "adguard-nf", doh: 131.2, udp: null, dot: 131, unc: 1020, loss: .05 },
    { id: "google", doh: null, udp: null, dot: null, unc: null, loss: 0 }] };
  const code = encode(r);
  assert.match(code, /^1~[0-9a-z]+~CN~/);
  assert.match(code, /^[0-9A-Za-z~._-]+$/, "path-safe");
  const back = decode(code, known);
  assert.deepEqual(back.rows.map(x => x.id), ["alidns", "adguard-nf", "google"]);
  assert.deepEqual(back.rows[1], { id: "adguard-nf", doh: 131.2, udp: null, dot: 131, unc: 1020, loss: .05 });
  assert.equal(back.rows[2].doh, null);
  assert.equal(back.ts, 1793500000000);
  assert.equal(decode(encode({ ...r, cc: "" }), known).cc, "");
  assert.equal(decode("2~x~-~alidns_1", known), null, "a later format");
  assert.equal(decode("1~x~-~alidns_zz!", known), null, "garbage");
  assert.deepEqual(sharePath("/zh-cn/r/" + code), { slug: "zh-cn", code });
  assert.deepEqual(sharePath("/r/" + code), { slug: "", code });
  assert.equal(sharePath("/zh-cn/"), null);
});

test("a result link whose code can't be read is not found, never sent home", async () => {
  const { default: worker } = await import("../src/worker.js");
  const env = { ASSETS: { fetch: () => { throw new Error("no page for an unreadable code"); } } };
  for (const p of ["/r/zz", "/zh-cn/r/zz", "/r/1~tntea0~-~nosuch_2c____", "/r/2~x~-~cloudflare_2c____"]) {
    const res = await worker.fetch(new Request("https://dns.1ms.dog" + p), env, {});
    assert.equal(res.status, 404, p);
  }
});
