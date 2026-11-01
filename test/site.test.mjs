// The built pages keep the 1ms.dog tool contract (1ms-shell docs/tool-contract.md) and draw every resolver's row up front.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { LANGS, ORIGINS } from "../scripts/build.mjs";
import { RESOLVERS } from "../src/resolvers.mjs";

const page = slug => readFile(new URL(`../public/${slug ? slug + "/" : ""}index.html`, import.meta.url), "utf8");

test("every language page keeps the shell contract", async () => {
  for (const [lang, slug] of LANGS) {
    const h = await page(slug);
    assert.match(h, new RegExp(`<html lang="${lang}"`), lang);
    assert.match(h, /<head>\r?\n<meta charset="utf-8">\r?\n<script>/, lang + ": charset first, then the pre-paint script");
    assert.match(h, /id="helpBtn"[^>]*aria-haspopup="dialog"/, lang + ": help button");
    assert.match(h, /<div class="scrim" id="help" hidden>/, lang + ": help dialog hidden by default");
    assert.match(h, /class="logo-light" src="\/assets\/logo-light.svg" width="90" height="36"/);
    assert.ok(!/\{\{[\w:]+\}\}/.test(h), lang + ": unfilled placeholder");
    assert.ok(h.length < 70000, lang + ": page is " + h.length + " bytes");
    assert.equal((h.match(/<script>/g) || []).length, 1, lang + ": the only inline script is the pre-paint one");
    // header buttons in the site's order: language, help, GitHub, theme
    const order = ["id=\"lang\"", "id=\"helpBtn\"", "class=\"icon-btn gh\"", "id=\"theme\""].map(s => h.indexOf(s));
    assert.deepEqual([...order].sort((a, b) => a - b), order, lang + ": header button order");
  }
});

test("every resolver has its row and its icon before any answer", async () => {
  const h = await page("");
  assert.equal((h.match(/<div class="tr wait" data-r="/g) || []).length, RESOLVERS.length);
  for (const r of RESOLVERS) await access(new URL(`../public/icons/${r.id}.png`, import.meta.url));
});

test("the CSP lets the page reach every resolver it asks", async () => {
  const hd = await readFile(new URL("../public/_headers", import.meta.url), "utf8");
  for (const o of ORIGINS) assert.ok(hd.includes(" " + o), o);
});

test("the list is consistent", () => {
  const ids = RESOLVERS.map(r => r.id);
  assert.equal(new Set(ids).size, ids.length, "unique ids");
  for (const r of RESOLVERS) {
    assert.match(r.doh, /^https:\/\//, r.id);
    for (const k of ["udp", "dot"]) {
      const e = r.est[k];
      assert.ok(e === null || e === "doh" || (e === "ip" && r.ip), `${r.id}: est.${k}`);
      if (e) assert.ok(r[k], `${r.id}: estimates ${k} it doesn't offer`);
    }
    assert.equal(typeof r.dnssec, "boolean", r.id + ": dnssec checked");
    assert.ok(r.icon, r.id + ": icon domain");
  }
});
