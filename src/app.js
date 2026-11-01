// DNS Test page. Every resolver's row is in the HTML from the start; the test (src/measure.mjs) fills them as answers
// come in. The rows stay sorted by the time so far and the hero names the leader, both as the answers come in; at the
// end, by the final medians. Strings: window.L1MS.
import { RESOLVERS, NAMES, NXZONE } from "./resolvers.mjs";
import { targets, run, median, loss, score } from "./measure.mjs";
import { FORMATS, FORMAT_NAMES, items as ruleItems, inline as ruleInline, remote as ruleRemote } from "./rules.mjs";

(function () {
  "use strict";
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const D = JSON.parse($("#data").textContent);
  const L = window.L1MS || {};
  const t = (k, v) => { let s = L[k] ?? k; if (v) for (const x in v) s = s.split("{" + x + "}").join(v[x]); return s; };
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
  const K = { theme: "dnstest:theme", lang: "dnstest:lang", rules: "dnstest:rules" };

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

  /* ---------- the command-line tool's install line ---------- */
  // any copy button copies the command next to it
  document.addEventListener("click", e => {
    const b = e.target.closest && e.target.closest("[data-copy]");
    if (!b || !navigator.clipboard) return;
    navigator.clipboard.writeText(b.parentNode.querySelector("code").textContent).then(() => {
      b.textContent = t("copied"); setTimeout(() => { b.textContent = t("copy"); }, 1200);
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
    if (!c || !navigator.clipboard) return;
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
    if (!x.up) return `<span class="fail">${esc(t(x.err === "timeout" ? "e_timeout" : "e_fail"))}</span>`;
    const m = x.cached.length ? median(x.cached) : x.warm.length ? median(x.warm) : null;
    if (m == null) return '<span class="dots">…</span>';
    const l = loss(x);
    const mark = l > 0 ? `<i class="lost" data-why="${esc(t("tip_loss", { p: Math.round(l * 100) }))}">!</i>` : "";
    return (est ? '<i class="ap">≈</i>' : "") + num(m, mark);
  }
  const estOf = (r, k) => r.est[k] === "doh" ? tgt(r.id, "doh") : r.est[k] === "ip" ? tgt(r.id, "ip") : null;
  function fillRow(id) {
    const r = RESOLVERS.find(x => x.id === id), row = ROW[id], doh = tgt(id, "doh");
    row.querySelector('[data-c="doh"]').innerHTML = cellOf(doh);
    for (const k of ["udp", "dot"]) {
      const c = row.querySelector(`[data-c="${k}"]`);
      if (!r.est[k]) { c.innerHTML = `<span class="m" data-why="${esc(t(r[k] ? "tip_noest" : "tip_none"))}">–</span>`; continue; }
      c.innerHTML = cellOf(estOf(r, k), true);
    }
    // uncached: the DoH target's, marked when the resolver answers a missing name with an address
    const u = doh && doh.up ? median(doh.uncached) : null;
    row.querySelector('[data-c="unc"]').innerHTML = doh && doh.rewrites ? `<span class="fail" data-why="${esc(t("tip_rewrite"))}">${esc(t("rewrites"))}</span>`
      : u == null ? (doh && doh.up === false ? '<span class="m">–</span>' : '<span class="dots">…</span>') : `<span class="nu">${fmt(u)}</span>`;
    row.classList.toggle("wait", !doh || doh.up === null);
    row.classList.toggle("down", !!doh && doh.up === false);
  }

  let total = 0, done = 0, t0 = 0;
  function progress() {
    $("#prog i").style.transform = `scaleX(${total ? done / total : 0})`;
    $("#progTxt").textContent = t("progress", { n: done, of: total });
  }

  function resetHero() {
    $("#winName").innerHTML = '<i class="skl"></i>'; $("#winIc").removeAttribute("style");
    $("#winSub").innerHTML = "&nbsp;";
    $$(".win-m li").forEach(li => { li.querySelector("b").className = ""; li.querySelector("b").textContent = "–"; });
    useOpen(false); $(".use-w").classList.remove("on");
    $("#winK").textContent = t("lead_k");
    $("#alt").innerHTML = "&nbsp;";
  }

  // put the rows in order: fastest DoH first, then the ones with no answer yet, then the ones that didn't answer.
  // Rows that move slide from where they were (transform only, nothing else on the page moves).
  let order = RESOLVERS.map(r => r.id);
  function sortRows(ranked) {
    const tbl = $("#tbl");
    const wait = RESOLVERS.filter(r => !ranked.includes(r) && !ROW[r.id].classList.contains("down"));
    const down = RESOLVERS.filter(r => !ranked.includes(r) && ROW[r.id].classList.contains("down"));
    const next = [...ranked, ...wait, ...down];
    next.forEach((r, i) => { ROW[r.id].querySelector(".rk").textContent = ranked.includes(r) ? i + 1 : ""; });
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
    const rs = RESOLVERS.map(r => ({ r, s: val(tgt(r.id, "doh")) })).filter(x => x.s != null).sort((a, b) => a.s - b.s);
    $("#winK").textContent = t(final ? "best_k" : "lead_k");
    if (!rs.length) { if (final) $("#winName").textContent = t("none_up"); return rs; }
    const win = rs[0].r, doh = tgt(win.id, "doh");
    if ($("#winName").textContent !== win.name) { $("#winName").textContent = win.name; $("#winIc").style.backgroundImage = `url(/icons/${win.id}.png)`; }
    $("#winSub").textContent = !final ? t("lead_sub", { n: rs.length, of: RESOLVERS.length })
      : rs[1] ? t("win_sub", { n: rs.length, d: fmt(ms(tgt(rs[1].r.id, "doh")) - ms(doh)), second: rs[1].r.name }) : "";
    const w = { doh: doh, udp: estOf(win, "udp"), dot: estOf(win, "dot") };
    for (const k in w) {
      const b = $(`.win-m [data-w="${k}"] b`), m = ms(w[k]);
      if (m == null) { b.className = "na"; b.textContent = "–"; b.dataset.why = t(k === "doh" ? "e_fail" : win[k] ? "tip_noest" : "tip_none"); continue; }
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
    if (udp && udp.r !== win) lines.push(t("alt_udp", { name: `<b>${esc(udp.r.name)}</b>`, ms: fmt(ms(udp.x)), ips: esc(udp.r.udp.join(", ")) }));
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
  }

  // where the visitor is (Cloudflare's own trace, on sites it serves): only to add the mainland China note
  let CC = "";
  fetch("/cdn-cgi/trace", { cache: "no-store" }).then(r => r.ok ? r.text() : "").then(s => { const m = /\bloc=([A-Z]{2})/.exec(s); if (m) CC = m[1]; }).catch(() => {});

  async function start() {
    if (RUN) RUN.abort();
    const ctl = RUN = new AbortController();
    TS = targets(RESOLVERS);
    // the order the list has until the test ends
    sortRows([]);
    for (const id in ROW) { DET[id].hidden = true; ROW[id].setAttribute("aria-expanded", "false"); fillRow(id); }
    resetHero();
    $("#prog").classList.remove("end"); $("#rerun").disabled = true;
    total = TS.length * (1 + 10); done = 0; t0 = performance.now(); progress();
    const res = await run(TS, { names: NAMES, nxzone: NXZONE, signal: ctl.signal, onStep: x => {
      done = Math.min(total, done + 1); progress(); fillRow(x.r.id); heroSoon(); sortLive();
      // a target that didn't answer the warm-up skips the rounds
      if (x.up === false) { done += 10; progress(); }
    } });
    if (ctl.signal.aborted) return;
    RUN = null;
    finish(res.names);
  }
  $("#rerun").onclick = start;
  start();
})();
