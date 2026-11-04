// A result in a link: /r/<code> (or /<lang>/r/<code>); a resolver's page shares its own result, that one row, as
// /<resolver>/r/<code> (or /<lang>/<resolver>/r/<code>). The Worker reads the code to put the winner in the link's
// preview title; the page reads it to show the result. Nothing but the numbers goes in it: no address, no city or
// network, and the country only when the visitor ticks the box.
//
// Format 1:  1~<time, base 36 seconds>~<country or ->~<row>.<row>…
//   row:     <resolver id>_<DoH>_<UDP≈>_<DoT≈>_<uncached>_<lost %>   times in tenths of a millisecond, base 36;
//            empty: none (a resolver with no DoH time didn't answer)
// Rows are in rank order. Resolvers are named by id, never by position, so a link keeps working when the list
// changes: ids the reader doesn't know are skipped. A later format gets a new first number; old links keep theirs.

export const FORMAT = 1;
const n36 = v => v == null ? "" : Math.max(0, Math.round(v * 10)).toString(36);
const p36 = s => s === "" || s == null ? null : /^[0-9a-z]+$/.test(s) ? parseInt(s, 36) / 10 : NaN;

// { ts, cc, rows: [{ id, doh, udp, dot, unc, loss }] } → code
export function encode({ ts, cc, rows }) {
  const body = rows.map(r => [r.id, n36(r.doh), n36(r.udp), n36(r.dot), n36(r.unc), r.loss ? Math.round(r.loss * 100).toString(36) : ""].join("_"));
  return [FORMAT, Math.round(ts / 1000).toString(36), /^[A-Z]{2}$/.test(cc || "") ? cc : "-", body.join(".")].join("~");
}

// code → { v, ts, cc, rows } with only the ids in `known`, or null when it isn't a result this page can read
export function decode(code, known) {
  if (typeof code !== "string" || code.length > 4000) return null;
  const [v, ts, cc, body] = code.split("~");
  if (v !== "1" || !/^[0-9a-z]+$/.test(ts || "") || body === undefined) return null;
  const rows = [];
  for (const part of body ? body.split(".") : []) {
    const [id, doh, udp, dot, unc, loss] = part.split("_");
    if (!known.has(id) || rows.some(r => r.id === id)) continue;
    const r = { id, doh: p36(doh), udp: p36(udp), dot: p36(dot), unc: p36(unc), loss: loss ? parseInt(loss, 36) / 100 : 0 };
    if ([r.doh, r.udp, r.dot, r.unc, r.loss].some(Number.isNaN)) return null;
    rows.push(r);
  }
  return rows.length ? { v: 1, ts: parseInt(ts, 36) * 1000, cc: /^[A-Z]{2}$/.test(cc) ? cc : "", rows } : null;
}

// /[<lang folder>/][<resolver>/]r/<code> → { slug, id, code }, or null. With a single folder, `ids` (the resolver ids)
// tells a resolver from a language; no resolver id is also a language folder.
export function sharePath(pathname, ids) {
  const m = /^\/(?:([a-z0-9-]+)\/)?(?:([a-z0-9-]+)\/)?r\/([0-9A-Za-z~._-]+)\/?$/.exec(pathname);
  if (!m) return null;
  let [, slug = "", id = ""] = m;
  if (slug && !id && ids && ids.has(slug)) [slug, id] = ["", slug];
  return { slug, id, code: decodeURIComponent(m[3]) };
}

// a number as the page shows it: one decimal below 10 ms
export const fmt = ms => ms == null ? "–" : ms < 10 ? ms.toFixed(1) : String(Math.round(ms));
