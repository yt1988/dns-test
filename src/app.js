// DNS Test page. Every resolver's row is in the HTML from the start; the test (src/measure.mjs) fills them as answers
// come in. The rows stay sorted by the time so far and the hero names the leader, both as the answers come in; at the
// end, by the final medians. On a resolver's own page (D.focus) the hero follows that resolver instead: its times and
// its rank. Strings: window.L1MS.
import { RESOLVERS, NAMES, NXZONE } from "./resolvers.mjs";
import { targets, run, median, loss, score } from "./measure.mjs";
import { FORMATS, FORMAT_NAMES, items as ruleItems, inline as ruleInline, remote as ruleRemote } from "./rules.mjs";
import { encode as encodeShare, decode as decodeShare, sharePath } from "./share.mjs";

(function () {
  "use strict";
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const D = JSON.parse($("#data").textContent);
  const FOCUS = D.focus ? RESOLVERS.find(r => r.id === D.focus) : null;
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

  /* ---------- Who Are You: which resolver this device really uses, and DNS leaks (on 1ms.dog only) ---------- */
  const WHO = document.querySelector('meta[name="who"]');
  if (WHO) { $("#whoLink").href = WHO.content.replace(/\/+$/, "") + D.home; $("#whoLink").hidden = false; }
  // and the other 1ms.dog tools a DNS page leads to, each where the shell says it is (a self-hosted copy has none):
  // a resolver's page to the DNS leak check once it is set up, every AS number to ASN Lookup, and the speed test
  const tool = n => { const m = document.querySelector(`meta[name="${n}"]`); return m ? m.content.replace(/\/+$/, "") + D.home : ""; };
  const link = (el, href) => { if (el && href) { el.href = href; el.hidden = false; } };
  link($("#leakLink"), tool("who") && tool("who") + "dns-leak/");
  link($("#speedLink"), tool("speed"));
  if (tool("asn")) $$("[data-asn]").forEach(s => {
    const a = Object.assign(document.createElement("a"), { href: tool("asn") + "AS" + s.dataset.asn, target: "_blank", rel: "noopener", textContent: s.textContent });
    s.replaceWith(a);
  });

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
  let TS = [], RUN = null, PHASE = 1;
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
    $("#winK").textContent = t(FOCUS ? (final ? "f_done" : "f_run") : final ? "best_k" : "lead_k");
    if (!rs.length && !FOCUS) { if (final) $("#winName").textContent = t("none_up"); return rs; }
    const win = FOCUS || rs[0].r, doh = tgt(win.id, "doh");
    if ($("#winName").textContent !== win.name) { $("#winName").textContent = win.name; $("#winIc").style.backgroundImage = `url(/icons/${win.id}.png)`; }
    if (FOCUS) {
      // its rank so far, then where it ended and who beat it (that one's page a click away)
      const i = rs.findIndex(x => x.r === FOCUS), self = !final && PHASE === 0, gap = j => fmt(ms(tgt(rs[j].r.id, "doh")) - ms(tgt(rs[0].r.id, "doh")));
      $("#winSub").innerHTML = self ? esc(t(doh && doh.up === false ? "f_down" : "f_self", { n: RESOLVERS.length - 1 }))
        : i < 0 ? esc(t(doh && doh.up === false ? "f_down" : "f_wait"))
        : !final ? esc(t("f_sub_run", { n: rs.length, of: RESOLVERS.length, rank: i + 1 }))
        : i === 0 ? (rs[1] ? esc(t("f_first", { n: rs.length, d: gap(1), second: rs[1].r.name })) : "&nbsp;")
        : esc(t("f_rank", { rank: i + 1, n: rs.length, d: gap(i), best: "@@best@@" })).replace("@@best@@", `<a href="${D.home + rs[0].r.id}/">${esc(rs[0].r.name)}</a>`);
    } else $("#winSub").textContent = !final ? t("lead_sub", { n: rs.length, of: RESOLVERS.length })
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
    LAST = snapshot(rs);
    $("#shareBtn").disabled = false;
  }

  // where the visitor is (Cloudflare's own trace, on sites it serves): for the mainland China note, and for the share
  // card when the visitor ticks "show my country"
  let CC = "";
  fetch("/cdn-cgi/trace", { cache: "no-store" }).then(r => r.ok ? r.text() : "").then(s => { const m = /\bloc=([A-Z]{2})/.exec(s); if (m) CC = m[1]; }).catch(() => {});
  const country = cc => { try { return new Intl.DisplayNames([D.lang], { type: "region" }).of(cc); } catch (e) { return cc; } };

  /* ---------- share: a link that carries the result, an image drawn here, the system share sheet ---------- */
  // The result as the link carries it (src/share.mjs): every resolver in rank order, its times, nothing about the visitor
  let LAST = null;
  function snapshot(rs) {
    const ranked = rs.map(x => x.r), rest = RESOLVERS.filter(r => !ranked.includes(r));
    const m = x => x && x.up && x.cached.length ? median(x.cached) : null;
    return { ts: Date.now(), cc: CC, rows: [...ranked, ...rest].map(r => {
      const d = tgt(r.id, "doh");
      return { id: r.id, doh: m(d), udp: m(estOf(r, "udp")), dot: m(estOf(r, "dot")), unc: d && d.up ? median(d.uncached) : null, loss: d && d.up ? loss(d) : 0 };
    }) };
  }
  const shareLink = () => location.origin + D.home + "r/" + encodeShare({ ...LAST, cc: $("#shareCc").checked ? LAST.cc : "" });
  let shortFor = null;
  async function shortLink(long) {
    const meta = document.querySelector('meta[name="shortener"]');          // present on 1ms.dog; absent when self-hosted
    if (!meta) return long;
    if (shortFor && shortFor[0] === long) return shortFor[1];
    try {
      const r = await fetch(meta.content, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: long }), signal: AbortSignal.timeout(5000) });
      const j = await r.json(); if (j.url) { shortFor = [long, j.url]; return j.url; }
    } catch (e) {}
    return long;
  }
  let shareBlob = null, shareRun = 0;
  async function prepareShare() {
    const run = ++shareRun, long = shareLink();
    $("#shareUrl").value = long; $("#shareImg").removeAttribute("src"); shareBlob = null;
    loadQR().catch(() => {});
    const url = await shortLink(long);
    if (run !== shareRun) return;
    $("#shareUrl").value = url;
    // the QR code carries the short link; a long one would be too dense to scan, so then it points at the page
    const c = await drawCard(url.length <= 300 ? url : location.origin + D.home).catch(() => null);
    if (!c || run !== shareRun) return;
    $("#shareImg").src = c.toDataURL("image/png"); c.toBlob(b => { shareBlob = b; }, "image/png");
  }
  $("#shareBtn").onclick = () => {
    if (!LAST) return;
    $("#shareCc").disabled = !LAST.cc;
    $("#nativeShare").hidden = !navigator.share;
    openDlg("shareDlg");
    prepareShare();
  };
  $("#shareCc").onchange = prepareShare;
  let qrP = null;
  const loadQR = () => qrP ||= new Promise((res, rej) => {
    const el = document.createElement("script"); el.src = QR_JS;
    el.onload = () => res(self.QR1MS); el.onerror = () => { qrP = null; rej(); };
    document.head.appendChild(el);
  });
  const flash = (btn, k) => { const o = btn.textContent; btn.textContent = t(k); setTimeout(() => { btn.textContent = o; }, 1500); };
  $("#copyLink").onclick = async e => { try { await navigator.clipboard.writeText($("#shareUrl").value); flash(e.target, "copied"); } catch (x) { $("#shareUrl").select(); } };
  $("#copyImg").onclick = async e => { try { await navigator.clipboard.write([new ClipboardItem({ "image/png": shareBlob })]); flash(e.target, "copied"); } catch (x) {} };
  $("#dlImg").onclick = () => { const a = document.createElement("a"); a.href = $("#shareImg").src; a.download = "dns-test.png"; a.click(); };
  $("#nativeShare").onclick = async () => {
    const w = LAST.rows.find(r => r.doh != null), name = w ? RESOLVERS.find(r => r.id === w.id).name : "";
    const text = t("share_text", { name, ms: w ? fmt(w.doh) : "–" });
    const file = shareBlob && new File([shareBlob], "dns-test.png", { type: "image/png" });
    try { await navigator.share(file && navigator.canShare && navigator.canShare({ files: [file] }) ? { text, url: $("#shareUrl").value, files: [file] } : { text, url: $("#shareUrl").value }); } catch (e) {}
  };

  // The card: brand, the winner with its three times, the next resolvers on a speed scale, a QR code for the link; in
  // the page's own theme. The country only when the visitor ticked it.
  const img = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  const pos = ms => Math.max(0, Math.min(1, Math.log10(Math.max(1, ms)) / 3));    // 1 ms … 1 s, log scale
  function clip(x, s, w) { if (x.measureText(s).width <= w) return s; while (s && x.measureText(s + "…").width > w) s = s.slice(0, -1); return s + "…"; }
  function roundRect(x, a, b, w, h, r) { x.beginPath(); x.moveTo(a + r, b); x.arcTo(a + w, b, a + w, b + h, r); x.arcTo(a + w, b + h, a, b + h, r); x.arcTo(a, b + h, a, b, r); x.arcTo(a, b, a + w, b, r); x.closePath(); }
  async function drawCard(link) {
    const W = 1200, H = 760, P = 56, cc = $("#shareCc").checked ? LAST.cc : "";
    const F = "Geist, 'PingFang SC', 'Microsoft YaHei', 'Hiragino Sans', 'Malgun Gothic', sans-serif", M = "'Geist Mono', Consolas, monospace";
    const css = getComputedStyle(document.documentElement), v = n => css.getPropertyValue("--" + n).trim(), dark = css.colorScheme === "dark";
    const C = { bg: v("bg"), panel: v("panel"), line: v("line"), fg: v("fg"), muted: v("muted"), ink: v("ink"), t1: v("t1"), t2: v("t2"), t3: v("t3"), t4: v("t4"), t5: v("t5") };
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const x = c.getContext("2d");
    x.fillStyle = C.bg; x.fillRect(0, 0, W, H);
    const rows = LAST.rows.filter(r => r.doh != null), byId = id => RESOLVERS.find(r => r.id === id);
    const icons = await Promise.all(rows.slice(0, 9).map(r => img(`/icons/${r.id}.png`).catch(() => null)));
    const logo = await img(dark ? "/assets/logo-dark.svg" : "/assets/logo-light.svg");
    x.drawImage(logo, P, 40, 150, 60);
    x.textBaseline = "alphabetic";
    x.fillStyle = C.muted; x.font = `600 24px ${F}`; x.fillText(t("app_name") + "  ·  dns.1ms.dog", P + 170, 80);
    // the QR code, top right
    const QS = 150;
    const qr = link && await loadQR().then(Q => { const q = Q(0, "M"); q.addData(link); q.make(); return q; }).catch(() => null);
    if (qr) {
      const n = qr.getModuleCount(), s = (QS - 16) / n, qx = W - P - QS, qy = 36;
      x.fillStyle = "#fff"; roundRect(x, qx, qy, QS, QS, 12); x.fill();
      x.fillStyle = "#111";
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (qr.isDark(i, j)) x.fillRect(qx + 8 + j * s, qy + 8 + i * s, s + .3, s + .3);
    }
    // the winner
    const w = rows[0], wr = byId(w.id), right = W - P - (qr ? QS + 30 : 0);
    x.fillStyle = C.muted; x.font = `600 26px ${F}`; x.fillText(t("card_head"), P, 158);
    if (icons[0]) x.drawImage(icons[0], P, 182, 60, 60);
    x.fillStyle = C.fg; x.font = `750 64px ${F}`; x.fillText(clip(x, wr.name, right - P - 80), P + 80, 236);
    const cell = (label, ms, at) => {
      x.fillStyle = C.muted; x.font = `500 22px ${F}`; x.fillText(label, at, 292);
      x.fillStyle = ms == null ? C.muted : C[tier(ms)]; x.font = `600 40px ${M}`; x.fillText(ms == null ? "–" : (label === t("c_doh") ? "" : "≈ ") + fmt(ms) + " ms", at, 338);
    };
    cell(t("c_doh"), w.doh, P); cell(t("c_udp"), w.udp, P + 290); cell(t("c_dot"), w.dot, P + 580);
    // the next ones, each on the same speed scale
    const top = 392, RH = 38, l0 = P + 300, l1 = W - P - 110;
    x.fillStyle = C.line; x.fillRect(P, top - 22, W - P * 2, 2);
    rows.slice(1, 9).forEach((r, i) => {
      const y = top + 22 + i * RH, k = C[tier(r.doh)];
      x.fillStyle = C.muted; x.font = `600 20px ${M}`; x.textAlign = "right"; x.fillText(String(i + 2), P + 26, y + 7); x.textAlign = "left";
      if (icons[i + 1]) x.drawImage(icons[i + 1], P + 40, y - 12, 24, 24);
      x.fillStyle = C.fg; x.font = `500 22px ${F}`; x.fillText(clip(x, byId(r.id).name, l0 - P - 90), P + 76, y + 8);
      x.fillStyle = C.line; x.fillRect(l0, y - 1.5, l1 - l0, 3);
      const px = l0 + (l1 - l0) * pos(r.doh);
      x.fillStyle = k + "99"; x.fillRect(l0, y - 1.5, px - l0, 3);
      x.beginPath(); x.arc(px, y, 7, 0, Math.PI * 2); x.fillStyle = k; x.fill();
      x.font = `600 22px ${M}`; x.textAlign = "right"; x.fillText(fmt(r.doh), W - P, y + 8); x.textAlign = "left";
    });
    // what was measured, when, and where (only if ticked)
    x.fillStyle = C.muted; x.font = `400 20px ${F}`;
    const foot = [t("card_sub", { n: rows.length }), new Date(LAST.ts).toLocaleDateString(D.lang), cc && country(cc)].filter(Boolean).join("  ·  ");
    x.fillText(clip(x, foot, W - P * 2), P, H - 34);
    return c;
  }

  /* ---------- a shared result ---------- */
  // Opening /r/<code> shows that result, as the test would have drawn it, and doesn't test until the visitor asks
  function showShared(S) {
    TS = targets(RESOLVERS);
    for (const r of RESOLVERS) {
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
    $("#sharedTxt").textContent = t("shared_on", { where: S.cc ? t("shared_where", { where: country(S.cc) }) : "", date: new Date(S.ts).toLocaleString(D.lang, { dateStyle: "medium", timeStyle: "short" }) });
    $("#shared").hidden = false;
    $("#prog").classList.add("end"); $("#progTxt").innerHTML = "&nbsp;";
    $("#rerun").disabled = false;
    LAST = S; $("#shareBtn").disabled = false;
  }

  async function start() {
    // a shared result gives way to the visitor's own test, on the language's page
    if (!$("#shared").hidden) { $("#shared").hidden = true; history.replaceState(null, "", D.paths[D.lang]); }
    if (RUN) RUN.abort();
    const ctl = RUN = new AbortController();
    TS = targets(RESOLVERS);
    LAST = null; $("#shareBtn").disabled = true;
    // the order the list has until the test ends
    sortRows([]);
    for (const id in ROW) { DET[id].hidden = true; ROW[id].setAttribute("aria-expanded", "false"); fillRow(id); }
    resetHero();
    $("#prog").classList.remove("end"); $("#rerun").disabled = true;
    total = TS.length * (1 + 10); done = 0; t0 = performance.now(); progress();
    // a resolver's page tests it first, then the others to compare
    PHASE = 0;
    const res = await run(TS, { names: NAMES, nxzone: NXZONE, signal: ctl.signal, first: FOCUS ? TS.filter(x => x.r === FOCUS) : [],
      onPhase: i => { PHASE = FOCUS ? i : 1; heroSoon(); }, onStep: x => {
      done = Math.min(total, done + 1); progress(); fillRow(x.r.id); heroSoon(); sortLive();
      // a target that didn't answer the warm-up skips the rounds
      if (x.up === false) { done += 10; progress(); }
    } });
    if (ctl.signal.aborted) return;
    RUN = null;
    finish(res.names);
  }
  $("#rerun").onclick = start;
  $("#testMine").onclick = start;
  const SP = sharePath(location.pathname), SHARED = SP && decodeShare(SP.code, new Set(RESOLVERS.map(r => r.id)));
  if (SHARED) showShared(SHARED); else start();
})();
