// DNS Test page. Every resolver's row is in the HTML from the start; the test (src/measure.mjs) fills them as answers
// come in. The rows stay sorted by the time so far and the hero names the leader, both as the answers come in; at the
// end, by the final medians. On a resolver's own page (D.focus) the hero follows that resolver instead: its times and
// its rank. Strings: window.L1MS.
import { RESOLVERS, NAMES, NXZONE } from "./resolvers.mjs";
import { targets, run, median, loss, score } from "./measure.mjs";
import { FORMATS, FORMAT_NAMES, items as ruleItems, inline as ruleInline, remote as ruleRemote } from "./rules.mjs";
import { encode as encodeShare, decode as decodeShare, sharePath } from "./share.mjs";
import { ABOUT } from "./about.mjs";
import { regionName } from "./region.mjs";
import { dohURL } from "./dns.mjs";

(function () {
  "use strict";
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const D = JSON.parse($("#data").textContent);
  const FOCUS = D.focus ? RESOLVERS.find(r => r.id === D.focus) : null;
  // what this page tests: a resolver's page only that one (the home page tests them all), the others aren't asked
  const LIST = FOCUS ? [FOCUS] : RESOLVERS;
  const L = window.L1MS || {};
  const t = (k, v) => { let s = L[k] ?? k; if (v) for (const x in v) s = s.split("{" + x + "}").join(v[x]); return s; };
  // a sentence with a count {n}: key_one, key_few… where the language has that form for n (1ms-shell docs/translation.md,
  // "复数"), else the key itself
  const PL = new Intl.PluralRules(D.lang), tn = (k, v) => { const f = k + "_" + PL.select(v.n); return t(L[f] != null ? f : k, v); };
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
  const K = { theme: "dnstest:theme", lang: "dnstest:lang", rules: "dnstest:rules" };

  /* ---------- Connection Checkup (check.1ms.dog): the page embedded in its report ---------- */
  // ?embed=checkup counts only in a frame of the origin the shell names in <meta name="check">, the only one the
  // results go to; anywhere else the page is the usual one (1ms-shell docs/checkup.md). Embedded: the test and its
  // top rows only, no dialogs, started at once.
  const EMBED = (() => {
    const m = document.querySelector('meta[name="check"]');
    if (new URLSearchParams(location.search).get("embed") !== "checkup" || !m || window.parent === window) return "";
    try { const o = new URL(m.content).origin; return new URL(document.referrer).origin === o ? o : ""; } catch (e) { return ""; }
  })();
  const post = msg => { if (EMBED) window.parent.postMessage({ ms: "checkup", v: 1, tool: "dns", ...msg }, EMBED); };
  if (EMBED) {
    document.documentElement.classList.add("embed");
    let h = 0;
    new ResizeObserver(() => { const n = Math.ceil($(".app").getBoundingClientRect().height); if (n !== h) post({ type: "size", height: h = n }); }).observe($(".app"));
  }

  /* ---------- theme and language (synced across the 1ms.dog tools) ---------- */
  const thBtn = $("#theme"), TH = ["system", "light", "dark"];
  const applyTheme = th => {
    if (th === "light" || th === "dark") document.documentElement.setAttribute("data-theme", th); else document.documentElement.removeAttribute("data-theme");
    thBtn.dataset.th = th; thBtn.title = t("th_" + th); thBtn.setAttribute("aria-label", t("th_" + th));
  };
  applyTheme(TH.includes(store.get(K.theme)) ? store.get(K.theme) : "system");
  thBtn.onclick = () => { const n = TH[(TH.indexOf(thBtn.dataset.th) + 1) % 3]; store.set(K.theme, n); applyTheme(n); };
  $("#lang").onchange = e => { const l = e.target.value; store.set(K.lang, l); location.href = D.paths[l] + location.search; };

  /* ---------- dialogs ---------- */
  function openDlg(id) { $("#" + id).hidden = false; document.documentElement.style.overflow = "hidden"; $("#" + id + " [data-close]").focus(); }
  function closeDlg() { $$(".scrim").forEach(s => { s.hidden = true; }); document.documentElement.style.overflow = ""; }
  $$("[data-close]").forEach(b => { b.onclick = closeDlg; });
  $$(".scrim").forEach(s => s.addEventListener("click", e => { if (e.target === s) closeDlg(); }));
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeDlg(); });
  // help: one answer at a time; a picker with previous / next on phones
  let helpIdx = 0;
  const helpN = $$("#helpNav [data-hq]").length;
  $("#helpSel").innerHTML = $$("#helpNav [data-hq]").map((b, i) => `<option value="${i}">${i + 1} / ${helpN} · ${esc(b.textContent)}</option>`).join("");
  function showHelp(i) {
    helpIdx = Math.max(0, Math.min(helpN - 1, i));
    $$("#helpNav [data-hq]").forEach(b => b.setAttribute("aria-selected", +b.dataset.hq === helpIdx));
    $$("#helpC [data-hqb]").forEach(a => { a.hidden = +a.dataset.hqb !== helpIdx; });
    $("#helpSel").value = helpIdx;
    $$("[data-hstep]").forEach(b => { b.disabled = helpIdx + +b.dataset.hstep < 0 || helpIdx + +b.dataset.hstep >= helpN; });
    $("#helpC").scrollTop = 0;
  }
  $("#helpBtn").onclick = () => { showHelp(helpIdx); openDlg("help"); };
  // a button that opens one answer (a resolver's page: how to set it up)
  $$("[data-help]").forEach(b => { b.onclick = () => { showHelp(+b.dataset.help); openDlg("help"); }; });
  $$("#helpNav [data-hq]").forEach(b => { b.onclick = () => showHelp(+b.dataset.hq); });
  $("#helpSel").onchange = e => showHelp(+e.target.value);
  $$("[data-hstep]").forEach(b => { b.onclick = () => showHelp(helpIdx + +b.dataset.hstep); });

  /* ---------- direct rules for proxy tools ---------- */
  // this site's address for the remote rule sets; the public one when running locally
  const SITE = /^(localhost|127\.|\[)/.test(location.hostname) ? "https://dns.1ms.dog" : location.origin;
  let ruleFmt = FORMATS.includes(store.get(K.rules)) ? store.get(K.rules) : "clash";
  const codeBox = text => `<div class="codebox"><textarea readonly spellcheck="false" rows="${Math.min(14, text.split("\n").length + 1)}">${esc(text)}</textarea><button class="btn" type="button" data-copyta>${esc(t("copy"))}</button></div>`;
  function renderRules() {
    const notes = { top: t("rules_top"), fakeip: t("rules_fakeip") }, n = ruleItems().length;
    $("#ruleTabs").innerHTML = FORMATS.map(f => `<button type="button" role="tab" data-f="${f}" aria-selected="${f === ruleFmt}">${esc(FORMAT_NAMES[f] || t("rules_plain"))}</button>`).join("");
    const r = ruleRemote(ruleFmt, SITE, notes);
    $("#ruleBody").innerHTML = r
      ? `<section class="rblk"><b>${esc(t("rules_remote_h"))}</b><span class="note">${esc(t("rules_remote_s"))}</span>${codeBox(r)}</section>` +
        `<details class="rblk"><summary>${esc(t("rules_inline_h", { n }))}</summary>${codeBox(ruleInline(ruleFmt, notes))}</details>`
      : `<section class="rblk"><b>${esc(t("rules_inline_only", { n }))}</b>${codeBox(ruleInline(ruleFmt, notes))}</section>`;
  }
  $("#rulesBtn").onclick = () => { renderRules(); openDlg("rules"); };
  $("#ruleTabs").addEventListener("click", e => { const b = e.target.closest("[data-f]"); if (b) { ruleFmt = b.dataset.f; store.set(K.rules, ruleFmt); renderRules(); } });
  $("#ruleBody").addEventListener("click", e => {
    const b = e.target.closest("[data-copyta]"); if (!b) return;
    const ta = b.parentNode.querySelector("textarea");
    (navigator.clipboard ? navigator.clipboard.writeText(ta.value) : Promise.reject()).catch(() => { ta.select(); document.execCommand("copy"); })
      .finally(() => { b.textContent = t("copied"); setTimeout(() => { b.textContent = t("copy"); }, 1200); });
  });

  /* ---------- what to enter: a popover from the button next to the leader's name ---------- */
  function useOpen(on) { $("#use").hidden = !on; $("#useBtn").setAttribute("aria-expanded", on); }
  $("#useBtn").onclick = e => { e.stopPropagation(); useOpen($("#use").hidden); };
  document.addEventListener("click", e => { if (!$("#use").hidden && !e.target.closest(".use-w")) useOpen(false); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") useOpen(false); });

  /* ---------- the other 1ms.dog tools a DNS page leads to (on 1ms.dog only) ---------- */
  // Each where the shell says it is (a self-hosted copy has none), in the page's language: Network Checkup's full run,
  // Who Are You's DNS leak check
  // (which resolver this device really uses: beside the list, and on a resolver's page once it is set up), every AS
  // number to ASN Lookup, and the speed test. A link to another tool ends in the site's external-link icon, except
  // where the link is a value itself (an AS number): that one is underlined, its title says where it goes.
  const tool = n => { const m = document.querySelector(`meta[name="${n}"]`); return m ? m.content.replace(/\/+$/, "") + D.home : ""; };
  const link = (el, href) => { if (el && href) { el.href = href; el.hidden = false; } };
  link($("#whoLink"), tool("who") && tool("who") + "dns-leak/");
  link($("#leakLink"), tool("who") && tool("who") + "dns-leak/");
  link($("#speedLink"), tool("speed"));
  // the full checkup that runs this test among the others, beside the answer; not inside that checkup's own report
  if (!EMBED) link($("#checkLink"), tool("check"));
  if (tool("asn")) $$("[data-asn]").forEach(s => {
    const a = Object.assign(document.createElement("a"), { className: "val", title: t("asn_tip", { as: "AS" + s.dataset.asn }), href: tool("asn") + "AS" + s.dataset.asn, target: "_blank", rel: "noopener", textContent: s.textContent });
    s.replaceWith(a);
  });

  /* ---------- the command-line tool's install line ---------- */
  // any copy button copies the command next to it
  document.addEventListener("click", e => {
    const b = e.target.closest && e.target.closest("[data-copy]");
    if (!b || !navigator.clipboard) return;
    navigator.clipboard.writeText(b.querySelector("code").textContent).then(() => {
      b.classList.add("done"); b.title = t("copied");
      setTimeout(() => { b.classList.remove("done"); b.title = t("copy"); }, 1200);
    }, () => {});
  });
  $$("[data-cli]").forEach(b => { b.onclick = () => openDlg("cli"); });

  /* ---------- tooltips (data-why) ---------- */
  let tipEl;
  function showTip(el) {
    if (!tipEl) { tipEl = document.body.appendChild(Object.assign(document.createElement("div"), { className: "tip" })); addEventListener("scroll", () => tipEl.classList.remove("on"), { passive: true }); }
    tipEl.textContent = el.dataset.why;
    const b = el.getBoundingClientRect(), w = tipEl.offsetWidth;
    tipEl.style.left = Math.max(8, Math.min(innerWidth - w - 8, b.left + b.width / 2 - w / 2)) + "px";
    tipEl.style.top = b.bottom + 6 + "px"; tipEl.classList.add("on");
  }
  document.addEventListener("mouseover", e => { const el = e.target.closest && e.target.closest("[data-why]"); if (el) showTip(el); else if (tipEl) tipEl.classList.remove("on"); });
  document.addEventListener("focusin", e => { const el = e.target.closest && e.target.closest("[data-why]"); if (el) showTip(el); });

  /* ---------- rows: click to see what to enter ---------- */
  const ROW = Object.fromEntries($$(".tr[data-r]").map(r => [r.dataset.r, r]));
  const DET = Object.fromEntries($$(".td[data-d]").map(r => [r.dataset.d, r]));
  function toggle(id) {
    const open = DET[id].hidden;
    DET[id].hidden = !open; ROW[id].setAttribute("aria-expanded", open);
  }
  for (const id in ROW) {
    ROW[id].addEventListener("click", () => toggle(id));
    ROW[id].addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(id); } });
  }

  // copy an address: click any code in the hero or the details
  document.addEventListener("click", e => {
    const c = e.target.closest && e.target.closest("code");
    if (!c || c.closest("[data-copy]") || !navigator.clipboard) return;
    e.stopPropagation();
    navigator.clipboard.writeText(c.textContent).then(() => { c.classList.add("copied"); c.dataset.why = t("copied"); showTip(c); setTimeout(() => { c.classList.remove("copied"); delete c.dataset.why; tipEl && tipEl.classList.remove("on"); }, 1200); }, () => {});
  }, true);

  /* ---------- numbers ---------- */
  const fmt = ms => ms == null ? "–" : ms < 10 ? ms.toFixed(1) : String(Math.round(ms));
  const tier = ms => ms == null ? "" : ms <= 20 ? "t1" : ms <= 50 ? "t2" : ms <= 100 ? "t3" : ms <= 200 ? "t4" : "t5";
  const num = (ms, extra = "") => `<b class="n ${tier(ms)}">${fmt(ms)}</b>${extra}`;

  /* ---------- the test ---------- */
  let TS = [], RUN = null;
  const byR = id => TS.filter(x => x.r.id === id);
  const tgt = (id, kind) => TS.find(x => x.r.id === id && x.kind === kind);

  // the time a row shows for a target: its median so far; a mark when queries were lost
  function cellOf(x, est) {
    if (!x || x.up === null) return '<span class="dots">…</span>';
    if (!x.up) return `<span class="fail"${x.kind === "doh" ? tkWhy(x.r.id) : ""}>${esc(t(x.err === "timeout" ? "e_timeout" : "e_fail"))}</span>`;
    const m = x.cached.length ? median(x.cached) : x.warm.length ? median(x.warm) : null;
    if (m == null) return '<span class="dots">…</span>';
    const l = loss(x);
    const mark = l > 0 ? `<i class="lost" data-why="${esc(t("tip_loss", { p: Math.round(l * 100) }))}">!</i>` : "";
    return (est ? '<i class="ap">≈</i>' : "") + num(m, mark);
  }
  // where a resolver's UDP or DoT estimate comes from; DoQ's is its DoT one (the same server, on UDP instead of TCP)
  const estKey = (r, k) => k === "doq" ? r.doq && r.est.dot : r.est[k];
  const estOf = (r, k) => estKey(r, k) === "doh" ? tgt(r.id, "doh") : estKey(r, k) === "ip" ? tgt(r.id, "ip") : null;
  function fillRow(id) {
    const r = RESOLVERS.find(x => x.id === id), row = ROW[id], doh = tgt(id, "doh");
    if (!row) return;
    row.querySelector('[data-c="doh"]').innerHTML = cellOf(doh);
    for (const k of ["udp", "dot", "doq"]) {
      const c = row.querySelector(`[data-c="${k}"]`);
      if (!estKey(r, k)) { c.innerHTML = `<span class="m" data-why="${esc(t(r[k] ? "tip_noest" : "tip_none"))}">–</span>`; continue; }
      c.innerHTML = cellOf(estOf(r, k), true);
    }
    // uncached: the DoH target's, marked when the resolver answers a missing name with an address
    const u = doh && doh.up ? median(doh.uncached) : null;
    row.querySelector('[data-c="unc"]').innerHTML = doh && doh.rewrites ? `<span class="fail" data-why="${esc(t("tip_rewrite"))}">${esc(t("rewrites"))}</span>`
      : u == null ? (doh && doh.up === false ? '<span class="m">–</span>' : '<span class="dots">…</span>') : `<span class="nu">${fmt(u)}</span>`;
    row.classList.toggle("wait", !doh || doh.up === null);
    row.classList.toggle("down", !!doh && doh.up === false);
    tkRow(id, !!doh && doh.up === false);
  }

  let total = 0, done = 0, t0 = 0, sentPc = -1;
  function progress() {
    $("#prog i").style.transform = `scaleX(${total ? done / total : 0})`;
    $("#progTxt").textContent = t("progress", { n: done, of: total });
    // to the report at most once a percent
    const pc = total ? Math.floor(done / total * 100) : 0;
    if (EMBED && pc !== sentPc) { sentPc = pc; post({ type: "progress", done, total, text: $("#progTxt").textContent }); }
  }

  function resetHero() {
    if (!FOCUS) { $("#winName").innerHTML = '<i class="skl"></i>'; $("#winIc").removeAttribute("style"); }
    $("#winSub").innerHTML = FOCUS ? esc(t("f_wait")) : "&nbsp;";
    $$(".win-m li").forEach(li => { li.querySelector("b").className = ""; li.querySelector("b").textContent = "–"; });
    useOpen(false); $(".use-w").classList.remove("on");
    $("#winK").textContent = t(FOCUS ? "f_run" : "lead_k");
    $("#alt").innerHTML = "&nbsp;";
  }

  // put the rows in order: fastest DoH first, then the ones with no answer yet, then the ones that didn't answer.
  // Rows that move slide from where they were (transform only, nothing else on the page moves).
  let order = RESOLVERS.map(r => r.id);
  function sortRows(ranked) {
    const tbl = $("#tbl");
    if (!tbl) return;
    const wait = RESOLVERS.filter(r => !ranked.includes(r) && !ROW[r.id].classList.contains("down"));
    const down = RESOLVERS.filter(r => !ranked.includes(r) && ROW[r.id].classList.contains("down"));
    const next = [...ranked, ...wait, ...down];
    next.forEach((r, i) => { ROW[r.id].querySelector(".rk").textContent = ranked.includes(r) ? i + 1 : ""; ROW[r.id].classList.toggle("more", i >= 5); });
    if (next.map(r => r.id).join() === order.join()) return;
    order = next.map(r => r.id);
    const els = next.flatMap(r => [ROW[r.id], DET[r.id]]);
    const before = new Map(els.map(e => [e, e.getBoundingClientRect().top]));
    for (const e of els) tbl.appendChild(e);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const moved = [];
    for (const e of els) {
      const dy = before.get(e) - e.getBoundingClientRect().top;
      if (!dy || e.hidden) continue;
      e.style.transition = "none"; e.style.transform = `translateY(${dy}px)`;
      moved.push(e);
    }
    // one forced style flush, then the slide back starts in the same task: no animation frame needed, so a row can't
    // be left halfway when the tab is in the background
    if (moved.length) void $("#tbl").offsetHeight;
    for (const e of moved) { e.style.transition = "transform .45s cubic-bezier(.2,.8,.2,1)"; e.style.transform = ""; }
  }
  // while the test runs: by the time so far, at most every 600 ms so the list doesn't shuffle on every answer
  let sortAt = 0, sortTimer = 0;
  function sortLive() {
    if (sortTimer) return;
    sortTimer = setTimeout(() => {
      sortTimer = 0; sortAt = performance.now();
      if (!RUN) return;
      sortRows(RESOLVERS.map(r => ({ r, s: soFar(tgt(r.id, "doh")) })).filter(x => x.s != null).sort((a, b) => a.s - b.s).map(x => x.r));
    }, Math.max(0, 600 - (performance.now() - sortAt)));
  }

  // A target's time so far: the median of its rounds once it has two, before that the cache-filling queries of the
  // warm-up (also on the open connection). At the end only the rounds count (score()).
  const soFar = x => !x || !x.up ? null : x.cached.length >= 2 ? median(x.cached) * (1 + 3 * loss(x)) : x.warm.length ? median(x.warm) : null;
  const msSoFar = x => !x || !x.up ? null : x.cached.length >= 2 ? median(x.cached) : x.warm.length ? median(x.warm) : null;

  // The hero: while the test runs, whoever leads so far ("fastest so far"), with its numbers and addresses, so the
  // page shows its answer from the first seconds; at the end, the result.
  function hero(final) {
    const val = final ? x => score(x) : soFar, ms = final ? x => x && x.up ? median(x.cached) : null : msSoFar;
    const rs = LIST.map(r => ({ r, s: val(tgt(r.id, "doh")) })).filter(x => x.s != null).sort((a, b) => a.s - b.s);
    $("#winK").textContent = t(FOCUS ? (final ? "f_done" : "f_run") : final ? "best_k" : "lead_k");
    if (!rs.length && !FOCUS) { if (final) $("#winName").textContent = t("none_up"); return rs; }
    const win = FOCUS || rs[0].r, doh = tgt(win.id, "doh");
    if ($("#winName").textContent !== win.name) { $("#winName").textContent = win.name; $("#winIc").style.backgroundImage = `url(/icons/${win.id}.png)`; }
    if (FOCUS) {
      // its own numbers only; at the end, how long a name it hasn't cached takes (or that it rewrites missing names)
      const u = doh && doh.up && doh.uncached.length ? median(doh.uncached) : null;
      $("#winSub").textContent = doh && doh.up === false ? t("f_down") : !rs.length ? t("f_wait")
        : !final ? " " : doh.rewrites ? t("tip_rewrite") : u != null ? t("f_sub", { unc: fmt(u) }) : " ";
    } else $("#winSub").textContent = !final ? tn("lead_sub", { n: rs.length, of: RESOLVERS.length })
      : rs[1] ? t("win_sub", { n: rs.length, d: fmt(ms(tgt(rs[1].r.id, "doh")) - ms(doh)), second: rs[1].r.name }) : "";
    const w = { doh: doh, udp: estOf(win, "udp"), dot: estOf(win, "dot") };
    for (const k in w) {
      const b = $(`.win-m [data-w="${k}"] b`), m = ms(w[k]);
      // not measured (yet): why, once it is known that there won't be a number
      if (m == null) { b.className = "na"; b.textContent = "–"; if (final || !w[k] || w[k].up === false) b.dataset.why = t(k === "doh" ? "e_fail" : win[k] ? "tip_noest" : "tip_none"); else delete b.dataset.why; continue; }
      b.className = "n " + tier(m); delete b.dataset.why; b.textContent = (k === "doh" ? "" : "≈ ") + fmt(m) + " ms";
    }
    // what to enter, by what the device likely supports first
    const use = [win.udp && [t("use_udp"), win.udp.join("  ")], win.dot && [t("use_dot"), win.dot], [t("use_doh"), win.doh]].filter(Boolean).slice(0, 3);
    $("#useBtn").disabled = false;
    $(".use-w").classList.toggle("on", final);
    $$("#use li").forEach((li, i) => {
      li.querySelector("span").textContent = use[i] ? use[i][0] : "";
      li.querySelector("code").textContent = use[i] ? use[i][1] : "";
      li.classList.toggle("none", !use[i]);
    });
    // the fastest plain DNS, when it isn't the winner, for whoever can only set plain DNS servers
    const udp = RESOLVERS.map(r => ({ r, x: estOf(r, "udp") })).filter(o => o.x && val(o.x) != null).sort((a, b) => val(a.x) - val(b.x))[0];
    const lines = [];
    if (udp && udp.r !== win && !FOCUS) lines.push(t("alt_udp", { name: `<b>${esc(udp.r.name)}</b>`, ms: fmt(ms(udp.x)), ips: esc(udp.r.udp.join(", ")) }));
    if (final && CC === "CN") lines.push(t("cn_note"));
    $("#alt").innerHTML = lines.join(" ") || "&nbsp;";
    return rs;
  }
  let heroQueued = false;
  const heroSoon = () => { if (!heroQueued) { heroQueued = true; requestAnimationFrame(() => { heroQueued = false; if (RUN) hero(false); }); } };

  function finish(names) {
    const rs = hero(true);
    sortRows(rs.map(x => x.r));
    $("#prog").classList.add("end");
    $("#progTxt").textContent = t("done", { s: ((performance.now() - t0) / 1000).toFixed(0), names: names.join(", ") });
    $("#rerun").disabled = false;
    LAST = snapshot(rs);
    $("#shareBtn").hidden = !rs.length;   // nothing to share when nothing answered
    if (EMBED) post(rs.length ? checkup(rs) : { type: "error", text: t("none_up") });
    else askNodes();
  }

  // The result for the Checkup report: the hero's sentence, its numbers, what is worth a look, and the facts its
  // cross-tool rules read (docs/checkup.md, "facts"). No grade: the test ranks resolvers, it doesn't grade the network.
  function checkup(rs) {
    const ms = x => x && x.up && x.cached.length ? median(x.cached) : null, val = m => fmt(m) + " ms";   // the UDP and DoT labels say they are estimates
    const win = rs[0].r, doh = tgt(win.id, "doh"), w = ms(doh), udp = ms(estOf(win, "udp")), dot = ms(estOf(win, "dot"));
    const second = rs[1] && rs[1].r, w2 = second && ms(tgt(second.id, "doh"));
    const stats = [{ label: t("c_doh"), value: val(w) }, udp != null && { label: t("c_udp"), value: val(udp) },
      dot != null && { label: t("c_dot"), value: val(dot) }, second && { label: second.name, value: val(w2) }].filter(Boolean).slice(0, 4);
    const down = RESOLVERS.filter(r => { const x = tgt(r.id, "doh"); return x && x.up === false; }).length;
    const plain = RESOLVERS.map(r => ({ r, x: estOf(r, "udp") })).filter(o => ms(o.x) != null).sort((a, b) => score(a.x) - score(b.x))[0];
    const findings = [
      doh.rewrites && { level: "warn", text: t("emb_rewrite", { name: win.name }) },
      !win.dnssec && { level: "warn", text: t("emb_nodnssec", { name: win.name }) },
      down && { level: "warn", text: tn("emb_down", { n: down }) },
      CC === "CN" && { level: "warn", text: t("cn_note") },
      second && { level: "ok", text: t("win_sub", { n: rs.length, d: fmt(w2 - w), second: second.name }) },
      plain && plain.r !== win && { level: "ok", text: t("alt_udp", { name: plain.r.name, ms: fmt(ms(plain.x)), ips: plain.r.udp.join(", ") }) },
    ].filter(Boolean).slice(0, 4);
    const cc = (ABOUT[win.id] || {}).hq || win.cc;
    return { type: "result", lang: D.lang, path: D.home + "r/" + encodeShare({ ...LAST, cc: "" }), grade: null, score: null,
      headline: t("emb_head", { name: win.name, ms: fmt(w) }), stats, findings,
      // resolverCountry: where the device's own resolver is, as l.1ms.dog saw it (its country only, never its address)
      facts: { winner: win.id, winnerMs: Math.round(w * 10) / 10, ...(cc && { winnerCountry: cc }), dnssec: !!win.dnssec,
        ...(MINE && MINE.first.cc && { resolverCountry: MINE.first.cc }) } };
  }

  // where the visitor is: for the mainland China note, and for the share card when the visitor ticks "show my country".
  // The shell's /_ms/me on 1ms.dog; elsewhere (self-hosted, local) Cloudflare's own trace, on sites it serves.
  let CC = "";
  const cc2 = s => /^[A-Z]{2}$/.test(s || "") ? s : "";
  fetch("/_ms/me", { cache: "no-store" }).then(r => { if (!r.ok) throw r; return r.json(); }).then(j => { CC = cc2(j.country); })
    .catch(() => fetch("/cdn-cgi/trace", { cache: "no-store" }).then(r => r.ok ? r.text() : "").then(s => { CC = cc2((/\bloc=([A-Z]{2})/.exec(s) || [])[1]); }))
    .catch(() => {}).then(() => { if (MINE) renderMine(); });
  const country = cc => { try { return regionName(cc, D.lang); } catch (e) { return cc; } };

  /* ---------- from the 1ms.dog server: the resolver this device really uses, each one's node, Tokyo's view ---------- */
  // l.1ms.dog is 1ms.dog's own authoritative DNS (server/dns). A fresh name under it, looked up by the browser (through
  // the device's resolver) or sent through a resolver's DoH, is a query that reaches it from that resolver; its API says
  // from which address, network and country, and whether it passed on the visitor's network (ECS). Shown on the
  // visitor's own page only: none of it goes into the share link or card. Tokyo's view is server/watch's summary.
  const LZ = "l.1ms.dog";
  const tok = () => [...crypto.getRandomValues(new Uint8Array(18))].map(b => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
  const getJSON = (u, ms) => fetch(u, { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(ms) })
    .then(r => r.ok ? r.json() : Promise.reject(r));
  // one resolver's queries: the first one is the one whose answer was used, so it decides about ECS (1ms-shell cdn's
  // finding: China Unicom asks first without ECS, then from other addresses with it)
  function seen(hits) {
    if (!hits || !hits.length) return null;
    const hs = [...hits].sort((a, b) => a.ms - b.ms), first = hs[0], later = hs.find(h => h.ecs);
    return { first, ips: [...new Set(hs.map(h => h.ip))], ecs: first.ecs ? "yes" : later ? "late" : "no", net: first.ecs || (later ? later.ecs : "") };
  }
  const asnHTML = n => tool("asn") ? `<a class="val" href="${esc(tool("asn") + "AS" + n)}" target="_blank" rel="noopener" title="${esc(t("asn_tip", { as: "AS" + n }))}">AS${n}</a>` : "AS" + n;
  const nodeHTML = s => !s ? esc(t("node_none")) : [s.first.cc && esc(country(s.first.cc)), s.first.asn && asnHTML(s.first.asn), s.first.org && esc(s.first.org),
    esc(t(s.ecs === "no" ? "node_noecs" : "node_ecs"))].filter(Boolean).join(" · ");

  // the device's own resolver: undefined while asking, null when it couldn't be told
  let MINE;
  function renderMine() {
    if (MINE === undefined) { $("#mineR").textContent = t("mine_wait"); $("#mineE").textContent = ""; return; }
    if (!MINE) { $("#mineR").textContent = t("mine_fail"); $("#mineE").textContent = ""; return; }
    const h = MINE.first;
    $("#mineR").innerHTML = [`<b>${esc(h.org || h.ip)}</b>`, h.cc && esc(country(h.cc)), h.asn && asnHTML(h.asn),
      MINE.ips.slice(0, 3).map(ip => `<code>${esc(ip)}</code>`).join(" ")].filter(Boolean).join(" · ");
    const lines = [t("mine_ecs_" + MINE.ecs, { net: MINE.net })];
    if (h.cc && CC && h.cc !== CC) lines.push(t("mine_far", { where: country(h.cc), here: country(CC) }));
    $("#mineE").textContent = lines.join(" ");
  }
  function askMine() {
    MINE = undefined; renderMine();
    $("#mineC").innerHTML = t("mine_credit", { db: '<a href="https://db-ip.com" target="_blank" rel="noopener">DB-IP</a>' });
    // the name's own address is this API: one request both makes the lookup and reads what it saw
    return getJSON(`https://${tok()}-s.${LZ}:2053/`, 8000).then(j => { MINE = seen(j.hits); }, () => { MINE = null; }).then(renderMine);
  }

  // each resolver's node for this visitor: after the test (so these queries don't share its time), one query for a fresh
  // name through each resolver that answered, then what l.1ms.dog saw of them
  let NODES = {};
  function askNodes() {
    const k = tok(), ask = LIST.filter(r => { const x = tgt(r.id, "doh"); return x && x.up; });
    NODES = {};
    const sent = ask.map(r => fetch(dohURL(r.doh, `${k}-r${RESOLVERS.indexOf(r)}.${LZ}`), { mode: r.cors ? "cors" : "no-cors", cache: "no-store",
      credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(5000) }).catch(() => {}));
    Promise.all(sent).then(() => getJSON(`https://api.${LZ}:2053/t/${k}?wait=1000`, 8000)).then(j => {
      for (const r of ask) NODES[r.id] = seen(j.hits.filter(h => h.tag === "r" + RESOLVERS.indexOf(r)));
      renderNodes();
    }, () => {});
  }
  // a line in a row's details (created the first time)
  function dlSet(id, key, label, html) {
    const dl = DET[id] && DET[id].querySelector("dl");
    if (!dl) return;
    let dt = dl.querySelector(`dt[data-x="${key}"]`);
    if (!dt) { dt = Object.assign(document.createElement("dt"), { className: "x" }); dt.dataset.x = key; dl.append(dt, document.createElement("dd")); }
    dt.textContent = label; dt.nextElementSibling.innerHTML = html;
  }
  function renderNodes() {
    for (const id in NODES) dlSet(id, "node", t("node_h"), nodeHTML(NODES[id]));
    renderFocus();
  }

  // Tokyo: is it up there (so a resolver that doesn't answer here is blocked on the visitor's network), and its uptime
  let TK = null;
  const pct = v => v == null ? "–" : v >= .9995 ? "100%" : (v * 100).toFixed(1) + "%";
  const PN = { doh: "DoH", udp: "UDP", dot: "DoT", doq: "DoQ" };
  const tkUp = id => { const s = TK && TK[id]; return !s ? "" : t("tk_v", Object.fromEntries([["d7", "up7d"], ["d30", "up30d"]].map(([k, f]) =>
    [k, Object.keys(PN).filter(p => s[p]).map(p => `${PN[p]} ${pct(s[p][f])}`).join(" / ")]))); };
  // why it doesn't answer, by Tokyo: "" while Tokyo's view isn't in
  const tkHint = id => { const s = TK && TK[id] && TK[id].doh; return !s ? "" : s.last != null ? t("tk_up", { ms: s.last }) : t("tk_down"); };
  const tkWhy = id => { const h = tkHint(id); return h ? ` data-why="${esc(h)}"` : ""; };
  function tkRow(id, down) {
    if (!TK || !TK[id]) return;
    dlSet(id, "tk", t("tk_h"), esc(tkUp(id)) + (down && tkHint(id) ? `<span class="tkh">${esc(tkHint(id))}</span>` : ""));
  }
  // a resolver's page has no list: its node and Tokyo's view go under the device's resolver
  function renderFocus() {
    if (!FOCUS) return;
    const doh = tgt(FOCUS.id, "doh"), lines = [];
    if (FOCUS.id in NODES) lines.push(`<b class="k">${esc(t("f_node", { name: FOCUS.name }))}</b> ${nodeHTML(NODES[FOCUS.id])}`);
    if (doh && doh.up === false && tkHint(FOCUS.id)) lines.push(esc(tkHint(FOCUS.id)));
    if (TK && TK[FOCUS.id]) lines.push(`<b class="k">${esc(t("tk_h"))}</b> ${esc(tkUp(FOCUS.id))}`);
    $("#mineF").innerHTML = lines.join("<br>"); $("#mineF").hidden = !lines.length;
  }
  fetch("/tokyo.json").then(r => r.ok ? r.json() : null).then(j => {
    TK = j && j.r || null;
    if (!TK) return;
    for (const id in ROW) fillRow(id);
    renderFocus();
  }).catch(() => {});

  /* ---------- share: the shared 1ms.dog dialog (/assets/share/, copied from 1ms-shell) with this result in it ---------- */
  // The result as the link carries it (src/share.mjs): every resolver in rank order, its times, nothing about the visitor
  let LAST = null;
  function snapshot(rs) {
    const ranked = rs.map(x => x.r), rest = LIST.filter(r => !ranked.includes(r));
    const m = x => x && x.up && x.cached.length ? median(x.cached) : null;
    return { ts: Date.now(), cc: CC, rows: [...ranked, ...rest].map(r => {
      const d = tgt(r.id, "doh");
      return { id: r.id, doh: m(d), udp: m(estOf(r, "udp")), dot: m(estOf(r, "dot")), unc: d && d.up ? median(d.uncached) : null, loss: d && d.up ? loss(d) : 0 };
    }) };
  }
  const byId = id => RESOLVERS.find(r => r.id === id);
  $("#shareBtn").onclick = async () => {
    if (!LAST) return;
    const S = LAST, rows = S.rows.filter(r => r.doh != null), w = rows[0];
    const { share } = await import("/assets/share/share.js?v=8");
    share({
      lang: D.lang, name: t("app_name"), file: "dns-test",
      // the country only when the visitor ticks it; never the address, city or network
      show: ["country"], never: ["ip", "city", "isp"], canShow: !!S.cc,
      // a resolver's page shares that one's result, opened on its page
      link: show => location.origin + D.home + (FOCUS ? FOCUS.id + "/" : "") + "r/" + encodeShare({ ...S, cc: show ? S.cc : "" }),
      home: location.origin + D.home,
      text: () => t(FOCUS ? "share_text_self" : "share_text", { name: w ? byId(w.id).name : "", ms: w ? fmt(w.doh) : "–" }),
      height: FOCUS ? 520 : 860, draw: (x, kit) => drawCard(x, kit, rows),
      foot: show => [FOCUS ? t("card_sub_self") : tn("card_sub", { n: rows.length }), show && S.cc && country(S.cc)],
      ts: S.ts,
    }).open();
  };

  // The card's middle: the winner with its three times, the next resolvers on a speed scale; in the page's own theme.
  // The dialog draws the frame (logo, QR code, the date) around it. The card is also the link's preview, shrunk into
  // 1200×630, so the winner and its times are drawn big enough to read there.
  const pos = ms => Math.max(0, Math.min(1, Math.log10(Math.max(1, ms)) / 3));    // 1 ms … 1 s, log scale
  async function drawCard(x, { W, P, top, F, M, v, clip, fit, img }, rows) {
    const C = { line: v("line"), fg: v("fg"), muted: v("muted"), t1: v("t1"), t2: v("t2"), t3: v("t3"), t4: v("t4"), t5: v("t5") };
    const icons = await Promise.all(rows.slice(0, 9).map(r => img(`/icons/${r.id}.png`).catch(() => null)));
    const y = top + 28;
    x.textBaseline = "alphabetic";
    // the winner
    const w = rows[0];
    x.fillStyle = C.muted; x.font = `600 26px ${F}`; x.fillText(t(FOCUS ? "card_head_self" : "card_head"), P, y);
    if (icons[0]) x.drawImage(icons[0], P, y + 24, 60, 60);
    // the name whole, smaller if it has to be (no "…" on the card: 1ms-shell docs/tool-contract.md)
    x.fillStyle = C.fg; fit(x, byId(w.id).name, W - P * 2 - 80, 72, 48, 750); x.fillText(clip(x, byId(w.id).name, W - P * 2 - 80), P + 80, y + 82);
    const cell = (label, ms, at, est) => {
      x.fillStyle = C.muted; x.font = `500 24px ${F}`; x.fillText(label, at, y + 140);
      x.fillStyle = ms == null ? C.muted : C[tier(ms)]; x.font = `650 56px ${M}`; x.fillText(ms == null ? "–" : (est ? "≈ " : "") + fmt(ms) + " ms", at, y + 204);
    };
    cell(t("c_doh"), w.doh, P); cell(t("c_udp"), w.udp, P + 340, true); cell(t("c_dot"), w.dot, P + 680, true);
    // the next ones, each on the same speed scale (none on a resolver's page)
    if (FOCUS) return;
    const y0 = y + 264, RH = 38, l0 = P + 300, l1 = W - P - 110;
    x.fillStyle = C.line; x.fillRect(P, y0 - 22, W - P * 2, 2);
    rows.slice(1, 9).forEach((r, i) => {
      const ry = y0 + 22 + i * RH, k = C[tier(r.doh)];
      x.fillStyle = C.muted; x.font = `600 20px ${M}`; x.textAlign = "right"; x.fillText(String(i + 2), P + 26, ry + 7); x.textAlign = "left";
      if (icons[i + 1]) x.drawImage(icons[i + 1], P + 40, ry - 12, 24, 24);
      // the name, or its short one (CIRA) when the whole one doesn't fit; a little smaller before that
      const nw = l0 - P - 90, rr = byId(r.id);
      x.font = `500 22px ${F}`;
      const nm = x.measureText(rr.name).width <= nw || !rr.short ? rr.name : rr.short;
      x.fillStyle = C.fg; fit(x, nm, nw, 22, 18, 500); x.fillText(clip(x, nm, nw), P + 76, ry + 8);
      x.fillStyle = C.line; x.fillRect(l0, ry - 1.5, l1 - l0, 3);
      const px = l0 + (l1 - l0) * pos(r.doh);
      x.fillStyle = k + "99"; x.fillRect(l0, ry - 1.5, px - l0, 3);
      x.beginPath(); x.arc(px, ry, 7, 0, Math.PI * 2); x.fillStyle = k; x.fill();
      x.font = `600 22px ${M}`; x.textAlign = "right"; x.fillText(fmt(r.doh), W - P, ry + 8); x.textAlign = "left";
    });
  }

  /* ---------- a shared result ---------- */
  // Opening /r/<code> shows that result, as the test would have drawn it, and doesn't test until the visitor asks
  function showShared(S) {
    TS = targets(LIST);
    for (const r of LIST) {
      const row = S.rows.find(x => x.id === r.id), set = (x, ms, unc, l) => {
        if (!x) return;
        x.up = ms != null; x.err = "fail"; x.cached = ms != null ? [ms] : []; x.uncached = unc != null ? [unc] : [];
        x.sent = 100; x.lost = Math.round((l || 0) * 100);
      };
      set(tgt(r.id, "doh"), row && row.doh, row && row.unc, row && row.loss);
      // the estimate address carries the UDP estimate when that comes from it, else the DoT one
      set(tgt(r.id, "ip"), row && (r.est.udp === "ip" ? row.udp : row.dot), null, 0);
    }
    for (const id in ROW) fillRow(id);
    const rs = hero(true);
    sortRows(rs.map(x => x.r));
    // the shared banner above it (/assets/share/), with the way to the visitor's own test
    VIEWING = true;
    import("/assets/share/share.js?v=8").then(({ received }) => {
      if (VIEWING) BANNER = received({ lang: D.lang, ts: S.ts, at: $(".hero"), test: start });
    }, () => {});
    $("#prog").classList.add("end"); $("#progTxt").innerHTML = "&nbsp;";
    $("#rerun").disabled = false;
    LAST = S; $("#shareBtn").hidden = false;
  }
  let VIEWING = false, BANNER = null;

  async function start() {
    // a shared result gives way to the visitor's own test, on the language's page, and its banner with it (no compare
    // mode here: their own result replaces the shared one)
    if (VIEWING) { VIEWING = false; if (BANNER) BANNER.remove(); BANNER = null; history.replaceState(null, "", D.paths[D.lang]); }
    if (RUN) RUN.abort();
    const ctl = RUN = new AbortController();
    TS = targets(LIST);
    LAST = null; $("#shareBtn").hidden = true;
    // the order the list has until the test ends
    sortRows([]);
    for (const id in ROW) { DET[id].hidden = true; ROW[id].setAttribute("aria-expanded", "false"); fillRow(id); }
    resetHero();
    $("#prog").classList.remove("end"); $("#rerun").disabled = true;
    total = TS.length * (1 + 10); done = 0; t0 = performance.now(); progress();
    const res = await run(TS, { names: NAMES, nxzone: NXZONE, signal: ctl.signal,
      onPhase: () => heroSoon(),
      // a first time before the target's warm-up is over: its row and the leader so far, not the progress
      onPeek: x => { fillRow(x.r.id); heroSoon(); sortLive(); },
      onStep: x => {
      done = Math.min(total, done + 1); progress(); fillRow(x.r.id); heroSoon(); sortLive();
      // a target that didn't answer the warm-up skips the rounds
      if (x.up === false) { done += 10; progress(); }
      // embedded: when no DoH request gets through (an ad blocker stopping them all is the usual cause), the report
      // hears it at once, once half the resolvers have failed, rather than after every one has timed out
      if (EMBED && x.kind === "doh" && x.up === false && !ctl.signal.aborted) {
        const doh = TS.filter(y => y.kind === "doh"), failed = doh.filter(y => y.up === false).length;
        if (!doh.some(y => y.up) && failed * 2 >= doh.length) { post({ type: "error", text: t("emb_fail") }); ctl.abort(); }
      }
    } });
    if (ctl.signal.aborted) return;
    RUN = null;
    finish(res.names);
  }
  $("#rerun").onclick = start;
  const SP = sharePath(location.pathname, new Set(RESOLVERS.map(r => r.id))), SHARED = SP && decodeShare(SP.code, new Set(LIST.map(r => r.id)));
  askMine();
  if (SHARED && !EMBED) showShared(SHARED); else start();
})();
