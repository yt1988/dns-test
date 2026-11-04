// The DNS Test Worker. Files in ./public are served before it runs, so it only sees paths that are not files:
//   /i, /i.ps1            the command-line tool's installers (install.sh, install.ps1 of the latest release):
//                         curl -fsSL …/i | sh   ·   irm …/i.ps1 | iex
//   /v                    the latest dnstest release, "0.1.0", asked of GitHub and kept for 10 minutes
//   /dl/<tag>/<file>      a file of that release, fetched from GitHub once and then kept (a tag's files never change);
//                         <tag> may be "latest", which redirects to the current tag
//   /[<lang>/][<resolver>/]r/<code>   a shared result (from a resolver's page: that one's): that language's page with the result's winner in its title and
//                         description (what chat apps show as the link's preview), not indexed; the page itself
//                         reads the code and shows the result (src/share.mjs)
//                         (a code it can't read: 404)
//   anything else         a bare 404; 1ms-shell puts the shared 1ms.dog 404 page in front of it
// The installer and the tool try these before GitHub, which is often slow or blocked in mainland China.

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

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed\n", { status: 405 });

    const sp = sharePath(url.pathname, KNOWN);
    if (sp && STR[sp.slug] && (!sp.id || KNOWN.has(sp.id)) && env.ASSETS) return shared(req, env, url, sp);

    if (url.pathname === "/v" || INSTALLER[url.pathname]) {
      const v = await latest(url, ctx);
      if (!v) return new Response("GitHub did not answer\n", { status: 502 });
      if (INSTALLER[url.pathname]) return release(`v${v}`, INSTALLER[url.pathname], req, ctx);
      return new Response(v + "\n", { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } });
    }

    const m = /^\/dl\/(latest|v\d+\.\d+\.\d+)\/([^/]+)$/.exec(url.pathname);
    if (m && FILE.test(m[2])) {
      if (m[1] === "latest") {
        const v = await latest(url, ctx);
        if (!v) return new Response("GitHub did not answer\n", { status: 502 });
        return new Response(null, { status: 302, headers: { location: `/dl/v${v}/${m[2]}`, "cache-control": "public, max-age=300" } });
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

// the newest release's version, from the redirect GitHub gives for /releases/latest
async function latest(url, ctx) {
  const cache = caches.default, key = new URL("/__latest", url).toString();
  const hit = await cache.match(key);
  if (hit) return (await hit.text()).trim();
  const res = await fetch(`https://github.com/${REPO}/releases/latest`, { method: "HEAD", redirect: "manual" });
  const tag = (res.headers.get("location") || "").split("/").pop();
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) return null;
  const v = tag.slice(1);
  ctx.waitUntil(cache.put(key, new Response(v, { headers: { "cache-control": "public, max-age=600" } })));
  return v;
}

async function release(tag, file, req, ctx) {
  const cache = caches.default;
  const key = new Request(new URL(`/dl/${tag}/${file}`, req.url).toString());
  let res = await cache.match(key);
  if (!res) {
    const up = await fetch(`https://github.com/${REPO}/releases/download/${tag}/${file}`, { redirect: "follow" });
    if (!up.ok) return new Response(`${tag}/${file}: GitHub answered ${up.status}\n`, { status: up.status === 404 ? 404 : 502 });
    const text = /\.(txt|sh|ps1)$/.test(file);
    // no content-length: GitHub may send the file compressed, and the body here is already decompressed
    res = new Response(up.body, {
      headers: {
        "content-type": text ? "text/plain; charset=utf-8" : "application/octet-stream",
        "cache-control": "public, max-age=31536000, immutable",
        ...(text ? {} : { "content-disposition": `attachment; filename="${file}"` }),
      },
    });
    ctx.waitUntil(cache.put(key, res.clone()));
  }
  return req.method === "HEAD" ? new Response(null, { headers: res.headers }) : res;
}
