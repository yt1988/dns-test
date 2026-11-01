#!/usr/bin/env node
// Renders the link-preview images with resvg (dev dependency), 1200 × 630: public/og/<lang>.png for each language.
// Run when the headline, the subtitle or the resolver icons change, and commit the output. Uses system fonts for the
// text (Windows: Segoe UI, Microsoft YaHei, Microsoft JhengHei, Yu Gothic UI, Malgun Gothic, Consolas), as the
// 1ms.dog home page's script does.
// Usage: node scripts/assets.mjs
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";
import { RESOLVERS } from "../src/resolvers.mjs";

const pub = new URL("../public/", import.meta.url), src = new URL("../src/", import.meta.url);
const HOST = new URL(process.env.SITE_URL || "https://dns.1ms.dog").host;
const FONTS = { "zh-CN": "Microsoft YaHei", "zh-TW": "Microsoft JhengHei", ja: "Yu Gothic UI", ko: "Malgun Gothic" };
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const b64 = async f => Buffer.from(await readFile(new URL(f, pub))).toString("base64");
const render = svg => new Resvg(svg, { fitTo: { mode: "width", value: 1200 }, font: { loadSystemFonts: true, defaultFontFamily: "Segoe UI" } }).render().asPng();

// the picture: a ranking as the page draws it, fastest first, times colored by the page's tiers
const ROWS = [["cloudflare", 4.1, "#3ecf8e"], ["google", 6.8, "#3ecf8e"], ["quad9", 18, "#3ecf8e"], ["alidns", 42, "#9fd356"], ["nextdns", 96, "#f5c524"]];
const pos = ms => Math.log10(Math.max(1, ms)) / 3;

async function card(lang, title, sub) {
  const ff = `${FONTS[lang] ? `'${FONTS[lang]}', ` : ""}'Segoe UI', 'Microsoft YaHei', sans-serif`;
  const logo = await b64("assets/logo-dark.svg");
  const icons = Object.fromEntries(await Promise.all(ROWS.map(async ([id]) => [id, await b64(`icons/${id}.png`)])));
  // headline and subtitle fit the left column (500 px): wrapped by estimated width, wide characters counting double
  const wide = ch => /[　-鿿가-힯＀-￯]/.test(ch), est = (t, px) => [...t].reduce((a, ch) => a + (wide(ch) ? 1 : .56) * px, 0);
  const wrap = (text, px) => {
    const out = [];
    let cur = "";
    for (const word of text.split(/(?<=[ ，、？?,])/)) {
      for (const piece of est(word, px) > 500 ? [...word] : [word]) {
        if (cur && est(cur + piece, px) > 500) { out.push(cur.trim()); cur = ""; }
        cur += piece;
      }
    }
    return [...out, cur.trim()];
  };
  let size = 58, lines;
  for (; (lines = wrap(title, size)).length > 2 && size > 42; size -= 4);
  const subs = wrap(sub, 26).slice(0, 2);
  const top = 214 - (subs.length - 1) * 18 + (lines.length > 1 ? 0 : 26);
  const head = lines.map((l, i) => `<text x="72" y="${top + i * (size + 12)}" font-size="${size}" font-weight="700" fill="#ededed">${esc(l)}</text>`).join("");
  const subY = top + (lines.length - 1) * (size + 12) + 58;
  const subText = subs.map((l, i) => `<text x="72" y="${subY + i * 36}" font-size="26" fill="#a0a0a0">${esc(l)}</text>`).join("");
  const barY = subY + (subs.length - 1) * 36 + 42;
  const l0 = 840, l1 = 1080, rows = ROWS.map(([id, ms, c], i) => {
    const y = 214 + i * 66, name = RESOLVERS.find(r => r.id === id).name, px = l0 + (l1 - l0) * pos(ms);
    return `<image x="640" y="${y - 16}" width="28" height="28" href="data:image/png;base64,${icons[id]}"/>` +
      `<text x="682" y="${y + 7}" font-size="21" fill="#ededed">${esc(name.length > 10 ? name.slice(0, 9) + "…" : name)}</text>` +
      `<rect x="${l0}" y="${y - 1.5}" width="${l1 - l0}" height="3" fill="#363636"/><rect x="${l0}" y="${y - 1.5}" width="${px - l0}" height="3" fill="${c}" opacity=".6"/>` +
      `<circle cx="${px}" cy="${y}" r="8" fill="${c}"/>` +
      `<text x="1140" y="${y + 7}" font-size="21" font-family="Consolas, monospace" font-weight="600" fill="${c}" text-anchor="end">${ms < 10 ? ms.toFixed(1) : ms}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="${ff}">
<rect width="1200" height="630" fill="#1c1c1c"/>
<rect x="600" y="150" width="568" height="360" rx="20" fill="#232323" stroke="#363636"/>
<image x="72" y="56" width="180" height="72" href="data:image/svg+xml;base64,${logo}"/>
${head}
${subText}
<rect x="72" y="${barY}" width="120" height="6" rx="3" fill="#f472b6"/>
${rows}
<text x="72" y="574" font-size="26" font-weight="600" fill="#f472b6">${HOST}</text>
<text x="1128" y="574" font-size="22" fill="#a0a0a0" text-anchor="end">UDP · DoT · DoH · DoQ</text>
</svg>`;
}

await mkdir(new URL("og/", pub), { recursive: true });
for (const f of (await readdir(new URL("i18n/", src))).filter(f => f.endsWith(".mjs"))) {
  const lang = f.slice(0, -4), d = (await import(new URL("i18n/" + f, src).href)).default;
  const png = render(await card(lang, d.h1, d.og_sub.split("{n}").join(RESOLVERS.length)));
  await writeFile(new URL(`og/${lang.toLowerCase()}.png`, pub), png);
  console.log(`og/${lang.toLowerCase()}.png ${Math.round(png.length / 1024)} KB`);
}
