// The page's side of the shared "Report a problem" dialog (1ms-shell docs/tool-contract.md, 报告问题): when the dialog
// opens it asks window.msReport() for what the visitor saw. This builds that answer: one line, the result as JSON that
// reproduces it, and the readings most often called wrong, as one-tap lines. The privacy rule is the share link's:
// no address and nothing the share dialog only adds when ticked — an address here is masked, and the visitor's own
// country is not in it at all (resolver names, their countries and the times are).
//
// The dialog keeps summary to 300 characters, and sends data only when its pretty-printed JSON fits 6 KB (past that
// just the summary goes), so the row objects here stay short: times to 0.1 ms, flags only when true.

const round1 = v => v == null || Number.isNaN(v) ? undefined : Math.round(v * 10) / 10;

// an address with its last part masked: 203.0.113.7 → 203.0.113.x · 2001:db8::7 → 2001:db8::x
export function maskIP(ip) {
  ip = String(ip || "").trim();
  if (!ip) return "";
  const v4 = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(ip);
  if (v4) return v4[1] + ".x";
  if (/:/.test(ip)) return ip.slice(0, ip.lastIndexOf(":") + 1) + "x";
  return "";
}

// Everything the dialog gets. `last` is the result as the page showed it (src/app.js: snapshot), `targets` the measured
// targets, `mine` the resolver this device uses (l.1ms.dog's answer), `nodes` which node of each resolver served the
// visitor. Strings: t / tn / country are the page's own. null when there is no result yet.
export function reportContext({ last, targets, resolvers, mine, nodes, focus, lang, path, viewing, t, tn, fmt, country }) {
  if (!last || !Array.isArray(last.rows) || !last.rows.length) return null;
  const byId = id => resolvers.find(r => r.id === id);
  const dohOf = id => targets.find(x => x.r.id === id && x.kind === "doh");
  const winner = last.rows.find(r => r.doh != null), win = winner && byId(winner.id);

  // the rows as shown, in the order shown; fast enough to reproduce a wrong reading without the raw round samples
  const rows = last.rows.map(r => {
    const d = dohOf(r.id), o = { id: r.id };
    for (const k of ["doh", "udp", "dot", "unc"]) if (r[k] != null) o[k] = round1(r[k]);
    if (r.loss) o.loss = Math.round(r.loss * 100) / 100;
    if (d && d.up === false) o.down = 1;
    if (d && d.rewrites) o.rewrite = 1;
    return o;
  });
  const down = rows.filter(r => r.down).map(r => r.id), rewrites = rows.filter(r => r.rewrite).map(r => r.id);

  // per resolver: which of its servers answered, as country and network only — never the address it answered from
  const node = {};
  for (const [id, s] of Object.entries(nodes || {})) {
    if (!s || !(s.first || s.ecs)) continue;
    const cc = s.first && s.first.cc, asn = s.first && s.first.asn;
    if (!cc && !asn && !s.ecs) continue;
    node[id] = { cc: cc || undefined, asn: asn || undefined, ecs: s.ecs || undefined };
  }

  const data = {
    v: 1, tool: "dns", lang, path, focus: focus && focus.id || undefined, viewing: viewing || undefined,
    at: last.ts ? new Date(last.ts).toISOString() : undefined,
    winner: winner ? { id: winner.id, doh: round1(winner.doh), udp: round1(winner.udp), dot: round1(winner.dot),
      unc: round1(winner.unc), loss: winner.loss || undefined } : null,
    rows,
    mine: mine && mine.first ? { org: mine.first.org || undefined, cc: mine.first.cc || undefined, asn: mine.first.asn || undefined,
      ip: maskIP(mine.first.ip) || undefined, ecs: mine.ecs || undefined } : null,
    nodes: node,
  };

  // the line the issue starts with: who won and by how much, and what the page found worth a look
  const parts = [];
  if (!win) parts.push(t("none_up"));
  else if (focus) parts.push(t("share_desc_self", { name: win.name, ms: fmt(winner.doh) }));
  else parts.push(t("emb_head", { name: win.name, ms: fmt(winner.doh) }));
  const second = win && last.rows.find(r => r.doh != null && r !== winner);
  if (second) parts.push(t("win_sub", { n: rows.filter(r => r.doh != null).length, d: fmt(second.doh - winner.doh), second: byId(second.id).name }));
  if (down.length) parts.push(tn("emb_down", { n: down.length }));
  if (rewrites.length) parts.push(t("emb_rewrite", { name: byId(rewrites[0]).name }));
  if (win && !win.dnssec) parts.push(t("emb_nodnssec", { name: win.name }));
  const summary = parts.join(" · ").slice(0, 300);

  // one-tap lines: what a visitor most often says is wrong. The resolver their device uses (and whether it is in the
  // wrong country is for them to see against the one they know), the winner, servers that gave no answer or a wrong
  // one, lost queries, the first few readings, and where the resolvers served them from.
  const sep = /^(zh|ja)/.test(lang) ? "：" : ": ", picks = [];
  const push = s => { s = String(s || "").trim().slice(0, 60); if (s && !picks.includes(s) && picks.length < 8) picks.push(s); };
  if (mine === null) push(t("mine_fail"));
  else if (mine && mine.first) push([t("mine_h"), [mine.first.org || maskIP(mine.first.ip), mine.first.cc && country(mine.first.cc)].filter(Boolean).join(" · ")].join(sep));
  if (win) push([t("best_k"), win.name + " " + fmt(winner.doh) + " ms"].join(sep));
  down.slice(0, 2).forEach(id => push([byId(id).name, t("e_fail")].join(sep)));
  rewrites.slice(0, 2).forEach(id => push([byId(id).name, t("tip_rewrite")].join(sep)));
  last.rows.forEach(r => r.loss && push([byId(r.id).name, t("tip_loss", { p: Math.round(r.loss * 100) })].join(sep)));
  rows.filter(r => r.doh != null && r !== rows[0]).slice(0, 3).forEach(r => push([byId(r.id).name, fmt(r.doh) + " ms"].join(sep)));
  Object.keys(node).slice(0, 3).forEach(id => node[id].cc && push([byId(id).name, t("node_h") + " " + country(node[id].cc)].join(sep)));

  return { summary, data, picks: picks.slice(0, 8) };
}
