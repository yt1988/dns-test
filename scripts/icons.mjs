#!/usr/bin/env node
// Fetches each resolver's site icon once, as a 64 px PNG, into public/icons/<id>.png. The files are committed: the
// page shows them from this site, so visitors' browsers never ask a third party for them.
// Run after adding a resolver (its `icon` is the domain to take the icon from). Uses Google's favicon service, which
// returns the same size and format for every site.
// Usage: node scripts/icons.mjs [id …]
import { mkdir, writeFile } from "node:fs/promises";
import { RESOLVERS } from "../src/resolvers.mjs";

const dir = new URL("../public/icons/", import.meta.url);
await mkdir(dir, { recursive: true });
const pick = process.argv.slice(2);
let bad = 0;
for (const r of RESOLVERS.filter(r => !pick.length || pick.includes(r.id))) {
  const res = await fetch(`https://www.google.com/s2/favicons?domain=${r.icon}&sz=64`);
  const b = Buffer.from(await res.arrayBuffer());
  if (!res.ok || b[1] !== 0x50) { console.log(`${r.id}: ${res.status}, not a PNG`); bad++; continue; }
  await writeFile(new URL(r.id + ".png", dir), b);
  console.log(`${r.id.padEnd(11)} ${r.icon.padEnd(18)} ${b.length} bytes`);
}
process.exitCode = bad ? 1 : 0;
