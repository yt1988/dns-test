// Every resolver's own page, in every language: its own title, description, heading and questions, a canonical to
// itself, the other languages as alternates, a link back to the test of them all, and the sitemap lists them all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { LANGS } from "../scripts/build.mjs";
import { RESOLVERS } from "../src/resolvers.mjs";
import { ABOUT, titleOf } from "../src/about.mjs";

const SITE = "https://dns.1ms.dog";
const path = (slug, id) => "/" + (slug ? slug + "/" : "") + (id ? id + "/" : "");
const page = (slug, id) => readFile(new URL(`../public${path(slug, id)}index.html`, import.meta.url), "utf8");
const one = (h, re) => (re.exec(h) || [])[1];

test("every resolver has what its page says about it", () => {
  for (const r of RESOLVERS) {
    const a = ABOUT[r.id];
    assert.ok(a && a.org, r.id + ": operator");
    assert.ok(RESOLVERS.some(x => x.id === a.vs) && a.vs !== r.id, r.id + ": compared with another resolver on the list");
    for (const t of a.tags || []) assert.ok(["nonprofit", "nolog", "account"].includes(t), r.id + ": tag " + t);
  }
  assert.equal(Object.keys(ABOUT).length, RESOLVERS.length, "nothing about resolvers that aren't on the list");
});

