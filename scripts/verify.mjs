#!/usr/bin/env node
// Checks every resolver the way the page uses it, over HTTP/2 like a browser, and checks what the list says about it:
//   - doh and ip answer a GET ?dns= query with 200 and a DNS message (a redirect, an error page or a timeout fails)
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
import { RESOLVERS, NXZONE, CHECKS } from "../src/resolvers.mjs";
import { dohURL, parse, randLabel, mixCase, RCODE } from "../src/dns.mjs";

// CleanBrowsing says it validates DNSSEC and did on some US GitHub runs, but from Tokyo and China its filter answers
// dnssec-failed.org itself (an address, no AD); one list value can't be right on both sides, so the list keeps what
// its visitors in Asia get and this check only reports. See 2026-11-11 in design.md.
const SKIP_DNSSEC = new Map([["cleanbrowsing", "its filter answers the test name itself from Asia, while some US GitHub runners saw it validate"]]);

const pick = process.argv.slice(2);
const list = pick.length ? RESOLVERS.filter(r => pick.includes(r.id)) : RESOLVERS;
const sessions = new Map();

function session(origin) {
  let s = sessions.get(origin);
  if (!s || s.closed || s.destroyed) {
    s = http2.connect(origin);
    s.on("error", () => {});
    sessions.set(origin, s);
  }
  return s;
}

// one GET: status, headers, body, ms
function get(url) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = session(u.origin).request({ ":method": "GET", ":path": u.pathname + u.search, accept: "application/dns-message", origin: "https://dns.1ms.dog" });
    const timer = setTimeout(() => { req.close(); reject(new Error("timeout")); }, 6000);
    let head = {};
    const chunks = [];
    req.on("response", h => { head = h; });
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      clearTimeout(timer);
      // a server can close the connection without answering (GOAWAY, RST_STREAM): say so instead of "HTTP undefined"
      if (!head[":status"]) return reject(new Error("no HTTP response"));
      resolve({ status: head[":status"], head, body: Buffer.concat(chunks), ms: performance.now() - t0 });
    });
    req.on("error", e => { clearTimeout(timer); reject(e); });
    req.end();
  });
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
  return { ...p, ms: r.ms, head: r.head, status: r.status };
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
