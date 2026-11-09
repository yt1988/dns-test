// The DNS Test Worker. Files in ./public are served before it runs, so it only sees paths that are not files:
//   /i, /i.ps1            the command-line tool's installers (install.sh, install.ps1 of the latest release):
//                         curl -fsSL …/i | sh   ·   irm …/i.ps1 | iex
//   /v                    the latest dnstest release, "0.1.0", asked of GitHub and kept for 10 minutes; when GitHub
//                         fails, the last version that worked (marked x-1ms-stale), or 503 with none
//   /dl/<tag>/<file>      a file of that release, fetched from GitHub once and then kept (a tag's files never change);
//                         <tag> may be "latest", which redirects to the current tag
//   /[<lang>/][<resolver>/]r/<code>   a shared result (from a resolver's page: that one's): that language's page with the result's winner in its title and
//                         description (what chat apps show as the link's preview), not indexed; the page itself
//                         reads the code and shows the result (src/share.mjs)
//                         (a code it can't read: 404)
//   /tokyo.json           every resolver as the 1ms.dog server in Tokyo sees it (server/watch, every 10 minutes): its
//                         latest probe and uptime per protocol, fetched from data.1ms.dog and kept for 2 minutes
//   anything else         a bare 404; 1ms-shell puts the shared 1ms.dog 404 page in front of it
// The installer and the tool try these before GitHub, which is often slow or blocked in mainland China.
// GitHub itself fails for a minute or two now and then (5xx, a rate limit, no answer): every ask below is tried
// twice, and when it still fails, the last answer that worked is served instead of a 502 — see latest() and release().
// With nothing remembered, /v answers 503 (the weekly check should go red on a real outage) while /i and /i.ps1
// answer a 200 script that says GitHub is not answering and exits 1: `curl -f` sends nothing down the pipe on a 5xx,
// and `sh` reads an empty script as success — an install that installed nothing, silently. See installerUnavailable().

import { RESOLVERS } from "./resolvers.mjs";
import { decode, sharePath, fmt } from "./share.mjs";
import en from "./i18n/en.mjs";
import zhCN from "./i18n/zh-CN.mjs";
import zhTW from "./i18n/zh-TW.mjs";
import ja from "./i18n/ja.mjs";
import ko from "./i18n/ko.mjs";
import es from "./i18n/es.mjs";
import fr from "./i18n/fr.mjs";
import de from "./i18n/de.mjs";
import pt from "./i18n/pt.mjs";
import ru from "./i18n/ru.mjs";

// each language's strings by its folder ("" is English, at the root)
const STR = { "": en, "zh-cn": zhCN, "zh-tw": zhTW, ja, ko, es, fr, de, pt, ru };
const KNOWN = new Set(RESOLVERS.map(r => r.id)), NAME = Object.fromEntries(RESOLVERS.map(r => [r.id, r.name]));
const fill = (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => k in v ? v[k] : m);

const REPO = "yt1988/dns-test-cli";
const FILE = /^(dnstest-[a-z0-9]+-[a-z0-9]+(\.exe)?|checksums\.txt|install\.sh|install\.ps1)$/;
const INSTALLER = { "/i": "install.sh", "/i.ps1": "install.ps1" };

// GitHub's release pages and files fail for a minute or two now and then: a 5xx, a rate limit, or no answer at all.
// A visitor installs the tool through this Worker, so a failure here is a failed install, not just a red check: each
// ask is tried twice, and when it still fails the last answer that worked is used instead. Only a Worker that has
// never seen GitHub answer shows the "try again in a minute" page.
const LATEST_URL = `https://github.com/${REPO}/releases/latest`;
const DOWNLOAD_URL = `https://github.com/${REPO}/releases/download`;
const KEEP = 30 * 24 * 3600;      // seconds the last good answer is kept for
const RETRY_MS = 1000;            // the pause before the second ask
const INSTALLER_FILE = new Set(Object.values(INSTALLER));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const keyOf = (path, url) => new URL(path, url).toString();
const putText = (ctx, key, text, age, headers = {}) => ctx.waitUntil(caches.default.put(key,
  new Response(text, { headers: { "cache-control": `public, max-age=${age}`, ...headers } })));

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed\n", { status: 405 });

    const sp = sharePath(url.pathname, KNOWN);
    if (sp && STR[sp.slug] && (!sp.id || KNOWN.has(sp.id)) && env.ASSETS) return shared(req, env, url, sp);

    if (url.pathname === "/tokyo.json") return tokyo(req, ctx);

    if (url.pathname === "/v") {
      const v = await latest(url, ctx);
      if (!v) return unavailable(url);
      return new Response(v.version + "\n", { headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": `public, max-age=${v.stale ? 60 : 300}`,
        ...(v.stale ? { "x-1ms-stale": "1" } : {}),
      } });
    }

    if (INSTALLER[url.pathname]) {
      const v = await latest(url, ctx);
      if (!v) return installerUnavailable(INSTALLER[url.pathname]);
      return release(`v${v.version}`, INSTALLER[url.pathname], req, ctx, v.stale);
    }

    const m = /^\/dl\/(latest|v\d+\.\d+\.\d+)\/([^/]+)$/.exec(url.pathname);
    if (m && FILE.test(m[2])) {
      if (m[1] === "latest") {
        const v = await latest(url, ctx);
        if (!v) return unavailable(url);
        return new Response(null, { status: 302, headers: {
          location: `/dl/v${v.version}/${m[2]}`,
          "cache-control": `public, max-age=${v.stale ? 60 : 300}`,
          ...(v.stale ? { "x-1ms-stale": "1" } : {}),
        } });
      }
      return release(m[1], m[2], req, ctx);
    }

    return notFound(req);
  },
};