test("every resolver's page, in every language, is its own", async () => {
  for (const [lang, slug] of LANGS) {
    const titles = new Set(), descs = new Set();
    for (const r of RESOLVERS) {
      const h = await page(slug, r.id), where = `${lang} ${r.id}`;
      const title = one(h, /<title>(.*?)<\/title>/), desc = one(h, /<meta name="description" content="(.*?)">/);
      assert.ok(!titles.has(title) && !descs.has(desc), where + ": title and description of its own");
      titles.add(title); descs.add(desc);
      assert.ok(!/\{\{[\w:]+\}\}|\{\w+\}/.test(h.replace(/<script type="application\/json".*?<\/script>/s, "")), where + ": unfilled placeholder");
      assert.equal(one(h, /<link rel="canonical" href="(.*?)">/), SITE + path(slug, r.id), where + ": canonical");
      for (const [l, s] of LANGS) assert.ok(h.includes(`hreflang="${l}" href="${SITE + path(s, r.id)}"`), where + ": alternate " + l);
      assert.ok(h.includes(`hreflang="x-default" href="${SITE + path("", r.id)}"`), where + ": x-default");
      assert.ok(h.includes(`<html lang="${lang}"`), where + ": language");
      // the hero names it from the start, its addresses are on the page; no list of the others (the page tests only it),
      // and the way to the test of them all under its result
      assert.ok(one(h, /<h1>(.*?)<\/h1>/).includes(titleOf(r, lang).replace(/&/g, "&amp;")), where + ": heading names it");
      assert.ok(h.includes(`<b id="winName">${r.name}</b>`), where + ": hero");
      assert.ok(!h.includes('<div class="tr ') && !h.includes('id="tbl"'), where + ": no list of every resolver");
      assert.ok(h.includes(`<a class="btn all" id="allLink" href="${path(slug)}">`), where + ": the test of them all");
      assert.ok(h.includes(`<code>${r.doh}</code>`) && (!r.udp || h.includes(`<code>${r.udp[0]}</code>`)), where + ": addresses");
      assert.ok(h.includes(`-r ${r.id},${ABOUT[r.id].vs}</code>`), where + ": the command line tests it");
      // where to go next: the DNS leak check once it is set up, its network on ASN Lookup, the speed test (the page fills
      // their addresses from the shell's meta tags)
      assert.ok(h.includes("id=\"leakLink\"") && h.includes("id=\"speedLink\""), where + ": leak check and speed test links");
      if (ABOUT[r.id].as) assert.ok(h.includes(`<span data-asn="${ABOUT[r.id].as}">AS${ABOUT[r.id].as}</span>`), where + ": its AS number");
      // its questions first, in the FAQ data too; the way back to the test of them all and on to the others
      const ld = JSON.parse(one(h, /<script type="application\/ld\+json">(.*?)<\/script>/));
      const faq = ld["@graph"].find(x => x["@type"] === "FAQPage").mainEntity;
      assert.equal(faq.length, 6, where + ": its own questions");
      assert.ok(faq.every(q => q.acceptedAnswer.text.length > 40), where + ": answers");
      assert.ok(ld["@graph"].some(x => x["@type"] === "BreadcrumbList"), where + ": breadcrumb");
      assert.ok(h.includes(`<a class="brand" href="${path(slug)}"`), where + ": link to the test of them all");
      assert.ok(h.includes(`href="${path(slug, ABOUT[r.id].vs)}"`), where + ": link to the one it is compared with");
      assert.equal((h.match(/<li><a href="\/[^"]*"/g) || []).length, RESOLVERS.filter(x => x.group === r.group).length - 1, where + ": links to the others of its kind");
      // every image has its size (no shift while it loads) and waits until it is near the screen
      for (const img of h.match(/<img [^>]*>/g)) assert.ok(/ width="\d+" height="\d+"/.test(img) && img.includes('loading="lazy"'), where + ": " + img);
      if (lang === "ko") assert.ok(!/[가-힣A-Za-z0-9)]\((은|는|이|가|을|를|과|와)\)/.test(h), where + ": particles picked, not 은(는)");
    }
  }
});

test("the sitemap lists every page with its alternates", async () => {
  const sm = await readFile(new URL("../public/sitemap.xml", import.meta.url), "utf8");
  assert.equal((sm.match(/<loc>/g) || []).length, LANGS.length * (RESOLVERS.length + 2));
  for (const [, slug] of LANGS) for (const id of [null, ...RESOLVERS.map(r => r.id), "status"]) assert.ok(sm.includes(`<loc>${SITE + path(slug, id)}</loc>`), path(slug, id));
});

test("the status page: every resolver with its protocols, its own script, linked from the list and every resolver's card", async () => {
  for (const [, slug] of LANGS) {
    const h = await page(slug, "status");
    assert.ok(!/id="tbl"|app\.[0-9a-f]+\.js/.test(h), slug + ": no test on it");
    assert.match(h, /\/assets\/status\.[0-9a-f]+\.js/);
    for (const r of RESOLVERS) assert.ok(h.includes(`<tr data-id="${r.id}"`), slug + ": " + r.id);
    assert.match(h, /<tr data-id="cloudflare"[^]*?<span class="pc">UDP<\/span><span class="pc">IPv6<\/span><span class="pc">DoT<\/span><span class="pc">DoH<\/span><\/span>/);
    const link = `href="${path(slug, "status")}"`;
    assert.ok((await page(slug, null)).includes(link), slug + ": home links it");
    assert.ok((await page(slug, "google")).includes(link), slug + ": a resolver's page links it");
  }
  assert.match(await readFile(new URL("../public/_headers", import.meta.url), "utf8"), /connect-src [^;]* https:\/\/data\.1ms\.dog:2083/);
});

test("a resolver's page doesn't send its help to a list it doesn't have; the home page keeps every general answer", async () => {
  const en = (await import("../src/i18n/en.mjs")).default;
  const home = await page("", null), sub = await page("", "dnsforge");
  const qs = h => [...h.matchAll(/data-hq="\d+"[^>]*>(.*?)<\/button>/g)].map(m => m[1]);
  assert.equal(qs(home).length, en.docs.length, "home: every general answer");
  assert.ok(!qs(sub).includes(en.docs[0][0].replace(/'/g, "&#39;")), "which one to pick: hidden on a resolver's page");
  assert.ok(qs(sub).some(q => q.startsWith("What is ECS, and why isn")), "ECS: reworded, not hidden");
  for (const s of ["UDP column", "under the table", "in the table", "this column"]) assert.ok(!sub.includes(s), "resolver page: " + s);
});
