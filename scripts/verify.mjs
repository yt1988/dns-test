#!/usr/bin/env node
// Checks every resolver the way the page uses it, over HTTP/2 (or HTTP/1.1 where the server offers no h2 in ALPN, as a
// browser falls back), and checks what the list says about it:
//   - doh and ip answer a GET ?dns= query with 200 and a DNS message (a redirect, an error page or a timeout fails).
//     Every address the host resolves to is tried in parallel, as a browser does: one dead address does not fail a
//     resolver that answers on another, it is printed as a note.
//   - Access-Control-Allow-Origin is there exactly when the list says cors / ipCors (the page reads answers only then)
//   - dnssec: dnssec-failed.org (broken signature) gets SERVFAIL and cloudflare.com (signed) gets the AD bit.
//     A resolver whose filter answers that name itself, or whose behavior differs by node, goes in SKIP_DNSSEC:
//     the check prints what it measured and why it doesn't compare it (see 2026-11-11 in design.md)
//   - ecs (shown, not checked): o-o.myaddr.l.google.com shows an edns0-client-subnet when the resolver passed one on.
//     Not in the list: the same resolver passes it from some places and protocols and not others
//   - a random name under NXZONE gets NXDOMAIN (some resolvers answer with an ad server's address instead)
//   - warm: the fastest of three queries on the open connection, for a feel of each one from here
// Run from more than one continent before changing the list (a VPS, or the weekly GitHub Action).
// Usage: node scripts/verify.mjs [id …]
import http2 from "node:http2";
import https from "node:https";
import net from "node:net";
import { lookup } from "node:dns/promises";
import { RESOLVERS, NXZONE, CHECKS } from "../src/resolvers.mjs";
import { dohURL, parse, randLabel, mixCase, RCODE } from "../src/dns.mjs";

// CleanBrowsing says it validates DNSSEC and did on some US GitHub runs, but from Tokyo and China its filter answers
// dnssec-failed.org itself (an address, no AD); one list value can't be right on both sides, so the list keeps what
// its visitors in Asia get and this check only reports. See 2026-11-11 in design.md.
const SKIP_DNSSEC = new Map([["cleanbrowsing", "its filter answers the test name itself from Asia, while some US GitHub runners saw it validate"]]);

const pick = process.argv.slice(2);
const list = pick.length ? RESOLVERS.filter(r => pick.includes(r.id)) : RESOLVERS;
const sessions = new Map();   // "origin|address" → HTTP/2 session
const addrs = new Map();      // hostname → every address it resolves to (A and AAAA)
const h1Only = new Set();     // origins whose server offers no h2 ALPN; a browser falls back to HTTP/1.1 there too

// Every address a host resolves to, not just the first: doh.pub has two, and on some networks one is unreachable
// while the other answers in milliseconds. A browser tries both, so this does too.
async function addresses(host) {
  if (net.isIP(host)) return [{ address: host, family: net.isIPv6(host) ? 6 : 4 }];
  if (!addrs.has(host)) {
    try { addrs.set(host, await lookup(host, { all: true })); } catch { addrs.set(host, []); }
  }
  return addrs.get(host);
}

// Whether this network can open a TCP connection to the address at all. An unreachable IPv6 address on an IPv4-only
// runner (GitHub's) made http2.connect emit the ENETUNREACH as an unhandled socket error and kill the run, so the
// address is filtered out before a session is built. Cached: one probe per address per run.
const reach = new Map();
function canReach(a) {
  const key = a.address + "|" + a.family;
  if (!reach.has(key)) {
    reach.set(key, new Promise(resolve => {
      const s = net.connect({ host: a.address, port: 443, family: a.family });
      const done = ok => { s.destroy(); resolve(ok); };
      s.setTimeout(2500, () => done(false));
      s.on("connect", () => done(true));
      s.on("error", () => done(false));
    }));
  }
  return reach.get(key);
}

