// What each resolver's own page (/<id>/, /<lang>/<id>/) says about it, besides the addresses in src/resolvers.mjs.
//
//   org    who runs it; a name that differs by language is { "*": default, <lang>: … }
//   hq     the country it is run from (ISO code; "EU" for the European Union), when it is clear; regional resolvers
//          have it as cc in src/resolvers.mjs
//   vs     the resolver it is most often compared with: its page answers "which is faster" for that pair
//   title  the name people search for, when it isn't "<name> DNS" (or <name> when that already says DNS)
//   tags   nonprofit  run as a non-profit (foundation, association, registry)
//          nolog      its operator states it doesn't keep visitors' IP addresses
//          account    a free account adds custom filtering and a query log on top of the public address
// Only what the operators state themselves; nothing here is measured (the page measures).
export const ABOUT = {
  cloudflare: { org: "Cloudflare", hq: "US", vs: "google", tags: ["nolog"] },
  google: { org: "Google", hq: "US", vs: "cloudflare", title: "Google Public DNS" },
  quad9: { org: "Quad9 Foundation", hq: "CH", vs: "cloudflare", tags: ["nonprofit", "nolog"] },
  opendns: { org: "Cisco", hq: "US", vs: "google" },
  adguard: { org: "AdGuard", hq: "CY", vs: "nextdns", tags: ["account"] },
  "adguard-nf": { org: "AdGuard", hq: "CY", vs: "cloudflare", title: "AdGuard DNS Unfiltered" },
  nextdns: { org: "NextDNS", hq: "US", vs: "adguard", tags: ["account"] },
  controld: { org: "Control D (Windscribe)", hq: "CA", vs: "nextdns", tags: ["account"] },
  mullvad: { org: "Mullvad VPN", hq: "SE", vs: "quad9", tags: ["nolog"] },
  dnssb: { org: "DNS.SB", vs: "cloudflare" },
  he: { org: "Hurricane Electric", hq: "US", vs: "google" },
  wikimedia: { org: "Wikimedia Foundation", hq: "US", vs: "cloudflare", tags: ["nonprofit", "nolog"] },
  cleanbrowsing: { org: "CleanBrowsing", hq: "US", vs: "opendns" },
  rethink: { org: "Celzero (Rethink)", vs: "nextdns", tags: ["account"] },
  alidns: { org: { "*": "Alibaba Cloud", "zh-CN": "阿里云", "zh-TW": "阿里雲" }, hq: "CN", vs: "dnspod",
    title: { "*": "AliDNS", "zh-CN": "阿里 DNS", "zh-TW": "阿里 DNS" } },
  dnspod: { org: { "*": "Tencent Cloud", "zh-CN": "腾讯云", "zh-TW": "騰訊雲" }, hq: "CN", vs: "alidns",
    title: { "*": "DNSPod Public DNS", "zh-CN": "腾讯 DNSPod", "zh-TW": "騰訊 DNSPod" } },
  360: { org: { "*": "Qihoo 360", "zh-CN": "奇虎 360", "zh-TW": "奇虎 360" }, hq: "CN", vs: "alidns",
    title: { "*": "360 Secure DNS", "zh-CN": "360 安全 DNS", "zh-TW": "360 安全 DNS" } },
  yandex: { org: { "*": "Yandex", ru: "Яндекс" }, vs: "google", title: { "*": "Yandex DNS", ru: "Яндекс DNS" } },
  dns4eu: { org: "DNS4EU (Whalebone)", vs: "quad9" },
  cira: { org: "CIRA", vs: "quad9", tags: ["nonprofit"], title: "CIRA Canadian Shield" },
  cznic: { org: "CZ.NIC", vs: "quad9", tags: ["nonprofit"], title: "CZ.NIC ODVR" },
  switch: { org: "SWITCH", vs: "quad9", tags: ["nonprofit"] },
  digiges: { org: "Digitale Gesellschaft", vs: "quad9", tags: ["nonprofit", "nolog"] },
  dnsforge: { org: "DNSForge", vs: "adguard" },
  uncensored: { org: "UncensoredDNS", vs: "quad9", tags: ["nolog"] },
  appliedprivacy: { org: "Applied Privacy Foundation", vs: "mullvad", tags: ["nonprofit", "nolog"] },
  njalla: { org: "Njalla", vs: "mullvad", tags: ["nolog"] },
  dns4all: { org: "DNS4ALL", vs: "quad9", tags: ["nonprofit"] },
  libredns: { org: "LibreOps", vs: "quad9" },
  comss: { org: "Comss.ru", vs: "yandex" },
  xfinity: { org: "Comcast", vs: "google" },
  tiarap: { org: "Tiarap", vs: "cloudflare" },
  iij: { org: "IIJ", vs: "google" },
};

// a value that may differ by language
export const local = (v, lang) => typeof v === "string" ? v : v[lang] ?? v["*"];
// the name the page's title and heading use
export const titleOf = (r, lang) => {
  const a = ABOUT[r.id];
  return a.title ? local(a.title, lang) : /dns/i.test(r.name) ? r.name : r.name + " DNS";
};
