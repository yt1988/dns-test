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
      // the hero names it from the start, its row is marked, its addresses are on the page
      assert.ok(one(h, /<h1>(.*?)<\/h1>/).includes(titleOf(r, lang).replace(/&/g, "&amp;")), where + ": heading names it");
      assert.ok(h.includes(`<b id="winName">${r.name}</b>`), where + ": hero");
      assert.ok(h.includes(`<div class="tr wait me" data-r="${r.id}"`), where + ": its row marked");
      assert.ok(h.includes(`<code>${r.doh}</code>`) && (!r.udp || h.includes(`<code>${r.udp[0]}</code>`)), where + ": addresses");
      assert.ok(h.includes(`-r ${r.id},${ABOUT[r.id].vs}</code>`), where + ": the command line tests it");
      // its questions first, in the FAQ data too; the way back to the test of them all and on to the others
      const ld = JSON.parse(one(h, /<script type="application\/ld\+json">(.*?)<\/script>/));
      const faq = ld["@graph"].find(x => x["@type"] === "FAQPage").mainEntity;
      assert.equal(faq.length, 6, where + ": its own questions");
      assert.ok(faq.every(q => q.acceptedAnswer.text.length > 40), where + ": answers");
      assert.ok(ld["@graph"].some(x => x["@type"] === "BreadcrumbList"), where + ": breadcrumb");
      assert.ok(h.includes(`<a class="brand" href="${path(slug)}"`), where + ": link to the test of them all");
      assert.ok(h.includes(`href="${path(slug, ABOUT[r.id].vs)}"`), where + ": link to the one it is compared with");
      assert.equal((h.match(/<li><a href="\/[^"]*"/g) || []).length, RESOLVERS.length, where + ": links to every resolver's page");
      if (lang === "ko") assert.ok(!/[가-힣A-Za-z0-9)]\((은|는|이|가|을|를|과|와)\)/.test(h), where + ": particles picked, not 은(는)");
    }
  }
});

test("the sitemap lists every page with its alternates", async () => {
  const sm = await readFile(new URL("../public/sitemap.xml", import.meta.url), "utf8");
  assert.equal((sm.match(/<loc>/g) || []).length, LANGS.length * (RESOLVERS.length + 1));
  for (const [, slug] of LANGS) for (const id of [null, ...RESOLVERS.map(r => r.id)]) assert.ok(sm.includes(`<loc>${SITE + path(slug, id)}</loc>`), path(slug, id));
});
