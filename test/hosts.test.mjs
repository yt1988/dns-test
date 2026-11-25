// Where the page measures and where its results come from are deployment details (1ms.dog tool-contract.md §2):
// visitor-facing copy names the site and its location, and every absolute URL it carries is either the tool's own
// public domain or a third party (the resolvers it tests, the sites it points to). Any other 1ms.dog host there
// would be one of our measurement or service endpoints.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = p => readFile(new URL(p, root), "utf8");
const OWN = new Set(["1ms.dog", "dns.1ms.dog"]);
const URLS = /\bhttps?:\/\/([^\s"'`<>/?#)]+)/gi;
const hostOf = s => s.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
const ours = h => h === "1ms.dog" || h.endsWith(".1ms.dog");

async function htmlFiles(dir) {
  const out = [];
  for (const e of await readdir(new URL(dir, root), { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...await htmlFiles(dir + e.name + "/"));
    else if (e.name.endsWith(".html")) out.push(dir + e.name);
  }
  return out;
}

test("visitor copy reaches no 1ms.dog host but the tool's own", async () => {
  const files = ["src/page.html", "README.md", "README.zh-CN.md", "public/llms.txt"];
  for (const f of await readdir(new URL("src/i18n/", root))) if (f.endsWith(".mjs")) files.push("src/i18n/" + f);
  for (const f of await readdir(new URL("public/assets/", root))) if (/^l\..*\.js$/.test(f)) files.push("public/assets/" + f);
  files.push(...await htmlFiles("public/"));
  for (const f of files) {
    const s = await read(f);
    for (const m of s.matchAll(URLS)) {
      const host = hostOf(m[1]);
      if (ours(host)) assert.ok(OWN.has(host), f + ": " + m[0] + " is not this tool's own host");
    }
  }
});
