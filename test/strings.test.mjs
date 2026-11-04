// Every string the page shows comes from the language files, in every language: a missing key would show its name
// (or, worse, English) instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { LANGS } from "../scripts/build.mjs";

const read = f => readFile(new URL("../" + f, import.meta.url), "utf8");
const all = (s, re) => [...s.matchAll(re)].map(m => m[1]);

test("every key the page uses exists in every language", async () => {
  const [app, page, build] = await Promise.all(["src/app.js", "src/page.html", "scripts/build.mjs"].map(read));
  const keys = new Set([
    ...all(app, /\bt\("(\w+)"/g), ...all(build, /\bT\("(\w+)"/g),
    ...all(page, /data-i="(\w+)"/g), ...all(page, /\{\{a:(\w+)\}\}/g), ...all(page, /\{\{(c_\w+)\}\}/g),
    ...["system", "light", "dark"].map(x => "th_" + x), "e_timeout", "e_fail", "best_k", "lead_k",
    "blocks_ads", "blocks_malware", "blocks_phishing",
  ].filter(k => !k.endsWith("_")));
  assert.ok(keys.size > 50, "found " + keys.size + " keys");
  for (const [lang] of LANGS) {
    const d = (await import(`../src/i18n/${lang}.mjs`)).default;
    const missing = [...keys].filter(k => !(k in d));
    assert.deepEqual(missing, [], `${lang} lacks ${missing.join(", ")}`);
  }
});

test("every language has every string, with the same placeholders", async () => {
  const en = (await import("../src/i18n/en.mjs")).default;
  const vars = s => (s.match(/\{\w+\}/g) || []).sort().filter((x, i, a) => a.indexOf(x) === i).join();
  for (const [lang] of LANGS) {
    const d = (await import(`../src/i18n/${lang}.mjs`)).default;
    for (const k of Object.keys(en)) assert.ok(k in d, `${lang}: ${k}`);
    assert.equal(d.docs.length, en.docs.length, lang + ": help entries");
    for (const k of Object.keys(en)) if (typeof en[k] === "string") assert.equal(vars(d[k]), vars(en[k]), `${lang}: ${k} placeholders`);
  }
});

test("no English fallback in the page script or the build", async () => {
  const [app, build] = await Promise.all(["src/app.js", "scripts/build.mjs"].map(read));
  for (const [name, s] of [["src/app.js", app], ["scripts/build.mjs", build]]) {
    assert.ok(!/\|\|\s*\w+(\.name)?\.en\b|\?\?\s*en\[/.test(s), name + " falls back to English");
  }
});

test("lists come from $$, never $ (which returns one element)", async () => {
  const app = await read("src/app.js");
  const bad = app.split("\n").filter(l => /(^|[^$])\$\([^)]*\)\.(forEach|map|filter)\(/.test(l));
  assert.deepEqual(bad, []);
});

test("a count picks the language's form: 1, 2, 5 and 21 read right (1ms-shell docs/translation.md, 复数)", async () => {
  const pick = (L, lang, k, n) => { const f = k + "_" + new Intl.PluralRules(lang).select(n); return (L[f] ?? L[k]).replace("{n}", n); };
  const en = (await import("../src/i18n/en.mjs")).default, ru = (await import("../src/i18n/ru.mjs")).default;
  assert.equal(pick(en, "en", "emb_down", 1), "1 resolver can't be reached from your network");
  assert.equal(pick(en, "en", "emb_down", 21), "21 resolvers can't be reached from your network");
  assert.equal(pick(ru, "ru", "emb_down", 21), "21 DNS-сервер недоступен из вашей сети");
  assert.equal(pick(ru, "ru", "emb_down", 3), "3 DNS-сервера недоступны из вашей сети");
  assert.equal(pick(ru, "ru", "emb_down", 5), "5 DNS-серверов недоступны из вашей сети");
  // every form has the same placeholders as the key it stands in for
  for (const [lang] of LANGS) {
    const L = (await import(`../src/i18n/${lang}.mjs`)).default, ph = s => (s.match(/\{\w+\}/g) || []).sort().join();
    for (const k in L) { const m = /^(\w+)_(zero|one|two|few|many)$/.exec(k); if (m && L[m[1]]) assert.equal(ph(L[k]), ph(L[m[1]]), lang + " " + k); }
  }
});

test("the page gets the plural forms only some languages have (Russian's _few)", async () => {
  const { readdir } = await import("node:fs/promises");
  const f = (await readdir(new URL("../public/assets/", import.meta.url))).find(n => /^l\.ru\.[0-9a-f]+\.js$/.test(n));
  const s = await read("public/assets/" + f);
  for (const k of ["emb_down_few", "card_sub_few", "card_sub_one"]) assert.ok(s.includes(`"${k}":`), k);
});
