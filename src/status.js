// The status page (/status/, /<lang>/status/): fills the table the build wrote (scripts/build.mjs statusMain) with what
// the Tokyo watch on 1ms.dog's server finds (server/watch: every resolver over UDP, UDP over IPv6, DoT, DoH and DoQ
// where it offers them, every 10 minutes): each protocol now, the last 24 hours an hour a cell, the share of probes
// that answered over a day, a week and a month, and every outage of the last 24 hours. Only on 1ms.dog itself and
// localhost (a copy hosted elsewhere doesn't ask our server).
(function () {
  "use strict";
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const D = JSON.parse($("#data").textContent), L = window.L1MS || {}, LANG = D.lang;
  const t = (k, v) => { let s = L[k] ?? k; if (v) for (const x in v) s = s.split("{" + x + "}").join(v[x]); return s; };
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };

  /* ---------- the header and help, as on the test pages (src/app.js) ---------- */
  const thBtn = $("#theme"), TH = ["system", "light", "dark"];
  const applyTheme = th => {
    if (th === "light" || th === "dark") document.documentElement.setAttribute("data-theme", th); else document.documentElement.removeAttribute("data-theme");
    thBtn.dataset.th = th; thBtn.title = t("th_" + th); thBtn.setAttribute("aria-label", t("th_" + th));
  };
  applyTheme(TH.includes(store.get("dnstest:theme")) ? store.get("dnstest:theme") : "system");
  thBtn.onclick = () => { const n = TH[(TH.indexOf(thBtn.dataset.th) + 1) % 3]; store.set("dnstest:theme", n); applyTheme(n); };
  $("#lang").onchange = e => { const l = e.target.value; store.set("dnstest:lang", l); location.href = D.paths[l]; };
  const openDlg = id => { $("#" + id).hidden = false; document.documentElement.style.overflow = "hidden"; $("#" + id + " [data-close]").focus(); };
  const closeDlg = () => { $$(".scrim").forEach(s => { s.hidden = true; }); document.documentElement.style.overflow = ""; };
  $$("[data-close]").forEach(b => { b.onclick = closeDlg; });
  $$(".scrim").forEach(s => s.addEventListener("click", e => { if (e.target === s) closeDlg(); }));
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeDlg(); });
  let helpIdx = 0;
  const qs = $$("#helpNav [data-hq]");
  $("#helpSel").innerHTML = qs.map((b, i) => `<option value="${i}">${i + 1} / ${qs.length} · ${esc(b.textContent)}</option>`).join("");
  function showHelp(i) {
    helpIdx = Math.max(0, Math.min(qs.length - 1, i));
    qs.forEach(b => b.setAttribute("aria-selected", +b.dataset.hq === helpIdx));
    $$("#helpC [data-hqb]").forEach(a => { a.hidden = +a.dataset.hqb !== helpIdx; });
    $("#helpSel").value = helpIdx;
    $$("[data-hstep]").forEach(b => { b.disabled = helpIdx + +b.dataset.hstep < 0 || helpIdx + +b.dataset.hstep >= qs.length; });
    $("#helpC").scrollTop = 0;
  }
  $("#helpBtn").onclick = () => { showHelp(helpIdx); openDlg("help"); };
  qs.forEach(b => { b.onclick = () => showHelp(+b.dataset.hq); });
  $("#helpSel").onchange = e => showHelp(+e.target.value);
  $$("[data-hstep]").forEach(b => { b.onclick = () => showHelp(helpIdx + +b.dataset.hstep); });

  /* ---------- the table ---------- */
  const meta = $("#stMeta");
  const fail = k => { meta.textContent = t(k); meta.classList.add("warn"); $("#stOut").innerHTML = ""; };
  const BASE = /(^|\.)1ms\.dog$|^localhost$/.test(location.hostname) ? "https://data.1ms.dog:2083/dns/" : "";
  if (!BASE) { fail("sp_off"); return; }
  const PROTOS = [["udp", "UDP"], ["udp6", "IPv6"], ["dot", "DoT"], ["doh", "DoH"], ["doq", "DoQ"]];
  const PN = Object.fromEntries(PROTOS);
  const SLOT = 10 * 60e3, DAY = 864e5;
  const when = ms => new Intl.DateTimeFormat(LANG, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
  const clock = ms => new Intl.DateTimeFormat(LANG, { hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
  const pct = v => v == null ? "–" : (v >= .9995 ? "100" : (v * 100).toFixed(1)) + "%";
  const upCls = v => v == null ? "" : v >= .995 ? "c-ok" : v >= .95 ? "c-mid" : "c-bad";
  const get = u => fetch(BASE + u, { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(8000) })
    .then(r => r.ok ? r.json() : Promise.reject(r));
  const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
  const now = Date.now();

  Promise.all([get("summary.json"), get(`days/${dayOf(now)}.json`).catch(() => null), get(`days/${dayOf(now - DAY)}.json`).catch(() => null)]).then(([S, today, yday]) => {
    if (!S || !S.t || !S.r) throw new Error("empty");
    const at = Date.parse(S.t), old = now - at > 4 * SLOT;
    meta.textContent = t(old ? "sp_stale" : "sp_meta", { t: when(at) });
    meta.classList.toggle("warn", old);
    // every probe of the last 24 hours, per resolver and protocol: [time, ms or -1]
    const series = (id, p) => [yday, today].flatMap(d => {
      if (!d || !d.r || !d.r[id] || !d.r[id][p]) return [];
      const t0 = Date.parse(d.date + "T00:00:00Z");
      return d.r[id][p].map((v, i) => [t0 + i * SLOT, v]).filter(([ts, v]) => v != null && ts > now - DAY && ts <= now);
    });
    const hour0 = Math.floor(now / 36e5) * 36e5 - 23 * 36e5;   // the first of the 24 hour cells
    let ok = 0, n = 0;
    const outs = [];
    for (const tr of $$("#stTable tr[data-id]")) {
      const id = tr.dataset.id, s = S.r[id];
      if (!s) continue;
      const ps = PROTOS.filter(([p]) => s[p]).map(([p]) => p);
      n++;
      if (ps.every(p => s[p].last != null)) ok++;
      // now: each protocol, its time or why it failed
      tr.querySelector(".now").innerHTML = ps.map(p => {
        const x = s[p], up = x.last != null;
        return `<span class="pc ${up ? "s-o" : "s-b"}" title="${esc(PN[p] + " · " + (up ? x.last + " ms" : t("sp_bad") + (x.err ? " (" + x.err + ")" : "")))}">${PN[p]}</span>`;
      }).join("");
      // the last 24 hours: an hour a cell, all protocols together
      const all = ps.map(p => [p, series(id, p)]);
      const cells = Array.from({ length: 24 }, (_, h) => {
        const a = hour0 + h * 36e5, b = a + 36e5;
        let cn = 0, bad = 0;
        const down = new Set();
        for (const [p, se] of all) for (const [ts, v] of se) if (ts >= a && ts < b) { cn++; if (v < 0) { bad++; down.add(PN[p]); } }
        const k = !cn ? "-" : !bad ? "o" : bad * 2 < cn ? "d" : "b";
        const tip = clock(a) + "–" + clock(b) + " · " + (!cn ? "–" : !bad ? t("sp_ok") : t(k === "d" ? "sp_part" : "sp_bad") + ": " + [...down].join(", "));
        return `<i class="s-${k}" title="${esc(tip)}"></i>`;
      });
      tr.querySelector(".bar24").innerHTML = `<span class="hb">${cells.join("")}</span>`;
      // the share that answered: the last 24 hours from the same probes; a week and a month from the summary, every
      // protocol alike (each is probed every time)
      let pn = 0, pok = 0;
      for (const [, se] of all) for (const [, v] of se) { pn++; if (v >= 0) pok++; }
      const avg = f => { const v = ps.map(p => s[p][f]).filter(x => typeof x === "number"); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
      for (const [cls, v] of [["u24", pn ? pok / pn : null], ["u7", avg("up7d")], ["u30", avg("up30d")]]) {
        const c = tr.querySelector("." + cls); c.textContent = pct(v); c.className = cls + " " + upCls(v);
      }
      // probes in a row that failed, as one outage each
      for (const [p, se] of all) for (let i = 0; i < se.length; i++) {
        if (se[i][1] >= 0) continue;
        let e = i; while (e + 1 < se.length && se[e + 1][1] < 0) e++;
        outs.push({ name: tr.dataset.name, p: PN[p], from: se[i][0], to: se[e][0], open: e === se.length - 1 && s[p].last == null, err: s[p].last == null ? s[p].err : "" });
        i = e;
      }
    }
    $("#stSum").textContent = t("sp_sum", { ok, n });
    $("#stSum").classList.toggle("warn", ok < n);
    outs.sort((a, b) => b.to - a.to);
    $("#stOut").innerHTML = outs.length ? outs.slice(0, 60).map(o => {
      const span = o.open ? when(o.from) + " – " + t("sp_now") : o.from === o.to ? when(o.from) : when(o.from) + " – " + (dayOf(o.from) === dayOf(o.to) ? clock(o.to) : when(o.to));
      return `<li><b>${esc(o.name)}</b> <span class="pc s-b">${esc(o.p)}</span> <span class="m">${esc(span)}${o.err ? " · " + esc(o.err) : ""}</span></li>`;
    }).join("") : `<li class="m">${esc(t("sp_none"))}</li>`;
  }).catch(() => fail("sp_err"));
})();
