# DNS Test

**English** · [简体中文](README.zh-CN.md)

Which public DNS resolver is fastest from your network? [DNS Test](https://dns.1ms.dog) times 33 of them right in your browser:

- **Global (anycast):** Cloudflare, Google, Quad9, OpenDNS, AdGuard DNS, AdGuard Unfiltered, NextDNS, Control D, Mullvad, DNS.SB, Hurricane Electric, Wikimedia DNS, CleanBrowsing, Rethink DNS
- **Mainland China:** AliDNS, DNSPod, 360 DNS
- **Regional:** Xfinity (US), CIRA Canadian Shield (CA), DNS4EU, CZ.NIC ODVR (CZ), SWITCH and Digitale Gesellschaft (CH), DNSForge (DE), UncensoredDNS (DK), Applied Privacy (AT), Njalla (SE), DNS4ALL (NL), LibreDNS (GR), Yandex DNS and Comss.one (RU), Tiarap (SG), IIJ (JP)

**Live:** https://dns.1ms.dog

Each resolver also has its own page in every language (https://dns.1ms.dog/cloudflare/, https://dns.1ms.dog/zh-cn/alidns/ …): the same test with that resolver in front, its addresses, who runs it, and how to set it up on Windows, macOS, iPhone, Android, routers, browsers and Linux.

## What it measures

| Column | How |
|---|---|
| **DoH** | Measured. DNS over HTTPS queries from your browser to each resolver's DoH address, on an open connection. |
| **UDP ≈, DoT ≈** | Estimated. Browsers can't send UDP or DoT queries (no website can), so the page sends DoH to the very server that answers UDP and DoT (`https://1.1.1.1/dns-query`, `https://223.5.5.5/dns-query`…). On an open connection that is one round trip to the same anycast node plus the same resolver, which is what a UDP or DoT query costs. `–` where that server has no HTTPS. |
| **Uncached** | A random name that exists nowhere, so the resolver has to ask the zone's authoritative servers. Shown, not ranked: it depends on where each site's own DNS servers are. |
| **DNSSEC** | Validates DNSSEC: `dnssec-failed.org` gets SERVFAIL and a signed name gets the AD bit (checked by `scripts/verify.mjs`). |

The hero names the fastest resolver as soon as answers come in, then the result, with what to enter (DNS servers, Private DNS / DoT host, DoH address).

### Keeping the numbers honest

- **Warm connections only.** The first query opens the connection and three popular names are asked once to put them in the resolver's cache; none of that counts.
- **10 interleaved rounds.** Each round asks every resolver once, in a new random order, a few at a time, so a burst of trouble on your network hits all of them alike. Medians, so one slow query doesn't move a number. Every other round also asks a random name (uncached).
- **No cache can answer instead.** Every URL is new (random letter case, DNS 0x20, and random names) and fetched with `cache: "no-store"`.
- **The browser's own timing.** Each query's time comes from Resource Timing, which the page's scripts can't delay.
- **Real answers.** Where a resolver sends CORS headers, each answer is read and only real ones count (NOERROR for popular names; an address for a missing name marks the resolver as rewriting NXDOMAIN). The others can only be timed; `scripts/verify.mjs` checks they answer this exact query with a DNS message.
- **Behind a proxy?** The *Direct rules* button gives rules for Clash/Mihomo, Surge, Shadowrocket, Quantumult X, Loon, sing-box and Xray that send exactly the test's hosts and addresses DIRECT, so the test measures your network and not your proxy's. Remote rule sets: `/rules/clash.yaml`, `surge.list`, `loon.list`, `quanx.list`, `singbox.json`.

Not in the list: 114DNS, Baidu DNS and CNNIC (plain DNS only, no HTTPS on their servers, so a browser can't reach them); Quad101 (TW), Kakao (KR), Volcengine (CN) and Shecan (IR), whose DoH didn't answer in our checks from Germany, the US and China. Most ISPs' own resolvers offer no public DoH either: for them, compare against the resolver your router hands out by setting it yourself.

## Files

```
src/resolvers.mjs   the list: addresses, what the estimates use, DNSSEC
src/about.mjs       what each resolver's own page says about it: operator, country, the one it is compared with
src/measure.mjs     the test in the browser: warm-up, rounds, timing, statistics
src/dns.mjs         DNS messages for DoH GET (build, encode, parse)
src/rules.mjs       direct rules for proxy tools
src/app.js          the page
src/i18n/*.mjs      10 languages
scripts/build.mjs   builds public/ (pages, assets, rule sets, CSP)
scripts/verify.mjs  checks every resolver over HTTP/2: answers, CORS, DNSSEC, NXDOMAIN
scripts/icons.mjs   fetches each resolver's site icon once into public/icons/
```

## Adding a resolver

1. Find its DoH address and check it answers `GET ?dns=` with 200 (`curl --http2 'https://…/dns-query?dns=AAABAAABAAAAAAAAB2V4YW1wbGUDY29tAAABAAE' -H 'accept: application/dns-message'`) from more than one continent.
2. Find out which server answers its UDP and DoT: if the DoH host resolves to the same addresses, `est` is `"doh"`; if the plain DNS address serves DoH with a valid certificate, put it in `ip` and use `"ip"`; otherwise `null`.
3. Add it to `src/resolvers.mjs` and `src/about.mjs`, run `node scripts/verify.mjs <id>` and `node scripts/icons.mjs <id>`, then `npm run build` and `npm test`.

## Run and deploy

```bash
npm install
npm run build      # public/
npm test           # public/ up to date, contract, strings, unit tests
npm run verify     # check every resolver from here
npm run dev        # http://localhost:8793
npx wrangler deploy
```

The site is static files on a Cloudflare Worker with static assets: files are served without running any script, so those requests aren't metered. `src/worker.js` only answers `/i`, `/v` and `/dl/*` (the command-line tool's installer and its release files, passed on from GitHub). Pushing to `main` deploys through Workers Builds (`npm ci && npm test`, then `npx wrangler deploy`). `wrangler.toml` binds no domain: on 1ms.dog the shared shell routes `dns.1ms.dog` to it. To self-host, bind your own domain to the Worker in the Cloudflare dashboard and build with `SITE_URL=https://your.domain npm run build`. The random names for uncached lookups are under `NXZONE` in `src/resolvers.mjs` (`nx.dns.1ms.dog`); any zone with no wildcard record works.

<!-- 1ms-repos: generated by 1ms-shell scripts/repos.mjs; edit sites.js or the script there, not here -->
## More from 1ms.dog

Free, open-source network tools from [1ms.dog](https://1ms.dog).

**Speed & connectivity**

| Tool | What it answers | Source |
|---|---|---|
| [1ms.dog](https://1ms.dog) | Where your traffic exits, and how far the services you use are | [1ms.dog](https://github.com/yt1988/1ms.dog) |
| [Network X-Ray](https://check.1ms.dog) | Eight of these tests in one run, one grade | [connection-checkup](https://github.com/yt1988/connection-checkup) |
| [Speed Test](https://speed.1ms.dog) | Download, upload, ping and bufferbloat | [speed-test](https://github.com/yt1988/speed-test) |
| [IPv6 Test](https://ipv6.1ms.dog) | Whether your network really supports IPv6, scored out of 10 | [ipv6-test](https://github.com/yt1988/ipv6-test) |
| [CDN Radar](https://cdn.1ms.dog) | Which location of each big CDN serves you, and how far it is | [cdn-radar](https://github.com/yt1988/cdn-radar) |

**IP & privacy**

| Tool | What it answers | Source |
|---|---|---|
| [EgressLens](https://egress.1ms.dog) | Every exit IP your traffic uses, and which sites see which | [egresslens](https://github.com/yt1988/egresslens) |
| [IP Quality Test](https://ipqs.1ms.dog) | How clean your IP is, scored 0–100 from a dozen sources | [ip-quality-test](https://github.com/yt1988/ip-quality-test) |
| [Who Are You](https://who.1ms.dog) | What any website can tell about you without asking | [who-are-you](https://github.com/yt1988/who-are-you) |
| [ASN Lookup](https://asn.1ms.dog) | Who owns an IP, and the prefixes and peers of every AS | [asn-lookup](https://github.com/yt1988/asn-lookup) |
| [Streaming & AI Unlock Check](https://unlock.1ms.dog) | Which streaming and AI services work on your IP | [unlock-check](https://github.com/yt1988/unlock-check) |

**Cloud & costs**

| Tool | What it answers | Source |
|---|---|---|
| [Me2Cloud](https://m2c.1ms.dog) | Latency, jitter and loss to every region of the big clouds | [me2cloud](https://github.com/yt1988/me2cloud) |
| [Lightsail Cost Saver](https://ls.1ms.dog) | Forecast Lightsail transfer overage, and the cheapest way to add more | [lightsail-cost-saver](https://github.com/yt1988/lightsail-cost-saver) |
| [Cloud Cost Planner](https://cost.1ms.dog) | The cheapest VPS, storage and CDN setup for your traffic | [cloud-cost-planner](https://github.com/yt1988/cloud-cost-planner) |

**Command line**

| Tool | What it answers | Source |
|---|---|---|
| [`httpslatency`](https://github.com/yt1988/https-latency-test-cli) | 1ms.dog's latency test, run from a server or router | [https-latency-test-cli](https://github.com/yt1988/https-latency-test-cli) |
| [`vps2cloud`](https://github.com/yt1988/vps2cloud) | Me2Cloud from a server: latency to every region of the big clouds | [vps2cloud](https://github.com/yt1988/vps2cloud) |
| [`dnstest`](https://github.com/yt1988/dns-test-cli) | DNS Test from a server, over UDP, TCP, DoT, DoH and DoQ | [dns-test-cli](https://github.com/yt1988/dns-test-cli) |
<!-- /1ms-repos -->

## License

MIT