const notFound = req => new Response(req.method === "HEAD" ? null : "Not found\n", {
  status: 404,
  headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate" },
});

// A shared result: the language's page as it is, with the title, description and their Open Graph and Twitter copies
// saying who was fastest. A code this page can't read is not found (the shell shows the 1ms.dog 404 page).
async function shared(req, env, url, { slug, id, code }) {
  const home = "/" + (slug ? slug + "/" : "") + (id ? id + "/" : "");
  // a resolver's page: its own row only
  const r = decode(code, id ? new Set([id]) : KNOWN);
  const won = r && r.rows.filter(x => x.doh != null);
  if (!won || !won.length) return notFound(req);
  const S = STR[slug], [a, b] = won;
  const title = fill(id ? S.share_title_self : S.share_title, { name: NAME[a.id], ms: fmt(a.doh) });
  const desc = id ? fill(S.share_desc_self, { name: NAME[a.id], ms: fmt(a.doh) })
    : fill(b ? S.share_desc : S.share_desc1, { n: r.rows.length, name: NAME[a.id], ms: fmt(a.doh), second: b ? NAME[b.id] : "", ms2: b ? fmt(b.doh) : "" });
  const page = await env.ASSETS.fetch(new Request(new URL(home, url), { headers: req.headers }));
  if (!page.ok) return page;
  const attr = (v, name = "content") => ({ element: e => e.setAttribute(name, v) });
  const out = new HTMLRewriter()
    .on("title", { element: e => e.setInnerContent(title) })
    .on('meta[name="description"]', attr(desc))
    .on('meta[property="og:title"]', attr(title)).on('meta[name="twitter:title"]', attr(title))
    .on('meta[property="og:description"]', attr(desc)).on('meta[name="twitter:description"]', attr(desc))
    .on('meta[property="og:url"]', attr(url.origin + url.pathname))
    .on('meta[name="robots"]', attr("noindex, follow"))
    .transform(page);
  const h = new Headers(out.headers);
  h.delete("etag");
  h.set("cache-control", "public, max-age=3600");
  h.set("x-robots-tag", "noindex");
  return new Response(req.method === "HEAD" ? null : out.body, { status: 200, headers: h });
}

