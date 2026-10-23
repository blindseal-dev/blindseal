/* ============================================================================
   D03 — Dashboard: Audit (page.js)
   ----------------------------------------------------------------------------
   /audit: prove the local log is intact and export a content-free disclosure
   for a range (01-PAGES §2.3, FRONTEND §1.2 / §4 / §5).

   head      BS.data.audit.head → index (roll odometer, mono 28), hash (.hash.lg),
             timestamp, entry count (tick odometer), the proxy signer. Live: the
             stream (BS.data.stream, every 9 s here) advances it; the shell's
             status bar follows "bs:audit" by itself.
   verify    Verify chain → POST /audit/verify (BS.data.api → verifyChain) with a
             1.2 s running state (button disabled "Verifying…", a loading sweep
             across the figure). Intact: "Chain intact · checked #0 → #<head>".
             Broken (?state=chain-broken): "Chain broken at #143 · the hash of
             #143 does not match its predecessor" (ink + circle-alert, never red),
             the figure re-windows on the break, the table scrolls to #143 and
             flashes it. OFFLINE / UNAUTHORIZED → an ink error result.
   range     From / To by index + presets Last 100 · Last 24 h · All (Last 24 h
             = the entries whose ts is within 24 h of now, converted to indices).
             Presets follow the head as it grows; a typed range stays put.
   figure    BS.diagrams.render("chain") with a BROKEN AXIS: when the range starts
             (or the break sits) far from the head, the ten blocks are the range's
             opening edge, a gap (its connector hidden, "+n" entries under three
             dots) and the newest entries up to the head — so every preset visibly
             re-brackets while the head stays in view. The kit draws the bracket
             ("disclosed range · content-free") and the dashed broken link.
   table     newest first, 50 then Load more; Index · Hash · Prev · Time ·
             Verdict · Decision (id hash + link to D02) · Payload hash. ?index=<n>
             (from D02's "Open in audit") scrolls to and flashes that row.
   disclose  Export disclosure → POST /audit/disclose {from, to} → a sheet
             "Disclosure · #from → #to" (range, head, count, signer, signature,
             the file's shape) → Download = BS.data.exportDisclosure(the SAME
             object) → disclosure-<from>-<to>.json + a toast. CHAIN_BROKEN (409)
             → the sheet explains and offers the intact sub-ranges.
   ?state=empty  head #0, one genesis block, "No entries yet.", nothing to export.

   Kit only: BS.mountShell, BS.ui.{hash, verdict, empty, toast, esc}, BS.openSheet,
   BS.motion.{odometer, rise, enterRow, flash, wait, scale, reduced,
   whenUncovered}, BS.diagrams.render, BS.data.{audit, api, verifyChain, stream,
   exportDisclosure, signerPubkey, on}, BS.fmt. No colour literal in this file.
   ========================================================================== */
