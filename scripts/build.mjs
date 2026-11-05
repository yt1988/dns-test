#!/usr/bin/env node
// Builds the static site in public/ from src/:
//   index.html, <lang>/index.html              the page per language, every resolver's row drawn in it
//   <id>/index.html, <lang>/<id>/index.html    a page per resolver and language: the same test, that resolver in the
//                                              hero, its addresses, facts and setup (src/about.mjs)
//   assets/app.<hash>.js, assets/app.<hash>.css the page's code (with the resolver list) and styles, shared by every language
//   assets/l.<lang>.<hash>.js                    the strings the browser code needs, per language
//   (assets/share/: the shared 1ms.dog share dialog, copied verbatim from 1ms-shell and committed, not built here)
//   og/<lang>.png                                link preview images: made by scripts/assets.mjs, committed, not here
//   rules/*                                     direct rules for proxy tools (src/rules.mjs)
//   resolvers.json                              the list for the command-line tool (github.com/yt1988/dns-test-cli)
//   sitemap.xml, robots.txt, llms.txt, _headers  SEO and security headers (CSP: every resolver the page asks)
// The Worker (src/worker.js: the command-line tool's installer and downloads) is deployed from source by wrangler.
// Usage: node scripts/build.mjs          write the files
//        node scripts/build.mjs --check  exit 1 if anything in public/ is out of date (CI)
import { mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build as bundle, transform } from "esbuild";
import { RESOLVERS, NAMES, NXZONE, CHECKS } from "../src/resolvers.mjs";
import { ruleSets } from "../src/rules.mjs";
import { ABOUT, local, titleOf } from "../src/about.mjs";
import { regionName } from "../src/region.mjs";

const SITE = (process.env.SITE_URL || "https://dns.1ms.dog").replace(/\/+$/, "");
const pub = new URL("../public/", import.meta.url), src = new URL("../src/", import.meta.url);
// language, URL folder, og:locale; the first is the root
export const LANGS = [["en", "", "en_US"], ["zh-CN", "zh-cn", "zh_CN"], ["zh-TW", "zh-tw", "zh_TW"], ["ja", "ja", "ja_JP"], ["ko", "ko", "ko_KR"],
  ["es", "es", "es_ES"], ["fr", "fr", "fr_FR"], ["de", "de", "de_DE"], ["pt", "pt", "pt_BR"], ["ru", "ru", "ru_RU"]];

// Runs before first paint: apply the saved theme. On the English root, send visitors to their language's page
// (a saved choice first, then the browser languages); crawlers, English readers and an embedded page stay.
const PREPAINT = `(function(){var d=document.documentElement,th=null,s=null;try{th=localStorage.getItem("dnstest:theme");s=localStorage.getItem("dnstest:lang")}catch(e){}if(th==="light"||th==="dark")d.setAttribute("data-theme",th);if(!d.hasAttribute("data-root")||/[?&]embed=/.test(location.search))return;var P=JSON.parse(d.getAttribute("data-paths")||"{}"),l=null;try{var q=new URLSearchParams(location.search).get("lang");if(P[q])l=q}catch(e){}if(!l&&P[s])l=s;for(var ls=navigator.languages||[navigator.language||"en"],i=0;!l&&!s&&i<ls.length;i++){var x=String(ls[i]).toLowerCase(),b=x.split("-")[0];l=b==="zh"?(/tw|hk|mo|hant/.test(x)?"zh-TW":"zh-CN"):P[b]?b:null}if(l&&l!=="en")location.replace(P[l]+location.search+location.hash)})();`;

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const hash = s => createHash("sha256").update(s).digest("hex").slice(0, 10);
const sha = s => createHash("sha256").update(s).digest("base64");

async function loadI18n() {
  const out = {};
  for (const f of (await readdir(new URL("i18n/", src))).filter(f => f.endsWith(".mjs")))
    out[f.slice(0, -4)] = (await import(new URL("i18n/" + f, src).href + "?" + Date.now())).default;
  return out;
}

// Strings only the build uses (the page already shows them); everything else goes to the browser. rp_: a resolver's
// own page and its help, all drawn here.
const BUILD_ONLY_SET = new Set(["name", "seo_title", "seo_desc", "seo_kw", "og_sub", "h1", "docs", "lang_label", "faq_h", "h_all", "docs_rp"]);
const BUILD_ONLY = k => BUILD_ONLY_SET.has(k) || k.startsWith("rp_");

// a page's path: the language's folder, then the resolver's (none: the test of them all)
// the end of every link that leaves this tool (GitHub, a resolver's site, another 1ms.dog tool): the site's
// external-link icon (1ms-shell docs/tool-contract.md, section 4); a next step inside the tool keeps its →
const EXT = '<svg class="ext" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 10v3.5H2.5V4H6"/></svg>';
const pathOf = (slug, id) => "/" + (slug ? slug + "/" : "") + (id ? id + "/" : "");
const fill = (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => k in v ? v[k] : m);