// The first answer wins; an address that fails is reported as a note, not as the resolver's failure.
function first(attempts) {
  return new Promise((resolve, reject) => {
    let left = attempts.length;
    const failed = [];
    for (const [a, go] of attempts) {
      go().then(r => resolve({ ...r, failed: failed.slice() }), e => {
        failed.push({ address: a.address, error: String(e.message).split("\n")[0] });
        if (--left === 0) reject(Object.assign(new Error(failed.map(f => f.address + ": " + f.error).join("; ")), { failed }));
      });
    }
  });
}

// net.connect asks for one address, or for all of them when its Happy Eyeballs path is on (Node 22, GitHub's runner):
// answer both shapes, or it reports "Invalid IP address: undefined". autoSelectFamily is off because each connection
// is pinned to one address here; on the runner its multi-address path emitted ENETUNREACH on the IPv6 attempt as an
// unhandled socket error, which killed the run.
const pin = a => (h, o, cb) => o && o.all ? cb(null, [a]) : cb(null, a.address, a.family);

function h2(url, a) {
  const u = new URL(url), key = u.origin + "|" + a.address;
  let s = sessions.get(key);
  if (!s || s.closed || s.destroyed) {
    s = http2.connect(u.origin, { lookup: pin(a), autoSelectFamily: false });
    s.on("error", () => {});
    sessions.set(key, s);
  }
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = s.request({ ":method": "GET", ":path": u.pathname + u.search, accept: "application/dns-message", origin: "https://dns.1ms.dog" });
    const timer = setTimeout(() => { req.close(); s.destroy(); reject(new Error("timeout")); }, 6000);
    let head = {};
    const chunks = [];
    req.on("response", h => { head = h; });
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      clearTimeout(timer);
      // a server can close the connection without answering (GOAWAY, RST_STREAM): say so instead of "HTTP undefined"
      if (!head[":status"]) return reject(new Error("no HTTP response"));
      resolve({ status: head[":status"], head, body: Buffer.concat(chunks), ms: performance.now() - t0, proto: "h2", address: a.address });
    });
    req.on("error", e => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

// HTTP/1.1: some DoH servers (Njalla among them) offer no h2 in ALPN and refuse a handshake that insists on it. A
// browser then speaks HTTP/1.1 to the same URL, so this counts as the same endpoint, with a note in the output.
function h1(url, a) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const t0 = performance.now();
    const req = https.request(u, { method: "GET", lookup: pin(a), autoSelectFamily: false,
      headers: { accept: "application/dns-message", origin: "https://dns.1ms.dog" } }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => { clearTimeout(timer); resolve({ status: res.statusCode, head: res.headers, body: Buffer.concat(chunks), ms: performance.now() - t0, proto: "h1", address: a.address }); });
      res.on("error", e => { clearTimeout(timer); reject(e); });
    });
    const timer = setTimeout(() => { req.destroy(); reject(new Error("timeout")); }, 6000);
    req.on("error", e => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

// one GET: status, headers, body, ms, from the first of the host's reachable addresses that answers
async function get(url) {
  const u = new URL(url);
  const all = await addresses(u.hostname);
  if (!all.length) throw new Error("no address for " + u.hostname);
  const flags = await Promise.all(all.map(canReach));
  const usable = all.filter((a, i) => flags[i]);
  if (!usable.length) throw new Error("no reachable address for " + u.hostname);
  if (!h1Only.has(u.origin)) {
    try {
      return await first(usable.map(a => [a, () => h2(url, a)]));
    } catch (e) {
      if (!/no application protocol|ALPN/i.test(e.message)) throw e;
      h1Only.add(u.origin);
    }
  }
  return await first(usable.map(a => [a, () => h1(url, a)]));
}

// A DNS answer is what these checks read, whatever the HTTP status says. RFC 8484 asks for 200, but DNS.SB sends
// SERVFAIL as HTTP 503 (dnssec-failed.org gets exactly that), so a response counts when its body parses as a DNS
// message. The ordinary queries still need 200: they ask for a name that resolves, so anything else is a broken
// endpoint. A transport error gets one more try: these servers close HTTP/2 sessions under us now and then.
async function ask(endpoint, name, type, anyStatus = false) {
  let r;
  try {
    r = await get(dohURL(endpoint, name, type));
  } catch (e) {
    if (!/timeout|stream|session|socket|ECONN|EPIPE|no HTTP response/.test(e.message)) throw e;
    r = await get(dohURL(endpoint, name, type));
  }
  const p = parse(r.body);
  if (!p) throw new Error("HTTP " + (r.status ?? "?") + ", not a DNS answer");
  if (r.status !== 200 && !anyStatus) throw new Error("HTTP " + r.status);
  return { ...p, ms: r.ms, head: r.head, status: r.status, proto: r.proto, address: r.address, failed: r.failed };
}

const f = v => v == null ? "?" : v ? "yes" : "no";
let bad = 0;
const rows = await Promise.all(list.map(async r => {
  const out = { id: r.id, notes: [], skips: [] };
  for (const [k, url] of [["doh", r.doh], ["ip", r.ip]]) {
    if (!url) continue;
    try {
      const a = await ask(url, mixCase("example.com"), "A");
      if (a.rcode !== RCODE.NOERROR || !a.addrs.length) out.notes.push(`${k}: rcode ${a.rcode}, ${a.addrs.length} addresses`);
      if (a.proto === "h1") out.skips.push(`${k}: HTTP/1.1 only (the server offers no h2 in ALPN); a browser falls back the same way`);
      if (a.failed && a.failed.length) out.skips.push(`${k}: ${a.failed.map(x => x.address + " " + x.error).join(", ")}; ${a.address} answered`);
      const acao = a.head["access-control-allow-origin"];
      const want = k === "doh" ? !!r.cors : !!r.ipCors;
      if (!!acao !== want) out.notes.push(`${k}: cors is ${!!acao} (list: ${want})`);
      const warm = [];
      for (let i = 0; i < 3; i++) warm.push((await ask(url, mixCase("www.apple.com"), "A")).ms);
      out[k] = Math.min(...warm).toFixed(0) + "ms";
    } catch (e) {
      out[k] = "FAIL";
      out.notes.push(`${k} ${url}: ${e.message}`);
    }
  }
  if (out.doh !== "FAIL") {
    try {
      const [b, g, e, nx] = await Promise.all([ask(r.doh, CHECKS.dnssecBad, "A", true), ask(r.doh, CHECKS.dnssecGood, "A", true), ask(r.doh, CHECKS.ecs, "TXT", true), ask(r.doh, randLabel() + "." + NXZONE, "A", true)]);
      out.dnssec = b.rcode === RCODE.SERVFAIL && g.ad;
      out.ecs = e.txt.some(t => t.startsWith("edns0-client-subnet"));
      out.egress = e.txt.find(t => !t.startsWith("edns0")) || "";
      out.nx = nx.rcode === RCODE.NXDOMAIN;
      if (!out.nx) out.notes.push(`random name: rcode ${nx.rcode}, ${nx.addrs.join(" ")}`);
      if (SKIP_DNSSEC.has(r.id)) out.skips.push(`dnssec not asserted (list: ${r.dnssec}, measured here: ${out.dnssec}): ${SKIP_DNSSEC.get(r.id)}`);
      else if (r.dnssec !== undefined && r.dnssec !== out.dnssec) out.notes.push(`dnssec is ${out.dnssec} (list: ${r.dnssec})`);
    } catch (e) {
      out.notes.push("checks: " + e.message);
    }
  }
  return out;
}));
for (const s of sessions.values()) s.close();

console.log("id".padEnd(12) + "doh".padStart(7) + "ip".padStart(7) + "  dnssec ecs  nx   egress");
for (const o of rows) {
  console.log(o.id.padEnd(12) + (o.doh || "–").padStart(7) + (o.ip || "–").padStart(7) + "  " + f(o.dnssec).padEnd(7) + f(o.ecs).padEnd(5) + f(o.nx).padEnd(5) + (o.egress || ""));
  for (const n of o.notes) { console.log("    ! " + n); bad++; }
  for (const n of o.skips) console.log("    skip: " + n);
}
console.log(bad ? `\n${bad} problem(s)` : "\nall ok");
process.exit(bad ? 1 : 0);
