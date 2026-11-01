// Direct (bypass) rules for proxy tools: with a proxy on, the resolvers' DoH addresses go through it and the test
// times the proxy's route, not the visitor's network. These rules send exactly the addresses the test asks DIRECT:
// each DoH host by exact name, and each estimate address (an IP) as a /32 or /128, nothing broader.
// Used by scripts/build.mjs (the remote rule sets under /rules/) and by the page (the rules dialog).
import { RESOLVERS } from "./resolvers.mjs";

export const FORMATS = ["clash", "surge", "shadowrocket", "quanx", "loon", "singbox", "xray", "plain"];
export const FORMAT_NAMES = { clash: "Clash / Mihomo", surge: "Surge", shadowrocket: "Shadowrocket", quanx: "Quantumult X", loon: "Loon", singbox: "sing-box", xray: "Xray / v2rayN" };

// [{ n: resolver name, d: host } | { n, ip: "1.1.1.1/32" }], in list order
export function items() {
  const out = [], seen = new Set();
  for (const r of RESOLVERS) for (const u of [r.doh, r.ip].filter(Boolean)) {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, "");
    if (seen.has(h)) continue;
    seen.add(h);
    const ip = /^[\d.]+$/.test(h) ? h + "/32" : h.includes(":") ? h + "/128" : null;
    out.push(ip ? { n: r.name, ip } : { n: r.name, d: h });
  }
  return out;
}

const domains = it => it.filter(i => i.d).map(i => i.d);
const cidrs = it => it.filter(i => i.ip).map(i => i.ip);

// one rule; withPolicy: inline in the tool's own config (a remote set carries no policy)
function line(f, i, withPolicy) {
  const p = withPolicy ? ",DIRECT" : "";
  if (f === "quanx") return i.d ? `host, ${i.d}, direct` : `ip-cidr, ${i.ip}, direct`;
  if (f === "clash" && !withPolicy) return i.d ? `DOMAIN,${i.d}` : `IP-CIDR,${i.ip},no-resolve`;
  return i.d ? `DOMAIN,${i.d}${p}` : `IP-CIDR,${i.ip}${p},no-resolve`;
}

// a comment before each resolver's rules
const listed = (it, f, ind, withPolicy) => it.map((i, k) => (k && it[k - 1].n === i.n ? "" : `${ind}# ${i.n}\n`) + ind + (ind && f === "clash" ? "- " : "") + line(f, i, withPolicy)).join("\n");

// fake-ip setups hand out made-up addresses: the DoH hosts must resolve to real ones
export function realIp(f, it = items()) {
  if (f === "clash") return "dns:\n  fake-ip-filter:\n" + domains(it).map(d => `    - ${d}`).join("\n");
  return "[General]\nalways-real-ip = " + domains(it).join(", ");
}

// everything pasted into the tool's own config
export function inline(f, notes, it = items()) {
  if (f === "singbox") return JSON.stringify({ route: { rules: [{ domain: domains(it), ip_cidr: cidrs(it), outbound: "direct" }] } }, null, 2);
  if (f === "xray") return JSON.stringify({ routing: { rules: [{ type: "field", domain: domains(it).map(d => "full:" + d), ip: cidrs(it), outboundTag: "direct" }] } }, null, 2);
  if (f === "plain") return [...domains(it), ...cidrs(it)].join("\n");
  const head = { clash: "rules:", surge: "[Rule]", shadowrocket: "[Rule]", loon: "[Rule]", quanx: "[filter_local]" }[f];
  const fake = f === "clash" || f === "surge" || f === "shadowrocket" ? `\n\n# ${notes.fakeip}\n` + realIp(f, it) : "";
  return head + "\n" + listed(it, f, f === "clash" ? "  " : "", true) + fake;
}

// the lines that point the tool at our rule set (null: the tool has no remote rule sets)
export function remote(f, site, notes, it = items()) {
  const u = site + "/rules/";
  switch (f) {
    case "clash": return `rule-providers:\n  dns-test:\n    type: http\n    behavior: classical\n    format: yaml\n    url: ${u}clash.yaml\n    path: ./ruleset/dns-test.yaml\n    interval: 86400\n\nrules:\n  - RULE-SET,dns-test,DIRECT   # ${notes.top}\n\n# ${notes.fakeip}\n` + realIp(f, it);
    case "surge": return `[Rule]\n# ${notes.top}\nRULE-SET,${u}surge.list,DIRECT,update-interval=86400\n\n# ${notes.fakeip}\n` + realIp(f, it);
    case "shadowrocket": return `[Rule]\n# ${notes.top}\nRULE-SET,${u}surge.list,DIRECT\n\n# ${notes.fakeip}\n` + realIp(f, it);
    case "quanx": return `[filter_remote]\n${u}quanx.list, tag=DNS Test, force-policy=direct, update-interval=86400, opt-parser=false, enabled=true`;
    case "loon": return `[Remote Rule]\n${u}loon.list, policy=DIRECT, tag=DNS Test, enabled=true`;
    case "singbox": return JSON.stringify({ route: { rule_set: [{ tag: "dns-test", type: "remote", format: "source", url: u + "singbox.json", download_detour: "direct", update_interval: "1d" }],
      rules: [{ rule_set: "dns-test", outbound: "direct" }] } }, null, 2);
  }
  return null;
}

// the remote rule set files, written by scripts/build.mjs
export function ruleSets(site, it = items()) {
  const head = `# DNS Test: the addresses the DNS speed test asks, to be sent DIRECT. ${it.length} exact hosts and addresses.\n# ${site}/ · https://github.com/yt1988/dns-test\n`;
  return {
    "clash.yaml": head + "payload:\n" + listed(it, "clash", "  ", false) + "\n",
    "surge.list": head + listed(it, "surge", "", false) + "\n",
    "loon.list": head + listed(it, "loon", "", false) + "\n",
    "quanx.list": head + listed(it, "quanx", "", false) + "\n",
    "singbox.json": JSON.stringify({ version: 2, rules: [{ domain: domains(it), ip_cidr: cidrs(it) }] }, null, 2) + "\n",
  };
}