// Names in a language's sentences. Korean: a particle right after a name goes by how the name ends when read aloud
// (은/이/을/과 after a final consonant, 는/가/를/와 after a vowel); Hangul shows it, and the Latin names read with a final
// consonant are in KO_FIN (Google 구글, CZ.NIC ODVR …알). Chinese and Japanese: no space between a name in Chinese
// characters and the text around it (Latin names keep theirs).
const JOSA = [["은", "는"], ["이", "가"], ["을", "를"], ["과", "와"]];
const KO_FIN = new Set(["Google", "Quad9 Foundation", "Mullvad VPN", "Hurricane Electric", "Wikimedia Foundation", "CleanBrowsing",
  "Qihoo 360", "CZ.NIC", "CZ.NIC ODVR", "Applied Privacy Foundation", "DNS4ALL", "Tiarap", "DNS4EU (Whalebone)"]);
const josa = (s, v) => s.replace(/\{(\w+)\}(.)(?!\()/g, (m, k, ch) => {
  const p = JOSA.find(x => x.includes(ch));
  if (!p || typeof v[k] !== "string") return m;
  const c = v[k].charCodeAt(v[k].length - 1), fin = c >= 0xac00 && c <= 0xd7a3 ? (c - 0xac00) % 28 > 0 : KO_FIN.has(v[k]);
  return `{${k}}` + p[fin ? 0 : 1];
});
const tidy = (s, lang) => /^(zh|ja)/.test(lang) ? s.replace(/([　-鿿＀-￯]) (?=[㐀-鿿])|([㐀-鿿]) (?=[　-〿＀-￯])/g, "$1$2") : s;
const fillL = (lang, s, v) => tidy(fill(lang === "ko" ? josa(s, v) : s, v), lang);

// every origin the page asks: the resolvers' DoH hosts and the addresses used for the estimates
export const ORIGINS = [...new Set(RESOLVERS.flatMap(r => [r.doh, r.ip].filter(Boolean).map(u => new URL(u).origin)))];

// the command-line dialog: how to install and run dnstest, every command a button that copies it
function cliDlg(T) {
  const line = (cmd, note) => `<button class="cmdline" type="button" data-copy title="${esc(T("copy"))}"><code>${esc(cmd)}</code><svg class="cp" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/></svg><svg class="ok" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg></button>` + (note ? `<span class="note">${esc(note)}</span>` : "");
  const sec = (h, body) => `<section class="rblk"><b>${esc(T(h))}</b>${body}</section>`;
  const win = `${SITE}/dl/latest/dnstest-windows-amd64.exe`;
  return [
    sec("cli_install", line(`curl -fsSL ${SITE}/i | sh`, T("cli_install_s"))),
    sec("cli_once", line(`curl -fsSL ${SITE}/i | sh -s -- run`)),
    sec("cli_wget", line(`wget -qO- ${SITE}/i | sh`)),
    sec("cli_opts", line("dnstest -p udp,dot,doq", T("cli_o_proto")) + line("dnstest -r cloudflare,google,alidns", T("cli_o_res")) +
      line("dnstest -6", T("cli_o_v6")) + line("dnstest --json > dns.json", T("cli_o_json"))),
    sec("cli_win", line(`irm ${SITE}/i.ps1 | iex`, T("cli_win_s")) + `<a class="dl" href="${esc(win)}">dnstest-windows-amd64.exe ↓</a>`),
    `<a class="cli-gh" href="https://github.com/yt1988/dns-test-cli" target="_blank" rel="noopener noreferrer"><svg class="gh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 .2a8 8 0 0 0-2.5 15.6c.4 0 .5-.2.5-.4v-1.5c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.3 1.9.9 2.4.7 0-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.4 7.4 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.1 0 3.1-1.9 3.7-3.6 3.9.3.3.6.8.6 1.5v2.2c0 .2.1.5.6.4A8 8 0 0 0 8 .2z"/></svg>${esc(T("cli_src"))}${EXT}</a>`,
  ].join("");
}

// what to enter to use a resolver, as <dt>/<dd> pairs: under its row, and on its own page
function addrRows(r, T) {
  const kv = (k, v) => `<dt>${esc(k)}</dt><dd>${v}</dd>`;
  const code = a => a.map(x => `<code>${esc(x)}</code>`).join(" ");
  return [
    r.udp && kv("DNS (IPv4)", code(r.udp)),
    r.udp6 && kv("DNS (IPv6)", code(r.udp6)),
    r.dot && kv(T("d_dot"), code([r.dot])),
    kv("DoH", code([r.doh])),
    r.doq && kv("DoQ", code(["quic://" + r.doq])),
  ].filter(Boolean).join("");
}

// one row per resolver, drawn before any answer; the details under it say what to enter to use it, and link to its page.
// On a resolver's own page its row is marked.
function rowsHTML(T, lang, slug, focus) {
  const proto = r => [r.udp && "UDP", r.dot && "DoT", "DoH", r.doq && "DoQ"].filter(Boolean).map(p => `<i>${p}</i>`).join("");
  return RESOLVERS.map(r => {
    const d = addrRows(r, T) + (r.blocks ? `<dt>${esc(T("d_blocks"))}</dt><dd>${esc(T("blocks_" + r.blocks))}</dd>` : "");
    const cell = c => `<span class="v" data-c="${c}"></span>`;
    const page = r.id === focus ? "" : `<a href="${pathOf(slug, r.id)}">${esc(fillL(lang, T("rp_page"), { name: titleOf(r, lang) }))} →</a>`;
    return `<div class="tr wait${r.id === focus ? " me" : ""}" data-r="${r.id}" role="button" tabindex="0" aria-expanded="false"><span class="rk"></span>` +
      `<span class="nm"><img class="ic" src="/icons/${r.id}.png" width="18" height="18" alt="" loading="lazy" decoding="async"><b>${esc(r.name)}</b><span class="pp">${proto(r)}</span></span>` +
      cell("doh") + cell("udp") + cell("dot") + cell("unc") + `<span class="v sec">${r.dnssec ? '<b class="ok">✓</b>' : '<span class="m">–</span>'}</span></div>` +
      `<div class="td" data-d="${r.id}" hidden><dl>${d}</dl><span class="td-l">${page}<a class="xl" href="${esc(r.site)}" target="_blank" rel="noopener noreferrer">${esc(T("d_site"))}${EXT}</a></span></div>`;
  }).join("\n");
}

// A resolver's page tests only that one, so in place of the list: the other pages of its kind (global, mainland China,
// regional), names and links only; the home page links every one. `links`: the list card's links to other tools.
function moreCard(T, lang, slug, focus, links) {
  const me = RESOLVERS.find(r => r.id === focus);
  return `<section class="res card">
      <div class="res-h"><h2 id="rsNavH">${esc(T("rp_more_h"))}</h2><span class="res-l">${links}</span></div>
      <nav class="rs-nav more" aria-labelledby="rsNavH"><ul>` + RESOLVERS.filter(r => r.group === me.group && r !== me).map(r =>
    `<li><a href="${pathOf(slug, r.id)}"><img src="/icons/${r.id}.png" width="14" height="14" alt="" loading="lazy" decoding="async">${esc(titleOf(r, lang))}</a></li>`).join("") + "</ul></nav>\n    </section>";
}

// The status page's main (src/status.js fills it from the Tokyo watch, server/watch): every resolver with each of its
// protocols now, its last 24 hours, the share that answered over a day, a week and a month; then the outages
const PROTO_N = { udp: "UDP", udp6: "IPv6", dot: "DoT", doh: "DoH", doq: "DoQ" };
function statusMain(T, lang, slug) {
  const th = `<thead><tr><th>DNS</th><th class="bar24">${esc(T("sp_c_24"))}</th><th class="u">${esc(T("sp_c_up24"))}</th><th class="u u7">${esc(T("sp_c_up7"))}</th><th class="u u30">${esc(T("sp_c_up30"))}</th></tr></thead>`;
  const tr = r => `<tr data-id="${r.id}" data-name="${esc(r.name)}"><td class="sn"><a href="${pathOf(slug, r.id)}"><img src="/icons/${r.id}.png" width="16" height="16" alt="" loading="lazy" decoding="async">${esc(r.name)}</a>` +
    `<span class="now">${["udp", "udp6", "dot", "doh", "doq"].filter(p => p === "doh" || r[p]).map(p => `<span class="pc">${PROTO_N[p]}</span>`).join("")}</span></td>` +
    `<td class="bar24"></td><td class="u24">–</td><td class="u7">–</td><td class="u30">–</td></tr>`;
  return `
    <section class="hero card stp-h">
      <div class="st-h"><h1>${esc(T("sp_h1"))}</h1><div class="st-top"><p class="st-sum" id="stSum"></p><p class="st-meta" id="stMeta">${esc(T("sp_wait"))}</p></div></div>
      <p class="intro">${esc(T("sp_intro"))}</p>
      <p class="st-key"><i class="s-o"></i>${esc(T("sp_ok"))}<i class="s-d"></i>${esc(T("sp_part"))}<i class="s-b"></i>${esc(T("sp_bad"))}<i></i>${esc(T("sp_cell"))}</p>
    </section>
    <section class="card stp" id="stTable"><table class="stt">${th}<tbody>${RESOLVERS.map(tr).join("")}</tbody></table></section>
    <section class="card stp"><h2>${esc(T("sp_out_h"))}</h2><ul class="st-out" id="stOut"><li class="m">${esc(T("sp_wait"))}</li></ul>
      <p class="all-l"><a class="btn all" href="${pathOf(slug)}">${esc(fillL(lang, T("f_all"), { n: RESOLVERS.length }))}</a></p></section>
`;
}

// Every resolver's page, linked from every page under the list: how search engines (and people) find them
function resNav(T, lang, slug, focus) {
  return `<nav class="rs-nav" aria-labelledby="rsNavH"><h3 id="rsNavH">${esc(T("rp_all_h"))}</h3><ul>` + RESOLVERS.map(r =>
    `<li><a href="${pathOf(slug, r.id)}"${r.id === focus ? ' aria-current="page"' : ""}><img src="/icons/${r.id}.png" width="14" height="14" alt="" loading="lazy" decoding="async">${esc(titleOf(r, lang))}</a></li>`).join("") + "</ul></nav>";
}

// A resolver's own help entries, in front of the general ones: what it is, its addresses, how to set it up on each
// system, mainland China, the one it is compared with, and why it may be slow. Each is HTML for the page and plain
// text for the FAQ data. A value given as a list is drawn as <code>s, joined the language's way.
function resolverDocs(r, T, lang, slug) {
  const a = ABOUT[r.id], name = titleOf(r, lang), J = T("v_join"), sp = /^(zh|ja)/.test(lang) ? "" : " ";
  const country = cc => cc ? regionName(cc, lang) : "";
  const V = v => v && v.h != null ? v : Array.isArray(v) ? { h: v.map(x => `<code>${esc(x)}</code>`).join(esc(J)), t: v.join(J) } : { h: esc(v), t: v };
  const P = (k, vars = {}) => {
    const s = lang === "ko" ? josa(T(k), vars) : T(k), sub = (str, f) => tidy(str.replace(/\{(\w+)\}/g, (m, n) => n in vars ? V(vars[n])[f] : m), lang);
    return { h: sub(esc(s), "h"), t: sub(s, "t") };
  };
  const join = ps => ({ h: ps.map(p => p.h).join(sp), t: ps.map(p => p.t).join(sp) });
  const hq = a.hq || r.cc, enc = [r.dot && "DoT", "DoH", r.doq && "DoQ"].filter(Boolean).join(J), doh = [r.doh], ips = r.udp || [];

  const what = [
    join([
      P(hq ? "rp_a_run_cc" : "rp_a_run", { name, org: local(a.org, lang), country: country(hq) }),
      r.udp ? P("rp_a_udp", { ips, v6: r.udp6 ? P("rp_a_v6", { ips: r.udp6 }) : "", enc }) : P("rp_a_noudp", { enc }),
      P(r.group === "global" ? "rp_a_global" : r.group === "cn" ? "rp_a_cnsite" : "rp_a_region", { region: country(r.cc) }),
    ]),
    join([
      P(r.dnssec ? "rp_a_sec1" : "rp_a_sec0"),
      r.blocks ? P("rp_a_blocks", { what: T("blocks_" + r.blocks) }) : P("rp_a_open"),
      ...(a.tags || []).map(x => P("rp_a_" + x)),
    ]),
  ];
  const addr = [P("rp_a_addr", { name }), ...[
    r.udp && ["DNS (IPv4)", r.udp], r.udp6 && ["DNS (IPv6)", r.udp6], r.dot && [T("d_dot"), [r.dot]], ["DoH", doh], r.doq && ["DoQ", ["quic://" + r.doq]],
  ].filter(Boolean).map(([k, v]) => ({ h: `<b>${esc(k)}</b> ${V(v).h}`, t: `${k}: ${V(v).t}` }))];
  const setup = [
    ["rp_h_win", r.udp ? P("rp_s_win", { ips, doh }) : P("rp_s_win0", { name })],
    ["rp_h_mac", r.udp ? P("rp_s_mac", { ips, doh }) : P("rp_s_mac0", { doh })],
    ["rp_h_ios", r.udp ? P("rp_s_ios", { ips, doh }) : P("rp_s_ios0", { doh })],
    ["rp_h_and", r.dot ? P("rp_s_and", { dot: [r.dot] }) : r.udp ? P("rp_s_and_ip", { name, ips }) : P("rp_s_and_none", { name })],
    ["rp_h_router", r.udp ? P("rp_s_router", { ips }) : P("rp_s_router0", { name, doh })],
    ["rp_h_browser", P("rp_s_browser", { doh })],
    r.udp && ["rp_h_linux", join([P("rp_s_linux", { ips: [r.udp.join(" ")] }), ...(r.dot ? [P("rp_s_linux_dot", { ex: [`${r.udp[0]}#${r.dot}`] })] : [])])],
  ].filter(Boolean).map(([k, p]) => ({ h: `<h4>${esc(T(k))}</h4><p>${p.h}</p>`, t: `${T(k)}: ${p.t}`, block: true }));
  const other = RESOLVERS.find(x => x.id === a.vs), otherName = titleOf(other, lang);
  // this page tests only it: the way to the test of them all, and to the other one's page
  const vs = [P("rp_a_vs", { name }), { h: `<a href="${pathOf(slug)}">${esc(fillL(lang, T("f_all"), { n: RESOLVERS.length }))} →</a>`, t: "" },
    { h: `<a href="${pathOf(slug, other.id)}">${esc(fillL(lang, T("rp_page"), { name: otherName }))} →</a>`, t: "" }];

  const doc = (q, ps) => ({ q, h: ps.map(p => p.block ? p.h : `<p>${p.h}</p>`).join(""), t: ps.map(p => p.t).filter(Boolean).join(sp) });
  return [
    doc(fillL(lang, T("rp_q_what"), { name }), what),
    // a name that already ends in DNS ("Google Public DNS") doesn't get a second one
    doc(fillL(lang, T(/DNS$/.test(name) ? "rp_q_addr_dns" : "rp_q_addr"), { name }), addr),
    doc(fillL(lang, T("rp_q_setup"), { name }), setup),
    doc(fillL(lang, T("rp_q_cn"), { name }), [P(r.group === "cn" ? "rp_a_cn_in" : "rp_a_cn_out")]),
    doc(fillL(lang, T("rp_q_vs"), { name, other: otherName }), vs),
    doc(fillL(lang, T("rp_q_slow"), { name }), [P("rp_a_slow")]),
  ];
}
// the help entry with the setup steps, which the page's "How to set it up" button opens
const SETUP_DOC = 2;

// on a resolver's page, under the hero: its addresses and the facts about it
function addrCard(r, T, lang) {
  const a = ABOUT[r.id], hq = a.hq || r.cc, name = titleOf(r, lang);
  const facts = [
    [T("rp_k_org"), local(a.org, lang)],
    hq && [T("rp_k_hq"), regionName(hq, lang)],
    a.as && [T("rp_k_as"), `<span data-asn="${a.as}">AS${a.as}</span>`, true],
    ["DNSSEC", r.dnssec ? "✓" : "–"],
    [T("d_blocks"), r.blocks ? T("blocks_" + r.blocks) : T("rp_none")],
  ].filter(Boolean).map(([k, v, html]) => `<li><span>${esc(k)}</span>${html ? v : esc(v)}</li>`).join("");
  return `<section class="addr card">
      <div class="addr-h"><h2>${esc(fillL(lang, T("rp_addr_h"), { name }))}</h2><span class="addr-acts"><button class="btn sm" type="button" data-help="${SETUP_DOC}">${esc(T("rp_setup_btn"))}</button><a class="btn sm xl" href="${esc(r.site)}" target="_blank" rel="noopener noreferrer">${esc(T("d_site"))}${EXT}</a></span></div>
      <dl class="addr-l">${addrRows(r, T)}</dl>
      <ul class="facts">${facts}</ul>
      <a class="next xl" id="leakLink" hidden target="_blank" rel="noopener">${esc(T("rp_leak"))}${EXT}</a>
    </section>
`;
}

// The list as the command-line tool reads it: every way to reach each resolver, which the tool measures for real
// (UDP, TCP, DoT, DoH, DoQ). It looks up host names itself, so only names and URLs are given.
export function resolversJSON() {
  const ep = (k, v) => v ? { [k]: v } : undefined;
  const list = RESOLVERS.map(r => Object.fromEntries(Object.entries({
    id: r.id, name: r.name, group: r.group, cc: r.cc, site: r.site, udp: r.udp, udp6: r.udp6,
    dot: ep("host", r.dot), doh: ep("url", r.doh), doq: ep("host", r.doq), dnssec: r.dnssec, blocks: r.blocks,
  }).filter(([, v]) => v !== undefined)));
  return JSON.stringify({ version: 1, names: NAMES, nxzone: NXZONE,
    checks: { dnssec_bad: CHECKS.dnssecBad, dnssec_good: CHECKS.dnssecGood, ecs: CHECKS.ecs }, resolvers: list }, null, 1) + "\n";
}

export async function build({ check = false } = {}) {
  const I = await loadI18n(), en = I.en;
  const langs = LANGS.filter(([l]) => I[l]);
  for (const [l] of langs) for (const k of Object.keys(en)) if (!(k in I[l])) throw new Error(`i18n/${l}.mjs is missing "${k}"`);
  const tpl = await readFile(new URL("page.html", src), "utf8");

  const root = fileURLToPath(new URL("..", import.meta.url));
  const js = (await bundle({ entryPoints: [fileURLToPath(new URL("app.js", src))], bundle: true, minify: true, format: "iife", target: "es2020",
    legalComments: "none", write: false, absWorkingDir: root,
    // the share dialog is loaded from the site when someone shares, never bundled (1ms-shell compares the copy)
    external: ["/assets/share/*"] })).outputFiles[0].text;
  const cssFull = (await Promise.all(["fonts.css", "base.css", "style.css"].map(f => readFile(new URL(f, src), "utf8")))).join("\n");
  const css = (await transform(cssFull, { loader: "css", minify: true, legalComments: "none" })).code;
  const jsName = `app.${hash(js)}.js`, cssName = `app.${hash(css)}.css`;
  // the status page's own script (it doesn't test)
  const stJs = (await transform(await readFile(new URL("status.js", src), "utf8"), { loader: "js", minify: true, target: "es2020", legalComments: "none" })).code;
  const stName = `status.${hash(stJs)}.js`;
  const files = { ["assets/" + jsName]: js, ["assets/" + cssName]: css, ["assets/" + stName]: stJs };

  // the pages: per language, the test of them all, one page per resolver (pathOf), and the status page
  const PAGES = [null, ...RESOLVERS.map(r => r.id), "status"];
  for (const [lang, slug, locale] of langs) {
    // {n} in the two descriptions is the number of resolvers, filled here so it never goes stale
    const d = I[lang], T = k => { if (!(k in d)) throw new Error(`i18n/${lang}.mjs has no "${k}"`); return k === "seo_desc" || k === "og_sub" ? d[k].split("{n}").join(RESOLVERS.length) : d[k]; };
    // English's keys, and the plural forms only some languages have (Russian's _few, _many)
    const keys = [...Object.keys(en), ...Object.keys(d).filter(k => !(k in en) && /_(zero|two|few|many)$/.test(k))];
    const strings = Object.fromEntries(keys.filter(k => !BUILD_ONLY(k)).map(k => [k, T(k)]));
    const sjs = `window.L1MS=${JSON.stringify(strings).replace(/</g, "\\u003c")};\n`;
    const sName = `l.${lang.toLowerCase()}.${hash(sjs)}.js`;
    files["assets/" + sName] = sjs;
    const docOf = (q, ps) => ({ q, h: ps.map(p => `<p>${esc(p)}</p>`).join(""), t: ps.join(" ") });
    const general = T("docs").map(([q, a]) => docOf(q, a.split(/\n+/)));
    // on a resolver's page, without what speaks of the home page's list: hidden (null), or its reworded question and
    // paragraphs (docs_rp)
    const generalRp = T("docs").flatMap(([q, a], i) => {
      const o = T("docs_rp")[i];
      if (o === null) return [];
      const ps = a.split(/\n+/);
      if (o) for (const n in o.p) { if (!ps[n]) throw new Error(`i18n/${lang}.mjs docs_rp ${i}: no paragraph ${n}`); ps[n] = o.p[n]; }
      return [docOf(o && o.q || q, ps)];
    });

    for (const focus of PAGES) {
    const ST = focus === "status", r = !ST && focus && RESOLVERS.find(x => x.id === focus), name = r && titleOf(r, lang);
    const url = SITE + pathOf(slug, focus);
    // a resolver's page asks its own questions first; the FAQ data has only those, the test page all the general ones
    const own = r ? resolverDocs(r, T, lang, slug) : [], docs = r ? [...own, ...generalRp] : general;
    const title = ST ? T("sp_title") : r ? fillL(lang, T("rp_title"), { name, ip: r.udp ? fillL(lang, T("rp_ip"), { ip: r.udp[0] }) : "", protos: ["DoH", r.dot && "DoT"].filter(Boolean).join("/") }) : T("seo_title");
    const desc = ST ? T("sp_desc") : r ? fillL(lang, T("rp_desc"), { name, n: RESOLVERS.length }) : T("seo_desc");
    const kw = r ? [fillL(lang, T("rp_kw"), { name }), ...(r.udp || []), r.dot, name !== r.name && r.name].filter(Boolean).join(", ") : T("seo_kw");
    const h1 = ST ? T("sp_h1") : r ? fillL(lang, T("rp_h1"), { name }) : T("h1");
    const alts = langs.map(([l, sl]) => `<link rel="alternate" hreflang="${l}" href="${SITE + pathOf(sl, focus)}">`).join("\n") + `\n<link rel="alternate" hreflang="x-default" href="${SITE + pathOf("", focus)}">`;
    const graph = ST ? [{ "@type": "WebPage", name: title, url, description: desc, inLanguage: lang }] : [
      { "@type": "WebApplication", name: (r ? h1 : T("app_name")) + " · 1ms.dog", url, applicationCategory: "UtilitiesApplication", operatingSystem: "Any",
        browserRequirements: "Requires JavaScript", description: desc, inLanguage: lang, isAccessibleForFree: true,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" } },
      { "@type": "FAQPage", mainEntity: (r ? own : general).map(x => ({ "@type": "Question", name: x.q, acceptedAnswer: { "@type": "Answer", text: x.t } })) },
      ...(r ? [{ "@type": "BreadcrumbList", itemListElement: [
        { "@type": "ListItem", position: 1, name: T("app_name"), item: SITE + pathOf(slug) },
        { "@type": "ListItem", position: 2, name: h1, item: url }] }] : []),
    ];
    const head = [
      `<title>${esc(title)}</title>`,
      `<meta name="description" content="${esc(desc)}">`,
      `<meta name="keywords" content="${esc(kw)}">`,
      ...(lang === "zh-CN" ? [`<meta http-equiv="Cache-Control" content="no-transform">`, `<meta http-equiv="Cache-Control" content="no-siteapp">`, `<meta name="applicable-device" content="pc,mobile">`] : []),
      `<meta name="robots" content="index, follow, max-image-preview:large">`,
      `<meta name="application-name" content="${esc(T("app_name"))}">`,
      `<meta name="theme-color" content="#f6f6f7" media="(prefers-color-scheme: light)">`,
      `<meta name="theme-color" content="#1c1c1c" media="(prefers-color-scheme: dark)">`,
      `<link rel="canonical" href="${url}">`, alts,
      `<link rel="icon" href="/favicon.ico" sizes="any">`, `<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">`, `<link rel="apple-touch-icon" href="/apple-touch-icon.png">`,
      // the resolvers' connections start while the page loads
      ...(ST ? [] : ORIGINS.slice(0, 6).map(o => `<link rel="preconnect" href="${o}" crossorigin>`)),
      `<meta property="og:type" content="website">`, `<meta property="og:site_name" content="1ms.dog">`,
      `<meta property="og:title" content="${esc(title)}">`, `<meta property="og:description" content="${esc(r ? desc : T("og_sub"))}">`, `<meta property="og:url" content="${url}">`,
      `<meta property="og:locale" content="${locale}">`,
      `<meta property="og:image" content="${SITE}/og/${lang.toLowerCase()}.png">`, `<meta property="og:image:width" content="1200">`, `<meta property="og:image:height" content="630">`,
      `<meta property="og:image:alt" content="${esc(title)}">`,
      `<meta name="twitter:card" content="summary_large_image">`, `<meta name="twitter:image" content="${SITE}/og/${lang.toLowerCase()}.png">`,
      `<meta name="twitter:title" content="${esc(title)}">`, `<meta name="twitter:description" content="${esc(r ? desc : T("og_sub"))}">`,
      `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c")}</script>`,
    ].join("\n");

    const helpNav = docs.map((x, i) => `<button type="button" role="tab" data-hq="${i}" aria-selected="${i === 0}">${esc(x.q)}</button>`).join("");
    const helpC = docs.map((x, i) => `<article data-hqb="${i}"${i ? " hidden" : ""}><h3>${esc(x.q)}</h3>${x.h}</article>`).join("");
    const langOpts = langs.map(([l]) => `<option value="${l}"${l === lang ? " selected" : ""}>${esc(I[l].name)}</option>`).join("");
    const paths = Object.fromEntries(langs.map(([l, sl]) => [l, pathOf(sl, focus)]));
    // the install line: on a resolver's page, run once against it and the one it is compared with
    const cliCmd = `curl -fsSL ${SITE}/i | sh` + (r ? ` -s -- run -r ${r.id},${ABOUT[r.id].vs}` : "");

    // "Are these resolvers up?": the status page, beside the list's other links (on a resolver's page, in its card)
    const stLink = `<a class="who st-l" href="${pathOf(slug, "status")}"><span>${esc(T("sp_link"))}</span></a>`;
    // the status page: the same header and help around its own main and script
    const base = ST ? tpl.replace(/<main>[\s\S]*<\/main>/, () => "<main>" + statusMain(T, lang, slug) + "  </main>").replace("{{js}}", stName) : tpl;
    const html = base
      .replace("{{stLink}}", stLink)
      .replace(/(<(\w+)\b[^>]*\sdata-i="(\w+)"[^>]*>)([^<]*)(<\/\2>)/g, (m, open, tag, k, inner, close) => open + esc(T(k)) + close)
      .replace(/\{\{a:(\w+)\}\}/g, (m, k) => esc(T(k)))   // translated attribute values (aria-label, tooltips)
      .replace(/\{\{(c_\w+)\}\}/g, (m, k) => esc(T(k)))   // column heads that carry a tooltip
      .replace("{{lang}}", lang).replace("{{pathsAttr}}", esc(JSON.stringify(paths))).replace("{{rootAttr}}", slug ? "" : " data-root")
      .replace("{{prepaint}}", PREPAINT).replace("{{head}}", head).replace("{{css}}", cssName).replace("{{js}}", jsName).replace("{{strings}}", sName)
      .split("{{homeHref}}").join(pathOf(slug)).replace("{{langOpts}}", langOpts).replace("{{h1}}", esc(h1))
      // a resolver's page names it in the hero from the start
      .replace("{{winK}}", esc(T(r ? "f_run" : "best_k"))).replace("{{winIcAttr}}", r ? ` style="background-image:url(/icons/${r.id}.png)"` : "")
      .replace("{{winName}}", r ? esc(r.name) : '<i class="skl"></i>').replace("{{addrCard}}", r ? addrCard(r, T, lang) : "")
      .replace(/<section class="res card">[\s\S]*?<\/section>/, m => r ? moreCard(T, lang, slug, focus, (/<a [^>]*id="speedLink"[\s\S]*?<\/a>/.exec(m) || [""])[0] + stLink) : m)
      .replace("{{rows}}", rowsHTML(T, lang, slug, focus)).replace("{{resNav}}", resNav(T, lang, slug, focus))
      // a resolver's page: the way to the home page's test of them all, under its own result
      .replace("{{allLink}}", r ? `<a class="btn all" id="allLink" href="${pathOf(slug)}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h7"/></svg>${esc(fillL(lang, T("f_all"), { n: RESOLVERS.length }))}</a>` : "")
      .replace("{{cliCmd}}", esc(cliCmd)).replace("{{cliDlg}}", cliDlg(T))
      .replace("{{helpNav}}", helpNav).replace("{{helpC}}", helpC)
      .replace("{{data}}", JSON.stringify({ lang, paths, home: pathOf(slug), focus }).replace(/</g, "\\u003c"));
    if (/\{\{[\w:]+\}\}/.test(html)) throw new Error("unfilled placeholder in " + pathOf(slug, focus) + ": " + /\{\{[\w:]+\}\}/.exec(html)[0]);
    files[pathOf(slug, focus).slice(1) + "index.html"] = html;
    }
  }

  files["sitemap.xml"] = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
    PAGES.flatMap(id => langs.map(([, s]) => `  <url>\n    <loc>${SITE + pathOf(s, id)}</loc>\n` +
      langs.map(([l, s2]) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${SITE + pathOf(s2, id)}"/>`).join("\n") +
      `\n    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE + pathOf("", id)}"/>\n  </url>`)).join("\n") + "\n</urlset>\n";
  for (const [name, text] of Object.entries(ruleSets(SITE))) files["rules/" + name] = text;
  files["resolvers.json"] = resolversJSON();
  files["robots.txt"] = `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`;
  files["llms.txt"] = `# ${en.app_name} · 1ms.dog

> Free DNS speed test in the browser. Times ${RESOLVERS.length} public DNS resolvers (${RESOLVERS.map(r => r.name).join(", ")})
> from the visitor's own network: DNS over HTTPS measured for real on a warm connection (10 rounds, interleaved,
> median), UDP and DoT estimated by timing the same servers' addresses, plus uncached lookups and DNSSEC validation.
> Shows the fastest resolver and what to enter to use it. Test queries go straight from the browser to each resolver;
> to show which resolver the device really uses, it also looks up random names under l.1ms.dog, 1ms.dog's own
> authoritative DNS, which keeps the asking resolver's address and the ECS subnet in memory for 2 minutes, no logs.
> Status of every resolver from Tokyo: ${SITE}/status/

- Page: ${SITE}/ (also ${langs.slice(1).map(([, s]) => "/" + s + "/").join(", ")})
- One page per resolver (its addresses, facts, how to set it up, and the same test with it in front): ${RESOLVERS.map(r => SITE + pathOf("", r.id)).join(", ")}; in other languages under the language's folder (/zh-cn/cloudflare/)
- Direct rules for proxy tools (so the test measures your own network): ${SITE}/rules/clash.yaml, surge.list, loon.list, quanx.list, singbox.json
- Source code and the resolver list: https://github.com/yt1988/dns-test

`;
  // The only inline script is the pre-paint snippet, identical on every page: one hash covers the site.
  const csp = ["default-src 'self'", `script-src 'self' 'sha256-${sha(PREPAINT)}'`, "style-src 'self' 'unsafe-inline'", "font-src 'self'", "img-src 'self' data:",
    // and 1ms.dog's own authoritative DNS and its results API (src/app.js: the resolver this device really uses)
    "connect-src 'self' " + ORIGINS.join(" ") + " https://*.l.1ms.dog:2053 https://data.1ms.dog:2083",   // and the Tokyo watch's results (src/status.js)
    "manifest-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join("; ");
  files["_headers"] = `# Generated by scripts/build.mjs
/*
  Content-Security-Policy: ${csp}
  Referrer-Policy: strict-origin-when-cross-origin
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Cross-Origin-Opener-Policy: same-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()
/assets/*
  Cache-Control: public, max-age=604800
/assets/app.*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
/assets/status.*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
/assets/l.*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
/assets/share/*
  ! Cache-Control
  Cache-Control: public, max-age=0, must-revalidate
/assets/fonts/*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
/icons/*
  Cache-Control: public, max-age=2592000
/og/*
  Cache-Control: public, max-age=604800
/resolvers.json
  Access-Control-Allow-Origin: *
  Cache-Control: public, max-age=3600
/rules/*
  Access-Control-Allow-Origin: *
  Cache-Control: public, max-age=3600
/rules/*.json
  Content-Type: application/json; charset=utf-8
/rules/*.yaml
  Content-Type: text/plain; charset=utf-8
/rules/*.list
  Content-Type: text/plain; charset=utf-8
/llms.txt
  Access-Control-Allow-Origin: *
  Content-Type: text/plain; charset=utf-8
`;

  // generated files that are no longer produced (old hashes) are stale too
  const gen = async () => (await readdir(new URL("assets/", pub))).filter(f => /^(app|l|status)\..+\.(js|css)$/.test(f)).map(f => "assets/" + f);
  const stale = [];
  for (const [f, body] of Object.entries(files)) {
    let cur = null; try { cur = await readFile(new URL(f, pub), "utf8"); } catch (e) {}
    if (cur !== body) stale.push(f);
  }
  const orphans = (await gen()).filter(f => !(f in files));
  if (check) return [...stale, ...orphans];
  for (const f of stale) { await mkdir(new URL(".", new URL(f, pub)), { recursive: true }); await writeFile(new URL(f, pub), files[f]); }
  for (const f of orphans) await rm(new URL(f, pub));
  return [...stale, ...orphans];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes("--check");
  const changed = await build({ check });
  if (check && changed.length) { console.error("public/ is out of date: " + changed.join(", ") + "\nRun npm run build and commit public/."); process.exit(1); }
  console.log(check ? "public/ is up to date" : changed.length ? "wrote " + changed.join(", ") : "nothing to do");
}