// Tokyo's view (server/watch writes it on the VPS, data.1ms.dog publishes it): only what the page reads, kept 2 minutes
const TOKYO = "https://data.1ms.dog:2083/dns/summary.json";
function trimTokyo(j) {
  const r = {};
  for (const [id, ps] of Object.entries((j && j.r) || {})) {
    if (!KNOWN.has(id)) continue;
    r[id] = {};
    for (const [p, s] of Object.entries(ps)) r[id][p] = { last: s.last ?? null, up7d: s.up7d, up30d: s.up30d };
  }
  return { t: j && j.t, r };
}
async function tokyo(req, ctx) {
  const cache = caches.default, key = new Request(new URL("/tokyo.json", req.url).toString());
  let res = await cache.match(key);
  if (!res) {
    let up;
    try { up = await fetch(TOKYO, { signal: AbortSignal.timeout(5000) }); } catch (e) { up = null; }
    if (!up || !up.ok) return new Response("Tokyo did not answer\n", { status: 502, headers: { "cache-control": "no-store" } });
    res = new Response(JSON.stringify(trimTokyo(await up.json())), {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=120" } });
    ctx.waitUntil(cache.put(key, res.clone()));
  }
  return req.method === "HEAD" ? new Response(null, { headers: res.headers }) : res;
}

// the newest release's version, from the redirect GitHub gives for /releases/latest: asked once, remembered 10 minutes.
// Returns { version, stale } — stale when GitHub failed and the last version that resolved is used instead — or null
// when nothing has ever resolved. A stale answer is kept 1 minute, so GitHub is asked again soon after it recovers.
async function latest(url, ctx) {
  const cache = caches.default, key = keyOf("/__latest", url), kept = keyOf("/__latest-kept", url);
  const hit = await cache.match(key);
  if (hit) return { version: (await hit.text()).trim(), stale: hit.headers.get("x-1ms-stale") === "1" };
  let version = null, retry = false;
  ({ tag: version, retry } = await askTag());
  if (retry) {
    await sleep(RETRY_MS);
    ({ tag: version } = await askTag());
    version ??= null;   // still failing (the second ask answers { retry: true }): no version
  }
  const stale = version === null;
  if (stale) {
    const old = await cache.match(kept);
    if (!old) return null;
    version = (await old.text()).trim();
  }
  putText(ctx, key, version, stale ? 60 : 600, stale ? { "x-1ms-stale": "1" } : {});
  putText(ctx, kept, version, KEEP);
  return { version, stale };
}

// one ask of GitHub for /releases/latest: HEAD, its redirect read and not followed. { tag: null } is an answer that is
// not a release (no point asking again); { retry: true } is GitHub failing just now (5xx, a rate limit, no answer).
async function askTag() {
  try {
    const res = await fetch(LATEST_URL, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(5000) });
    if (res.status >= 500 || res.status === 429) return { retry: true };
    const tag = (res.headers.get("location") || "").split("/").pop();
    return { tag: /^v\d+\.\d+\.\d+$/.test(tag) ? tag.slice(1) : null };
  } catch (e) {
    return { retry: true };
  }
}

// one release file from GitHub: a 5xx or no answer is asked once more (a 4xx is GitHub's answer: no such file).
// null when GitHub never answered at all.
async function download(tag, file) {
  for (let n = 1; ; n++) {
    try {
      const up = await fetch(`${DOWNLOAD_URL}/${tag}/${file}`, { redirect: "follow", signal: AbortSignal.timeout(30000) });
      if (up.status < 500 || n === 2) return up;
      up.body?.cancel();
    } catch (e) {
      if (n === 2) return null;
    }
    await sleep(RETRY_MS);
  }
}

async function release(tag, file, req, ctx, stale = false) {
  const cache = caches.default;
  const key = new Request(new URL(`/dl/${tag}/${file}`, req.url).toString());
  let res = await cache.match(key);
  if (!res) {
    const up = await download(tag, file);
    if (!up) return INSTALLER_FILE.has(file) ? installerUnavailable(file) : unavailable(new URL(req.url));
    if (!up.ok) {
      // the installer is a few KB of text and does not depend on the tag: a copy that worked is still a way in when
      // GitHub is failing right now, and the file it downloads chooses the release itself
      const kept = INSTALLER_FILE.has(file) && await cache.match(keyOf(`/__i/${file}`, req.url));
      if (kept) return keptInstaller(req, kept);
      if (INSTALLER_FILE.has(file)) return installerUnavailable(file);
      if (up.status === 404) return new Response(`${tag}/${file}: GitHub answered 404\n`,
        { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
      return unavailable(new URL(req.url));
    }
    const text = /\.(txt|sh|ps1)$/.test(file);
    // no content-length: GitHub may send the file compressed, and the body here is already decompressed
    const body = text ? await up.text() : up.body;
    res = new Response(body, {
      headers: {
        "content-type": text ? "text/plain; charset=utf-8" : "application/octet-stream",
        "cache-control": "public, max-age=31536000, immutable",
        ...(text ? {} : { "content-disposition": `attachment; filename="${file}"` }),
      },
    });
    ctx.waitUntil(cache.put(key, res.clone()));
    if (INSTALLER_FILE.has(file)) ctx.waitUntil(cache.put(keyOf(`/__i/${file}`, req.url),
      new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": `public, max-age=${KEEP}` } })));
  }
  if (req.method === "HEAD") return new Response(null, { headers: res.headers });
  if (!stale) return res;
  const h = new Headers(res.headers);
  h.set("x-1ms-stale", "1");
  return new Response(res.body, { headers: h });
}

// a remembered installer: served once, marked stale, and revalidated after a minute (the release may be newer now)
function keptInstaller(req, hit) {
  if (req.method === "HEAD") return new Response(null, { headers: hit.headers });
  const h = new Headers(hit.headers);
  h.set("cache-control", "public, max-age=60");
  h.set("x-1ms-stale", "1");
  return new Response(hit.body, { headers: h });
}

// GitHub is down and nothing was remembered, /v: one line saying so, 503 (the weekly check's direct route is red only
// when something really fails, so this must not be hidden as a 200) and retry-after 60. 503 also means `curl -f`
// stops, and the command-line tool reads it as "no version", not as one.
function unavailable() {
  return new Response("dnstest: GitHub is not answering right now; the latest version cannot be looked up. Try again in a minute.\n",
    { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "retry-after": "60" } });
}

// GitHub is down and nothing was remembered, /i and /i.ps1: a 200 script that prints why and exits 1. A 5xx here
// would make `curl -f` write nothing into the pipe, and `sh` read an empty script as a success: an install that
// installed nothing, silently. The status stays 200 so the script is what runs; the exit code is what fails.
function installerUnavailable(file) {
  const say = "GitHub is not answering right now, so the latest release cannot be looked up. Try again in a minute.";
  const body = file === "install.ps1"
    ? ["# dnstest installer for Windows: " + say,
      `Write-Host "${say}"`,
      `throw "dnstest: ${say}"`]
    : ["#!/bin/sh",
      "# dnstest installer: " + say,
      `printf '%s\\n' "${say}" >&2`,
      "exit 1"];
  return new Response(body.join("\n") + "\n",
    { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