(function () {
  "use strict";

  var BS = window.BS, D = BS.data, ui = BS.ui, M = BS.motion, fmt = BS.fmt;
  var PAGE = 50;                    /* rows per page (brief) */
  var STREAM_MS = 9000;             /* the background stream, slower than D01's 3 s (brief: "a slower cadence") */
  var RUN_MS = 1200;                /* the verify running state (brief) */
  var VIEW = 10;                    /* blocks in the chain figure (the kit's max) */
  var ZERO = "0x" + new Array(65).join("0");
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return [].slice.call((r || document).querySelectorAll(s)); }
  var esc = ui.esc;
  function ico(n, o) { return BS.icon(n, o); }
  function reduced() { return M.reduced(); }
  var Q = new URLSearchParams(location.search);
  /* links carry the frozen clock and the motion mode, so D02 rebuilds the same fixtures */
  var CARRY = (function () {
    var out = "";
    ["now", "motion"].forEach(function (k) { if (Q.get(k)) out += "&" + k + "=" + encodeURIComponent(Q.get(k)); });
    return out;
  })();
  function d02(id) { return "../D02/index.html?id=" + encodeURIComponent(id) + CARRY; }
  function shortStamp(ts) {
    var t = new Date(ts);
    return MON[t.getUTCMonth()] + " " + t.getUTCDate() + " " + fmt.time(ts);
  }
  function minuteStamp(ts) {
    var t = new Date(ts), p = function (n) { return (n < 10 ? "0" : "") + n; };
    return MON[t.getUTCMonth()] + " " + t.getUTCDate() + " " + p(t.getUTCHours()) + ":" + p(t.getUTCMinutes());
  }
  function plural(n, one, many) { return fmt.int(n) + " " + (n === 1 ? one : many || one + "s"); }

  /* ══ data views ═══════════════════════════════════════════════════════════ */
  var E = D.audit.entries;                         /* live array, oldest first, E[i].index === i */
  var EMPTY = !E.length;
  function maxIdx() { return E.length ? E[E.length - 1].index : -1; }
  function entry(i) { return E[i] || null; }
  function headView() {
    var h = D.audit.head;
    return EMPTY ? { index: 0, hash: h.hash || ZERO, ts: h.ts } : h;  /* empty: a fresh chain reads #0 (brief) */
  }

  /* ══ the shell ════════════════════════════════════════════════════════════ */
  var actions = document.createElement("span");
  actions.className = "d03-actions";
  actions.innerHTML =
    '<button type="button" class="glass-btn primary sm d03-vbtn" id="d03-verify-btn">' + ico("circle-check") + '<span data-label>Verify chain</span></button>' +
    '<button type="button" class="glass-btn sm" id="d03-export-btn">' + ico("download") + "<span>Export disclosure</span></button>";
  BS.mountShell({ active: "audit", title: "Audit log", actions: actions });
  if (EMPTY) BS.shell.setAuditHead(headView());

  var refs = {
    page: $("#d03"), head: $("#d03-head"), verify: $("#d03-verify"), range: $("#d03-range"),
    from: $("#d03-from"), to: $("#d03-to"), presets: $("#d03-presets"), count: $("#d03-count"), countUnit: $("#d03-count-unit"), span: $("#d03-span"),
    chainSub: $("#d03-chain-sub"), fig: $("#d03-fig"), gap: $("#d03-gap"), gapN: $("#d03-gap-n"),
    box: $("#d03-tablebox"), rows: $("#d03-rows"), none: $("#d03-none"),
    more: $("#d03-more"), shown: $("#d03-shown"), of: $("#d03-of"), loadMore: $("#d03-loadmore"), moreLabel: $("#d03-more-label"),
    vbtn: $("#d03-verify-btn"), ebtn: $("#d03-export-btn")
  };
  var main = document.getElementById("main-content");

  /* ══ head band ════════════════════════════════════════════════════════════ */
  var hv = headView();
  var idxOdo = M.odometer($("#d03-odo"), reduced() ? hv.index : 0, { mode: "roll", format: fmt.int });
  var nOdo = M.odometer($("#d03-head-n"), reduced() ? E.length : 0, { mode: "tick", format: fmt.int });
  $("#d03-signer").innerHTML = ui.hash(D.signerPubkey, { label: "Proxy signer pubkey (ed25519)" });
  function paintHead(h, animate) {
    var hashEl = $("#d03-head-hash");
    hashEl.innerHTML = ui.hash(h.hash, { lg: true, label: "Chain head hash" });
    if (animate && !reduced()) { hashEl.classList.remove("d03-swap"); void hashEl.offsetWidth; hashEl.classList.add("d03-swap"); }
    $("#d03-head-ts").innerHTML = '<span class="d03-ink" data-tip="' + esc(fmt.dateTime(h.ts)) + '">' + esc(fmt.dateTime(h.ts)) + "</span> " +
      '<span class="d03-ago">' + esc(EMPTY ? "genesis" : fmt.timeAgo(h.ts)) + "</span>";
  }
  paintHead(hv, false);
  if (EMPTY) { var dot = $(".d03-head__eyebrow .live-dot"); if (dot) dot.remove(); }
  /* the odometers roll in once the route cover lifts */
  M.whenUncovered().then(function () {
    setTimeout(function () { idxOdo.set(headView().index); nOdo.set(E.length); }, reduced() ? 0 : M.scale(160));
  });

  /* ══ range ════════════════════════════════════════════════════════════════ */
  var PRESETS = { last100: "Last 100", "24h": "Last 24 h", all: "All" };
  var range = { preset: "last100", from: 0, to: -1 };
  function presetRange(p) {
    var max = maxIdx();
    if (max < 0) return { from: 0, to: -1 };
    if (p === "all") return { from: 0, to: max };
    if (p === "24h") {
      var cut = D.now() - D.DAY;
      for (var i = 0; i < E.length; i++) if (Date.parse(E[i].ts) >= cut) return { from: E[i].index, to: max };
      return { from: max + 1, to: max };
    }
    return { from: Math.max(0, max - 99), to: max };
  }
  function rangeCount() { return range.to >= range.from ? range.to - range.from + 1 : 0; }
  function setPreset(p) {
    var r = presetRange(p);
    range = { preset: p, from: r.from, to: r.to };
  }
  function samePreset() {
    /* a typed range that equals a preset lights that preset */
    var hit = null;
    Object.keys(PRESETS).forEach(function (p) { var r = presetRange(p); if (r.from === range.from && r.to === range.to) hit = hit || p; });
    return hit;
  }
  var presetBtns = $$(".tab", refs.presets);
  function markPresets() {
    presetBtns.forEach(function (b) { var on = b.dataset.value === range.preset; b.classList.toggle("is-active", on); b.setAttribute("aria-pressed", String(on)); });
  }
  function syncInputs() {
    var n = rangeCount();
    refs.from.value = n ? String(range.from) : "";
    refs.to.value = n ? String(range.to) : "";
    refs.from.placeholder = "0"; refs.to.placeholder = String(Math.max(0, maxIdx()));
    [refs.from, refs.to].forEach(function (i) { i.removeAttribute("aria-invalid"); });
  }
  var countOdo = M.odometer(refs.count, 0, { mode: "tick", format: fmt.int });
  function paintCount() {
    var n = rangeCount();
    countOdo.set(n);
    refs.countUnit.textContent = n === 1 ? "entry" : "entries";
    refs.span.innerHTML = n ? '<span class="d03-mono">#' + range.from + " → #" + range.to + "</span>" +
      '<span class="d03-range__time">' + esc(minuteStamp(entry(range.from).ts) + " → " + minuteStamp(entry(range.to).ts)) + " UTC</span>" : "";
    refs.ebtn.disabled = !n;
    refs.ebtn.setAttribute("data-tip", n ? "Signed, content-free JSON for #" + range.from + " → #" + range.to : "Nothing to disclose in this range");
  }

  function parseIdx(input) {
    var v = input.value.trim().replace(/^#/, "");
    if (!/^\d+$/.test(v)) return NaN;
    return Number(v);
  }
  function onRangeInput() {
    var max = maxIdx();
    var a = parseIdx(refs.from), b = parseIdx(refs.to), bad = false;
    [[refs.from, a], [refs.to, b]].forEach(function (p) {
      var ok = !isNaN(p[1]) && p[1] >= 0 && p[1] <= max;
      if (ok) p[0].removeAttribute("aria-invalid"); else p[0].setAttribute("aria-invalid", "true");
      if (!ok) bad = true;
    });
    if (bad) {
      BS.toast({ title: "Use an index from #0 to #" + max, body: "The range is by audit index; both ends are included.", tone: "warn", id: "range" });
      return;
    }
    if (a > b) { var t = a; a = b; b = t; }
    range = { preset: "custom", from: a, to: b };
    range.preset = samePreset() || "custom";
    applyRange();
  }
  [refs.from, refs.to].forEach(function (i) {
    i.addEventListener("change", onRangeInput);
    i.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); onRangeInput(); } });
  });
  presetBtns.forEach(function (b) {
    b.addEventListener("click", function () {
      if (range.preset === b.dataset.value) return;
      setPreset(b.dataset.value);
      applyRange();
    });
  });
  function applyRange(o) {
    o = o || {};
    markPresets(); syncInputs(); paintCount();
    renderTable(!o.quiet);
    renderFigure();
  }

  /* ══ verification ═════════════════════════════════════════════════════════ */
  var result = null;        /* the last verify answer: { ok, checkedFrom, checkedTo, brokenAt? } | { error } */
  var newSince = 0, verifying = false, verifiedAt = null;
  function vBlock(kind, iconName, title, sub, extra) {
    return '<div class="d03-v d03-v--' + kind + '">' +
      '<span class="d03-v__ico">' + ico(iconName) + "</span>" +
      '<div class="d03-v__txt"><p class="d03-v__title">' + title + "</p>" + (sub ? '<p class="d03-v__sub">' + sub + "</p>" : "") + (extra || "") + "</div></div>";
  }
  function paintVerify(kind, animate) {
    var max = maxIdx(), html;
    if (kind === "idle") {
      html = EMPTY
        ? vBlock("idle", "link", "Nothing to verify yet", "The chain holds only its genesis. The first screened tool call becomes entry #0.")
        : vBlock("idle", "link", "Not verified this session", "Verify walks every link from #0 to #" + max + " and recomputes each hash, on this machine.");
    } else if (kind === "running") {
      html = vBlock("running", "link", "Verifying…", "Walking #0 → #" + Math.max(0, max) + ", recomputing every hash", '<span class="track d03-v__track" aria-hidden="true"><span></span></span>');
    } else if (kind === "intact") {
      var r = result;
      html = r.checkedTo < 0
        ? vBlock("intact", "circle-check", "Chain intact · genesis only", "No entries to walk yet; the head is the genesis hash.")
        : vBlock("intact", "circle-check", "Chain intact · checked #" + r.checkedFrom + " → #" + r.checkedTo,
          plural(r.checkedTo - r.checkedFrom + 1, "entry", "entries") + ", every hash recomputed and matched · " + esc(fmt.time(verifiedAt)) + " UTC" +
          '<span class="d03-v__since" data-since' + (newSince ? "" : " hidden") + "> · " + esc(plural(newSince, "new entry", "new entries")) + " since</span>");
    } else if (kind === "broken") {
      var b = result.brokenAt;
      html = vBlock("broken", "circle-alert", "Chain broken at #" + b + " · the hash of #" + b + " does not match its predecessor",
        (result.checkedTo >= 0 ? "#" + result.checkedFrom + " → #" + result.checkedTo + " checked intact. " : "") + "Disclosures cannot span #" + b + ".",
        '<p class="d03-v__actions"><button type="button" class="btn link sm" data-show="' + b + '">Show #' + b + '<span class="nudge">' + ico("arrow-right") + "</span></button>" +
        '<span class="chip outline d03-code">CHAIN_BROKEN</span></p>');
    } else {
      var e = result.error || {};
      html = vBlock("broken", "circle-alert", e.code === "UNAUTHORIZED" ? "Could not verify · no dashboard token" : "Could not verify · the proxy is unreachable",
        "Nothing was checked. " + esc(e.message || ""), '<p class="d03-v__actions"><span class="chip outline d03-code">' + esc(e.code || "ERROR") + "</span></p>");
    }
    refs.verify.innerHTML = html;
    refs.verify.setAttribute("data-kind", kind);
    var block = refs.verify.firstElementChild;
    if (animate && !reduced() && block) block.classList.add(kind === "running" ? "d03-fade" : "d03-drop");
  }
  refs.verify.addEventListener("click", function (e) {
    var b = e.target.closest("[data-show]");
    if (b) revealIndex(Number(b.getAttribute("data-show")), { broken: true });
  });
  function paintSince() {
    var s = $("[data-since]", refs.verify);
    if (!s) return;
    s.hidden = !newSince;
    s.textContent = " · " + plural(newSince, "new entry", "new entries") + " since";
  }

  function setVerifyBtn(busy) {
    refs.vbtn.disabled = busy;
    refs.vbtn.toggleAttribute("aria-busy", busy);
    $("[data-label]", refs.vbtn).textContent = busy ? "Verifying…" : "Verify chain";
  }
  function runVerify() {
    if (verifying) return;
    verifying = true;
    setVerifyBtn(true);
    paintVerify("running", true);
    refs.fig.classList.add("is-verifying");
    var call = D.api("POST", "/audit/verify").then(function (r) { return r; }, function (err) { return { error: err.error || err }; });
    Promise.all([call, M.wait(RUN_MS)]).then(function (out) {
      var r = out[0];
      verifying = false;
      setVerifyBtn(false);
      refs.fig.classList.remove("is-verifying");
      result = r; newSince = 0; verifiedAt = D.now();
      if (r.error) { paintVerify("error", true); markBroken(null); renderFigure(); return; }
      if (r.ok) {
        paintVerify("intact", true);
        markBroken(null);
        renderFigure();
        return;
      }
      paintVerify("broken", true);
      markBroken(r.brokenAt);
      renderFigure();
      revealIndex(r.brokenAt, { broken: true });
    });
  }
  refs.vbtn.addEventListener("click", runVerify);
  function brokenAt() { return result && !result.error && result.ok === false ? result.brokenAt : null; }

  /* ══ the chain figure (broken axis) ═══════════════════════════════════════ */
  var figState = { gapAt: -1, gapCount: 0, endIsHead: true };
  function figModel() {
    var max = maxIdx();
    if (max < 0) return { list: [{ index: 0, hash: headView().hash }], gapAt: -1, gapCount: 0, endIsHead: true, win: null, brk: null };
    var n = rangeCount(), brk = brokenAt();
    var endB = n && range.to < max ? Math.min(max, range.to + 1) : max;
    var anchor = null;
    if (brk != null) anchor = [brk - 2, brk + 2];
    else if (n && range.from < endB - (VIEW - 1)) anchor = [range.from - 1, range.from + 2];
    var idx = [], gapAt = -1, gapCount = 0, k;
    if (anchor) {
      anchor[0] = Math.max(0, anchor[0]); anchor[1] = Math.min(max, Math.max(anchor[1], anchor[0] + 3));
      if (endB - anchor[0] + 1 <= VIEW) anchor = null;
    }
    if (anchor) {
      if (anchor[1] >= endB) endB = Math.min(max, anchor[1] + 1);
      var lenA = anchor[1] - anchor[0] + 1, startB = endB - (VIEW - lenA) + 1;
      if (startB <= anchor[1] + 1) { for (k = Math.max(0, endB - VIEW + 1); k <= endB; k++) idx.push(k); }
      else {
        for (k = anchor[0]; k <= anchor[1]; k++) idx.push(k);
        gapAt = idx.length - 1; gapCount = startB - anchor[1] - 1;
        for (k = startB; k <= endB; k++) idx.push(k);
      }
    } else {
      for (k = Math.max(0, endB - VIEW + 1); k <= endB; k++) idx.push(k);
    }
    var list = idx.map(function (i) { return { index: i, hash: E[i].hash }; });
    var win = null;
    if (n) {
      var inR = idx.filter(function (i) { return i >= range.from && i <= range.to; });
      if (inR.length) win = [inR[0], inR[inR.length - 1]];
    }
    return { list: list, gapAt: gapAt, gapCount: gapCount, endIsHead: endB === max, win: win, brk: brk != null && idx.indexOf(brk) > 0 ? brk : null };
  }
  function renderFigure() {
    var m = figModel(), list = m.list, first = list[0].index, last = list[list.length - 1].index, max = maxIdx();
    figState = m;
    var aria = EMPTY ? "Audit chain: the genesis block only, no entries yet." :
      "Audit chain, " + (m.gapAt >= 0
        ? "entries #" + first + " to #" + list[m.gapAt].index + ", then " + m.gapCount + " entries not drawn, then #" + list[m.gapAt + 1].index + " to #" + last
        : "entries #" + first + " to #" + last) + (m.endIsHead ? " (the head)" : "") + ", each linked to the hash of the one before." +
      (m.win ? " Selected range #" + range.from + " to #" + range.to + " bracketed." : "") + (m.brk != null ? " Chain broken at #" + m.brk + "." : "");
    var caption = EMPTY ? "The genesis block. Entry #0 will commit to its hash." :
      "Each entry commits to the hash of the one before it" + (m.gapAt >= 0 ? "; the dots skip entries the table lists" : "") +
      ". A disclosure proves a range without its content.";
    BS.diagrams.render("chain", refs.fig, { entries: list, count: list.length, window: m.win, brokenAt: m.brk, label: aria, caption: caption });
    decorateFigure();
    /* the panel's one-line summary */
    var n = rangeCount();
    refs.chainSub.innerHTML = EMPTY ? "genesis · no entries" :
      (n ? '<span class="d03-mono">#' + range.from + " → #" + range.to + "</span> bracketed · " : "no range · ") +
      "showing " + (m.gapAt >= 0 ? '<span class="d03-mono">#' + first + "–#" + list[m.gapAt].index + "</span> and " +
        '<span class="d03-mono">#' + list[m.gapAt + 1].index + "–#" + last + "</span>" : '<span class="d03-mono">#' + first + "–#" + last + "</span>") +
      (m.endIsHead ? " (head)" : " · head #" + max);
  }
  function decorateFigure() {
    var m = figState, f = refs.fig;
    f.setAttribute("data-gap", m.gapAt >= 0 ? String(m.gapAt) : "");
    var headT = $('[data-k="head"]', f), prevT = $('[data-k="prevl"]', f);
    if (headT) headT.textContent = EMPTY ? "genesis · head" : m.endIsHead ? "head" : "head #" + maxIdx() + " →";
    if (prevT && EMPTY) prevT.textContent = "";
    refs.gap.hidden = m.gapAt < 0;
    if (m.gapAt >= 0) {
      /* the kit lays ten blocks 76 wide, 22 apart, centred in 1020: the gap's centre in viewBox units */
      var n = m.list.length, x0 = (1020 - (n * 76 + (n - 1) * 22)) / 2, mid = x0 + m.gapAt * 98 + 76 + 11;
      refs.gap.style.left = (mid / 1020 * 100).toFixed(3) + "%";
      refs.gapN.textContent = "+" + fmt.int(m.gapCount);
      refs.gap.setAttribute("aria-label", fmt.int(m.gapCount) + " entries not drawn");
      refs.gap.setAttribute("data-tip", fmt.int(m.gapCount) + " entries between #" + m.list[m.gapAt].index + " and #" + m.list[m.gapAt + 1].index + " are not drawn");
    }
  }

  /* ══ the entries table ════════════════════════════════════════════════════ */
  var nextIdx = -1;                 /* the next (older) index to render; < range.from = all loaded */
  var markIdx = null;               /* the row that carries the persistent target mark */
  var brokenIdx = null;
  function rowHtml(e) {
    var broken = brokenIdx === e.index;
    return '<tr class="table__row d03-row' + (broken ? " is-broken" : "") + (markIdx === e.index ? " is-target" : "") + '" data-index="' + e.index + '">' +
      '<td><span class="d03-idxv">' + (broken ? '<span class="d03-idxv__ico" tabindex="0" role="img" aria-label="Broken: recomputed hash does not match" data-tip="Recomputed hash does not match: this entry changed after it was written">' + ico("circle-alert") + "</span>" : "") + "#" + e.index + "</span></td>" +
      "<td>" + ui.hash(e.hash, { label: "Entry hash", cls: "ink" }) + "</td>" +
      '<td><span class="d03-prev"><span class="d03-prev__arrow" aria-hidden="true">←</span>' + ui.hash(e.prevHash, { label: e.index === 0 ? "Genesis (no predecessor)" : "Previous entry hash" }) + "</span></td>" +
      '<td class="is-time"><span data-tip="' + esc(fmt.dateTime(e.ts)) + '">' + esc(shortStamp(e.ts)) + "</span></td>" +
      "<td>" + ui.verdict(e.verdict) + "</td>" +
      '<td><span class="d03-dec">' + ui.hash(e.decisionId, { label: "Decision id" }) +
        '<a class="icon-btn d03-dec__open" href="' + d02(e.decisionId) + '" data-tip="Open decision" aria-label="Open decision ' + esc(e.decisionId) + '">' + ico("arrow-up-right") + "</a></span></td>" +
      "<td>" + ui.hash(e.payloadHash, { label: "Payload hash (sha256, pre-redaction)" }) + "</td>" +
      "</tr>";
  }
  function pageHtml(limit) {
    var out = "", k = 0;
    while (nextIdx >= range.from && nextIdx >= 0 && k < limit) { out += rowHtml(E[nextIdx]); nextIdx--; k++; }
    return out;
  }
  function cascade(nodes) {
    if (reduced() || !nodes.length) return;
    nodes.forEach(function (n, i) { n.style.setProperty("--i", String(i)); n.classList.remove("card-in"); });
    void refs.rows.offsetWidth;
    nodes.forEach(function (n) { n.classList.add("card-in"); });
  }
  refs.rows.addEventListener("animationend", function (e) {
    if (e.animationName === "card-in") { e.target.classList.remove("card-in"); e.target.style.removeProperty("--i"); }
  });
  var shownOdo = M.odometer(refs.shown, 0, { mode: "tick", format: fmt.int });
  var ofOdo = M.odometer(refs.of, 0, { mode: "tick", format: fmt.int });
  function paintMore() {
    var shown = refs.rows.children.length, n = rangeCount();
    shownOdo.set(shown); ofOdo.set(n);
    var done = nextIdx < range.from;
    refs.loadMore.disabled = done;
    refs.moreLabel.textContent = done ? "All loaded" : "Load " + Math.min(PAGE, n - shown) + " more";
    refs.more.hidden = n === 0;
    var none = n === 0;
    refs.none.hidden = !none;
    refs.box.classList.toggle("is-none", none);
    if (none) {
      refs.none.innerHTML = EMPTY
        ? ui.empty({ bare: true, icon: "link", title: "No entries yet.",
            body: "Every decision the proxy screens is written here as a hash-chained entry: index, hash, the hash before it, time, verdict. Never content.",
            actions: '<a class="btn secondary sm" href="../D01/index.html?state=empty' + CARRY + '">' + ico("list") + "Point an agent at the proxy</a>" })
        : ui.empty({ bare: true, icon: "clock", title: "No entries in this range",
            body: "Nothing was written to the log in this window. Widen the range or pick All.",
            actions: '<button type="button" class="btn secondary sm" data-all>' + ico("rotate-ccw") + "Show all</button>" });
    }
  }
  refs.none.addEventListener("click", function (e) { if (e.target.closest("[data-all]")) { setPreset("all"); applyRange(); } });
  function renderTable(animate) {
    nextIdx = range.to;
    refs.rows.innerHTML = pageHtml(PAGE);
    paintMore();
    if (animate) cascade([].slice.call(refs.rows.children));
  }
  function loadMore() {
    if (nextIdx < range.from || refs.loadMore.getAttribute("aria-busy") === "true") return;
    refs.loadMore.setAttribute("aria-busy", "true");
    M.wait(180).then(function () {
      var before = refs.rows.children.length;
      refs.rows.insertAdjacentHTML("beforeend", pageHtml(PAGE));
      cascade([].slice.call(refs.rows.children, before));
      refs.loadMore.removeAttribute("aria-busy");
      paintMore();
      if (nextIdx < range.from) BS.toast({ title: "All " + plural(rangeCount(), "entry", "entries") + " loaded", body: "#" + range.to + " down to #" + range.from + ", content-free.", tone: "info", id: "more" });
    });
  }
  refs.loadMore.addEventListener("click", loadMore);
  function rowOf(i) { return refs.rows.querySelector('tr[data-index="' + i + '"]'); }
  function markBroken(i) {
    brokenIdx = i;
    $$("tr.is-broken", refs.rows).forEach(function (tr) {
      tr.classList.remove("is-broken");
      var ic = $(".d03-idxv__ico", tr); if (ic) ic.remove();
    });
    var tr = i != null ? rowOf(i) : null;
    if (tr) { var e = entry(i); tr.outerHTML = rowHtml(e); }
  }

  /* scroll a row into view and flash it; widens the range or loads pages if needed */
  function revealIndex(i, o) {
    o = o || {};
    if (!entry(i)) { BS.toast({ title: "No entry #" + i, body: "The log runs from #0 to #" + maxIdx() + ".", tone: "warn", id: "index" }); return; }
    if (i < range.from || i > range.to) {
      setPreset("all"); applyRange({ quiet: true });
      BS.toast({ title: "Range widened to All", body: "#" + i + " is outside the range you had selected.", tone: "info", id: "widen" });
    }
    if (!rowOf(i)) {
      refs.rows.insertAdjacentHTML("beforeend", pageHtml(Math.ceil((nextIdx - i + 1) / PAGE) * PAGE));   /* whole pages, as Load more would */
      paintMore();
    }
    var tr = rowOf(i);
    if (!tr) return;
    markIdx = i;
    $$("tr.is-target", refs.rows).forEach(function (r) { if (r !== tr) r.classList.remove("is-target"); });
    tr.classList.add("is-target");
    var settled = false;
    var done = function () {
      if (settled) return; settled = true;
      main.removeEventListener("scrollend", done);
      M.flash(tr);
    };
    var before = main.scrollTop;
    tr.scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" });
    if (reduced() || Math.abs(main.scrollTop - before) < 1 && !("onscrollend" in window)) { done(); return; }
    main.addEventListener("scrollend", done);
    setTimeout(done, M.scale(900));
  }

  /* ══ disclosure sheet ═════════════════════════════════════════════════════ */
  function kvItem(k, v) { return '<div class="kv__item"><p class="kv__k">' + k + '</p><div class="kv__v">' + v + "</div></div>"; }
  function verdictMix(list) {
    var c = { pass: 0, block: 0, flag: 0 };
    list.forEach(function (e) { c[e.verdict] = (c[e.verdict] || 0) + 1; });
    return '<span class="d03-mix">' + ["pass", "block", "flag"].map(function (v) {
      return '<span class="d03-mix__i" tabindex="0" role="img" data-tip="' + fmt.int(c[v]) + " " + v + '" aria-label="' + fmt.int(c[v]) + " " + v + '"><i class="d03-key" data-v="' + v + '"></i><span class="num">' + fmt.int(c[v]) + "</span></span>";
    }).join("") + "</span>";
  }
  function fileName(d) { return "disclosure-" + d.from + "-" + d.to + ".json"; }
  function sheetFor(d) {
    var es = d.entries, first = es[0], last = es[es.length - 1];
    var bytes = JSON.stringify(d, null, 2).length;
    var check = D.verifyChain(E, { from: d.from, to: d.to });
    var main = [
      '<p class="sheet__h">Range</p><div class="kv d03-skv">' +
        kvItem("Range", '<span class="d03-mono">#' + d.from + " → #" + d.to + "</span>") +
        kvItem("Entries", '<span class="num" data-sheet-count>' + fmt.int(es.length) + "</span>") +
        kvItem("Verdicts", verdictMix(es)) +
        kvItem("Head", '<span class="d03-mono">#' + d.head.index + "</span>" + ui.hash(d.head.hash, { label: "Head hash at signing" })) +
        kvItem("First", '<span class="num" data-tip="' + esc(fmt.dateTime(first.ts)) + '">' + esc(shortStamp(first.ts)) + "</span>") +
        kvItem("Last", '<span class="num" data-tip="' + esc(fmt.dateTime(last.ts)) + '">' + esc(shortStamp(last.ts)) + "</span>") +
      "</div>",
      '<p class="sheet__h">Signed by this proxy</p><div class="kv kv--rows d03-sig">' +
        kvItem("Signer pubkey · ed25519", ui.hash(d.signerPubkey, { label: "Signer pubkey" })) +
        kvItem("Signature", ui.hash(d.signature, { lg: true, label: "Disclosure signature" })) +
      "</div>",
      '<div class="callout muted d03-callout"><p class="callout__body">Content-free: hashes, verdicts and timestamps only.</p></div>',
      '<p class="sheet__h">In the file</p><div class="kv kv--rows d03-shape">' +
        kvItem("from · to", '<span class="d03-mono">' + d.from + " · " + d.to + "</span>") +
        kvItem("head", '<span class="d03-mono">{ index, hash, ts }</span>') +
        kvItem("entries", '<span class="d03-mono">' + fmt.int(es.length) + " × { index, hash, prevHash, ts, verdict, decisionId, payloadHash }</span>") +
        kvItem("signerPubkey · signature", '<span class="d03-mono">base58 · 0x + 128 hex</span>') +
      "</div>"
    ];
    var side = [
      '<p class="sheet__h">Download</p><div class="d03-dl">' +
        '<button type="button" class="glass-btn primary d03-dl__btn" data-download>' + ico("file-json") + "<span data-dl-label>Download " + esc(fileName(d)) + "</span></button>" +
        '<p class="d03-dl__meta">JSON · ' + esc(fmt.bytes(bytes)) + " · saved by your browser; nothing is uploaded.</p></div>",
      '<p class="sheet__h">Range check</p>' +
        (check.ok
          ? '<p class="d03-rc">' + ico("circle-check") + '<span>Hashes re-walked: <span class="d03-mono">#' + check.checkedFrom + " → #" + check.checkedTo + "</span> intact.</span></p>"
          : '<p class="d03-rc is-bad">' + ico("circle-alert") + "<span>Broken at #" + check.brokenAt + ".</span></p>"),
      '<p class="sheet__h">Who can check it</p><p class="d03-note">Anyone holding the signer pubkey can check the signature, then re-walk prevHash → hash from #' +
        d.from + " to #" + d.to + ". No prompt, argument or payload is in the file.</p>"
    ];
    return { main: main, side: side };
  }
  function errSheet(err, from, to) {
    var b = D.verifyChain(E, { from: from, to: to }).brokenAt;
    if (b == null) b = brokenAt();
    var alts = [];
    if (b != null && from <= b - 1) alts.push([from, b - 1]);
    if (b != null && to >= b + 1) alts.push([b + 1, to]);
    return {
      main: [
        '<div class="d03-err">' + ico("circle-alert") + '<div><p class="d03-err__t">Cannot disclose #' + from + " → #" + to + (b != null ? " · the chain is broken at #" + b : "") + "</p>" +
          '<p class="d03-err__b">A disclosure proves an unbroken run of hashes. #' + b + " no longer matches its predecessor, so no signed range can include it.</p></div>" +
          '<span class="chip outline d03-code">' + esc((err && err.code) || "CHAIN_BROKEN") + " · " + esc(String((err && err.status) || 409)) + "</span></div>",
        alts.length ? '<p class="sheet__h">Disclose the intact part instead</p><div class="d03-alts">' + alts.map(function (a) {
          return '<button type="button" class="btn secondary" data-alt="' + a[0] + "-" + a[1] + '">' + ico("file-check") + "Disclose #" + a[0] + " → #" + a[1] +
            '<span class="d03-alts__n">' + plural(a[1] - a[0] + 1, "entry", "entries") + "</span></button>";
        }).join("") + "</div>" : ""
      ],
      side: ['<p class="sheet__h">Why</p><p class="d03-note">Entry #' + b + " was altered after it was written: its recomputed hash differs from the one the next entry points back to. The log keeps it; the disclosure refuses it.</p>"]
    };
  }
  var sheetApi = null;
  function wireSheet(d) {
    if (!sheetApi) return;
    var body = sheetApi.body;
    var dl = $("[data-download]", body);
    if (dl && d) dl.addEventListener("click", function () {
      var out = D.exportDisclosure(d);
      var label = $("[data-dl-label]", dl), was = dl.querySelector(":scope > svg");
      if (!dl._orig) { dl._orig = { html: was ? was.outerHTML : "" }; dl.style.minWidth = dl.offsetWidth + "px"; }   /* the width is held, nothing jumps */
      dl.classList.add("is-done");
      if (was) was.outerHTML = ico("check");
      label.textContent = "Downloaded";
      clearTimeout(dl._t);
      dl._t = setTimeout(function () {
        dl.classList.remove("is-done");
        var s = dl.querySelector(":scope > svg"); if (s && dl._orig.html) s.outerHTML = dl._orig.html;
        label.textContent = "Download " + fileName(d);
        dl.style.minWidth = ""; dl._orig = null;
      }, M.scale(1400));
      BS.toast({ title: "Disclosure downloaded", body: out.filename + " · " + plural(d.entries.length, "entry", "entries") + " · " + fmt.bytes(out.bytes) + " · content-free.", tone: "ok", id: "dl" });
    });
    $$("[data-alt]", body).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var p = btn.getAttribute("data-alt").split("-").map(Number);
        range = { preset: "custom", from: p[0], to: p[1] };
        range.preset = samePreset() || "custom";
        applyRange();
        openDisclosure(btn);
      });
    });
  }
  function openDisclosure(trigger) {
    var n = rangeCount();
    if (!n) { BS.toast({ title: "Nothing to disclose", body: EMPTY ? "The log has no entries yet." : "This range holds no entries.", tone: "info", id: "dis" }); return; }
    var from = range.from, to = range.to;
    refs.ebtn.setAttribute("aria-busy", "true");
    D.api("POST", "/audit/disclose", { from: from, to: to }).then(function (d) {
      refs.ebtn.removeAttribute("aria-busy");
      sheetApi = BS.openSheet(sheetFor(d), {
        eyebrow: "Disclosure", title: "#" + d.from + " → #" + d.to, trigger: trigger, kind: "disclosure",
        param: { key: "disclose", value: d.from + "-" + d.to },
        onClose: function () { sheetApi = null; }
      });
      wireSheet(d);
    }, function (err) {
      refs.ebtn.removeAttribute("aria-busy");
      if (err && err.code === "CHAIN_BROKEN") {
        sheetApi = BS.openSheet(errSheet(err, from, to), {
          eyebrow: "Disclosure", title: "#" + from + " → #" + to, trigger: trigger, kind: "disclosure",
          param: { key: "disclose", value: from + "-" + to }, onClose: function () { sheetApi = null; }
        });
        wireSheet(null);
        return;
      }
      BS.toast({ title: "Could not export", body: (err && err.message) || "The proxy did not answer.", tone: "danger", id: "dis" });
    });
  }
  refs.ebtn.addEventListener("click", function (e) { openDisclosure(e.currentTarget); });

  /* ══ live: the stream ticks the head ══════════════════════════════════════ */
  function onTick(d, head) {
    BS.shell.setAuditHead(head);                    /* the status bar's audit # odometer + head hash */
    idxOdo.set(head.index);
    nOdo.set(E.length);
    paintHead(head, true);
    var wasTo = range.to;
    if (range.preset !== "custom") setPreset(range.preset);
    syncInputs(); paintCount();
    /* a following range takes the new entry on top */
    if (range.to > wasTo && refs.rows.children.length) {
      refs.rows.insertAdjacentHTML("afterbegin", rowHtml(E[head.index]));
      var tr = refs.rows.firstElementChild;
      if (!reduced()) { M.enterRow(tr); M.flash(tr); }
      /* Last 100 / Last 24 h drop entries that slid out of the window */
      $$("tr.d03-row", refs.rows).forEach(function (r) { if (Number(r.getAttribute("data-index")) < range.from) r.remove(); });
      if (nextIdx < range.from - 1) nextIdx = range.from - 1;
    }
    paintMore();
    if (result && !result.error) { newSince++; paintSince(); }
    if (!verifying) renderFigure();               /* held under the sweep: the result's renderFigure() catches up */
  }

  /* ══ boot ═════════════════════════════════════════════════════════════════ */
  setPreset("last100");
  if (EMPTY) {
    [refs.from, refs.to].forEach(function (i) { i.disabled = true; });
    presetBtns.forEach(function (b) { b.disabled = true; });
    range.preset = "none";                         /* nothing to select yet: no preset lit */
  }
  markPresets(); syncInputs(); paintCount();
  renderTable(false);
  renderFigure();
  paintVerify("idle", false);
  M.rise($$("[data-rise]", refs.page), { y: 14 });

  var qIndex = Q.get("index"), qDis = Q.get("disclose");
  M.whenUncovered().then(function () {
    if (qIndex != null && /^\d+$/.test(qIndex)) setTimeout(function () { revealIndex(Number(qIndex)); }, reduced() ? 0 : M.scale(420));
    if (qDis && /^\d+-\d+$/.test(qDis) && !EMPTY) {
      var p = qDis.split("-").map(Number), max = maxIdx();
      var a = Math.max(0, Math.min(p[0], p[1])), b = Math.min(max, Math.max(p[0], p[1]));
      if (a <= b) {
        range = { preset: "custom", from: a, to: b };
        range.preset = samePreset() || "custom";
        applyRange({ quiet: true });
        setTimeout(function () { openDisclosure(refs.ebtn); }, reduced() ? 0 : M.scale(200));
      }
    }
  });

  if (!EMPTY) D.stream.start(onTick, STREAM_MS);
})();
