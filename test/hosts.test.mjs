// The hosts the page uses to measure (the authoritative DNS for the device-resolver lookup, its results API, the
// Tokyo watch's results) are deployment details; visitor-facing copy names the site and its location instead
// (1ms.dog tool-contract.md, "内部测量/辅助域名"). Code constants and the CSP keep the real names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = p => readFile(new URL(p, root), "utf8");
// l.1ms.dog covers api.l.1ms.dog; data.1ms.dog is the Tokyo watch's results, named the same way in copy
const HOST = /(?:^|[^a-z0-9-])(?:l\.1ms\.dog|data\.1ms\.dog)(?:[^a-z0-9-]|$)/i;

async function htmlFiles(dir) {
  const out = [];
  for (const e of await readdir(new URL(dir, root), { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...await htmlFiles(dir + e.name + "/"));
    else if (e.name.endsWith(".html")) out.push(dir + e.name);
  }
  return out;
}

test("visitor copy names no internal host, only the site and where it is", async () => {
  const files = ["src/page.html", "README.md", "README.zh-CN.md", "public/llms.txt"];
  for (const f of await readdir(new URL("src/i18n/", root))) if (f.endsWith(".mjs")) files.push("src/i18n/" + f);
  for (const f of await readdir(new URL("public/assets/", root))) if (/^l\..*\.js$/.test(f)) files.push("public/assets/" + f);
  files.push(...await htmlFiles("public/"));
  for (const f of files) {
    const s = await read(f);
    assert.doesNotMatch(s, HOST, f + ": names an internal host; say the site's resolver server in Tokyo instead");
  }
});
