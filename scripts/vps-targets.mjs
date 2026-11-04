// Writes server/watch/targets.json, what 1ms-dns-watch on the VPS probes, from src/resolvers.mjs (the list the page
// tests). Run after changing the list: node scripts/vps-targets.mjs (test/vps-targets.test.mjs checks it's current).
import { writeFileSync } from "node:fs";
import { RESOLVERS } from "../src/resolvers.mjs";

export const targets = () => RESOLVERS.map(r => {
  const t = { id: r.id };
  if (r.udp?.length) t.udp = r.udp[0];
  if (r.udp6?.length) t.udp6 = r.udp6[0];
  if (r.dot) t.dot = r.dot;
  if (r.doq) t.doq = r.doq;
  t.doh = r.doh;
  return t;
});
export const targetsJSON = () => JSON.stringify(targets(), null, 1) + "\n";
export const targetsFile = new URL("../server/watch/targets.json", import.meta.url);

if (process.argv[1]?.endsWith("vps-targets.mjs")) writeFileSync(targetsFile, targetsJSON());
