// What the page hands the shell's "Report a problem" dialog (1ms-shell docs/tool-contract.md, 报告问题): a line, the
// result as JSON, and one-tap readings — and the privacy rule: no address (masked, and only a resolver's), nothing the
// share dialog only adds when ticked (the visitor's country). The dialog sends data only under 6 KB, so the full
// 33-resolver case is measured here too.
import test from "node:test";
import assert from "node:assert/strict";
import { reportContext, maskIP } from "../src/report.mjs";
import { RESOLVERS } from "../src/resolvers.mjs";

// the page's t(): the English strings this uses, with {placeholders} filled
const S = {
  none_up: "No resolver answered",
  emb_head: "Your fastest DNS: {name}, {ms} ms",
  share_desc_self: "{name} timed from one network: DoH {ms} ms.",
  win_sub: "Fastest of {n}, {d} ms ahead of {second}",
  emb_down: "{n} resolvers can't be reached from your network", emb_down_one: "{n} resolver can't be reached from your network",
  emb_rewrite: "{name} sends names that don't exist to another address",
  emb_nodnssec: "{name} doesn't check DNSSEC",
  mine_h: "The DNS your device really uses", mine_fail: "Couldn't tell which DNS your device uses",
  best_k: "Fastest for you", e_fail: "no answer", tip_rewrite: "answers missing names with an address",
  tip_loss: "{p}% of queries got no answer", node_h: "Serving you from",
};
const t = (k, v) => String(S[k] ?? k).replace(/\{(\w+)\}/g, (m, x) => x in (v || {}) ? v[x] : m);
const tn = (k, v) => t(v.n === 1 && S[k + "_one"] != null ? k + "_one" : k, v);
const fmt = ms => ms == null ? "–" : ms < 10 ? ms.toFixed(1) : String(Math.round(ms));
const country = cc => cc;

const row = (id, doh, extra = {}) => ({ id, doh, udp: doh == null ? null : doh + 1, dot: doh == null ? null : doh + 2, unc: doh == null ? null : doh + 20, loss: 0, ...extra });
const target = (id, { up = true, rewrites = false } = {}) => ({ r: RESOLVERS.find(r => r.id === id), kind: "doh", up, rewrites, cached: [], uncached: [] });

function context(over = {}) {
  const rows = over.rows || [row("cloudflare", 1.2), row("google", 3.4), row("quad9", null)];
  const ids = rows.map(r => r.id);
  const targets = [
    target("cloudflare"), target("google"), target("quad9", { up: false }),
  ].filter(x => ids.includes(x.r.id));
  targets.find(x => x.r.id === "cloudflare").rewrites = true;
  return reportContext({
    last: { ts: Date.UTC(2026, 10, 9, 12, 0, 0), rows },
    targets, resolvers: RESOLVERS,
    mine: { first: { ip: "203.0.113.7", cc: "US", asn: 13335, org: "Cloudflare" }, ips: ["203.0.113.7"], ecs: "yes", net: "203.0.113.0/24" },
    nodes: { cloudflare: { first: { cc: "US", asn: 13335, ip: "1.1.1.1" }, ecs: "no" } },
    focus: null, lang: "en", path: "/", viewing: false, t, tn, fmt, country,
    ...over,
  });
}

test("an address is masked to its last part", () => {
  assert.equal(maskIP("203.0.113.7"), "203.0.113.x");
  assert.equal(maskIP("2001:db8::7"), "2001:db8::x");
  assert.equal(maskIP(""), "");
  assert.equal(maskIP(null), "");
});

test("no result yet: nothing is handed over", () => {
  assert.equal(context({ last: null }), null);
});

test("the summary says who won, how far ahead and what looked wrong", () => {
  const c = context();
  assert.ok(c.summary.length <= 300);
  assert.match(c.summary, /Your fastest DNS: Cloudflare, 1\.2 ms/);
  assert.match(c.summary, /2\.2 ms ahead of Google/);
  assert.match(c.summary, /1 resolver can't be reached/);     // emb_down_one, quad9 down
  assert.match(c.summary, /sends names that don't exist/);    // emb_rewrite, cloudflare
});

test("the data reproduces the rows and carries no address or visitor country", () => {
  const c = context();
  const data = c.data;
  assert.equal(data.tool, "dns");
  assert.equal(data.winner.id, "cloudflare");
  assert.deepEqual(data.rows.map(r => r.id), ["cloudflare", "google", "quad9"]);
  assert.equal(data.rows[2].down, 1);
  assert.equal(data.rows[0].rewrite, 1);
  assert.equal(data.mine.ip, "203.0.113.x");                  // the resolver's address, masked
  assert.equal(data.mine.cc, "US");                           // where that resolver is, not where the visitor is
  assert.equal(data.mine.net, undefined);                     // never the ECS network
  assert.equal(data.cc, undefined);                           // never the visitor's country
  assert.equal(data.nodes.cloudflare.cc, "US");
  assert.equal(data.nodes.cloudflare.ip, undefined);
  const json = JSON.stringify(data);
  assert.ok(!/(\d{1,3}\.){3}\d{1,3}/.test(json), "no full IPv4 address in the data");
  assert.ok(!/2001:db8::7/.test(json), "no full IPv6 address in the data");
});

test("picks are one-tap lines in the page's language, at most 8 and 60 characters", () => {
  const c = context();
  assert.ok(c.picks.length <= 8);
  for (const p of c.picks) assert.ok(p.length <= 60, p);
  assert.ok(c.picks.some(p => p.includes("The DNS your device really uses") && p.includes("Cloudflare")));
  assert.ok(c.picks.some(p => p.includes("Fastest for you")));
  assert.ok(c.picks.some(p => p.includes("Quad9") && p.includes("no answer")));
});

test("the full 33-resolver result stays under the dialog's 6 KB, even pretty-printed", () => {
  const rows = RESOLVERS.map((r, i) => row(r.id, i % 7 === 6 ? null : 1 + i * 1.7, { loss: i % 5 === 0 ? 0.25 : 0 }));
  const targets = RESOLVERS.map(r => target(r.id, { up: rows.find(x => x.id === r.id).doh != null }));
  const nodes = Object.fromEntries(RESOLVERS.map((r, i) => [r.id, { first: { cc: ["US", "JP", "DE"][i % 3], asn: 1000 + i, ip: `${i}.1.1.1` }, ecs: ["yes", "no", "late"][i % 3] }]));
  const c = reportContext({
    last: { ts: Date.UTC(2026, 10, 9), rows }, targets, resolvers: RESOLVERS,
    mine: { first: { ip: "203.0.113.7", cc: "US", asn: 13335, org: "Cloudflare" }, ips: [], ecs: "yes", net: "203.0.113.0/24" },
    nodes, focus: null, lang: "en", path: "/", viewing: false, t, tn, fmt, country,
  });
  const bytes = new TextEncoder().encode(JSON.stringify(c.data, null, 1)).length;
  assert.ok(bytes < 6000, `${bytes} bytes`);
  assert.ok(c.summary.length <= 300);
  assert.ok(c.picks.length <= 8);
});

test("a resolver's own page talks about that one", () => {
  const c = context({ focus: RESOLVERS.find(r => r.id === "cloudflare"), rows: [row("cloudflare", 1.2)], targets: [target("cloudflare")] });
  assert.match(c.summary, /Cloudflare timed from one network: DoH 1\.2 ms/);
  assert.equal(c.data.focus, "cloudflare");
});
