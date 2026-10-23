/* ============================================================================
   S05 · Explorer — page.js
   ----------------------------------------------------------------------------
   Reads BS.data.explorerLoad() (≈ 700 ms; under ?state=offline it rejects
   RPC_UNAVAILABLE) and paints, in this order:
     · the cluster chip (devnet · slot n, odometer) and "Updated 6s ago"
     · four tick odometers rolling up from 0: total, last 24 h, distinct roots,
       consumer programs
     · the per-day bar chart (inline SVG, drawn here): 7 / 30 / 90 days through
       a .seg; bars rise from the baseline with scaleY, 350 ms out-cubic,
       +30 ms per bar (spread capped at 900 ms), re-cascading on every range
       change; hover / arrow keys show "Oct 14 · 37"; a hidden table mirrors it
     · the two ranked lists (policy roots, consumer programs), every id through
       BS.ui.hash; rows wash on hover and lead nowhere
   States: loading (skeletons, odometers at 0; ?state=loading never resolves),
   offline (one inline panel + Retry that re-runs the load), empty (one empty
   block in place of chart and lists).
   Shown, and only this: counts per UTC day, totals, policy-root hashes,
   public program ids. Never a timestamp finer than a day, a nullifier, a
   transaction, an agent, an operator or a decision.
   ========================================================================== */
(function () {
  "use strict";
  var BS = window.BS;
  var M = BS.motion, D = BS.data, ui = BS.ui, fmt = BS.fmt || ui.fmt;

  BS.mountSite({ active: "explorer" });

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return [].slice.call((r || document).querySelectorAll(s)); }
  function esc(s) { return ui.esc(s); }
  function ico(n) { return BS.icon ? BS.icon(n) : ""; }
  function reduced() { return M.reduced(); }

  var params = new URLSearchParams(location.search);
  var FORCE_LOADING = (params.get("state") || "").split(",").map(function (s) { return s.trim().toLowerCase(); }).indexOf("loading") >= 0;
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function dayLabel(ymd) { var p = ymd.split("-"); return MON[Number(p[1]) - 1] + " " + Number(p[2]); }

  /* ── refs ────────────────────────────────────────────────────────────── */
  var mast = $(".ex-mast"), page = $("#ex");
  var cluster = $("#ex-cluster"), slotEl = $("#ex-slot"), updated = $("#ex-updated");
  var plot = $("#ex-plot"), plotSvg = $("#ex-plot-svg"), plotSk = $(".ex-plot__sk"), tip = $("#ex-tip"), live = $("#ex-plot-live"), table = $("#ex-table");
  var rangeEl = $("#ex-range"), sumEl = $("#ex-sum"), sumLabel = $("#ex-sum-label");
  var alt = $("#ex-alt");
  var rootsRows = $("#ex-roots-rows"), rootsFoot = $("#ex-roots-foot"), progRows = $("#ex-programs-rows"), progFoot = $("#ex-programs-foot");

  /* ── masthead field + the entrance (S02 / S03 ladder) ────────────────── */
  if (BS.mountSpace) BS.mountSpace($(".ex-mast__space"), { intensity: "faint", fade: false });
  $$(".ex-enter").forEach(function (el, i) { el.style.setProperty("--e", String(Math.min(i, 6))); });
  if (!reduced()) {
    mast.classList.add("is-rising"); page.classList.add("is-rising");
    setTimeout(function () { page.classList.remove("is-rising"); }, M.scale(260 + 2 * 40 + 400 + 80));
  }

  /* ── odometers (tick mode) ───────────────────────────────────────────── */
  function intOrDash(v) { return v == null ? "—" : typeof v === "string" ? v : fmt.int(v); }
  /* the kit's tick odometer only rolls cells that already exist, so a number
     growing from "0" would pop its new digits in. Seat a zero of the target's
     shape first (same frame, never painted), then every digit ticks. */
  function rollTo(o, v) {
    if (v != null && !reduced()) { var z = fmt.int(v).replace(/[0-9]/g, "0"); if (o.value() !== z) o.set(z); }
    o.set(v);
  }
  var odo = {};
  $$("[data-odo]").forEach(function (el) { odo[el.getAttribute("data-odo")] = M.odometer(el, 0, { mode: "tick", format: intOrDash }); });
  var sumOdo = M.odometer(sumEl, 0, { mode: "tick", format: intOrDash });
  var slotOdo = null;

  var SUBS = {
    total: "All time on devnet",
    day: "Rolling window, UTC",
    roots: "Hashes only; the rules stay local",
    programs: "Programs that called the verifier"
  };
  function setSubs(mode) {
    $$("[data-sub]").forEach(function (el) {
      var k = el.getAttribute("data-sub");
      if (mode === "loading") el.innerHTML = '<span class="skeleton" aria-hidden="true"></span><span class="sr-only">Loading</span>';
      else if (el.getAttribute("data-shown") !== "1" || el.querySelector(".skeleton")) el.innerHTML = '<span class="ex-fade">' + esc(SUBS[k]) + "</span>";
      el.setAttribute("data-shown", mode === "loading" ? "0" : "1");
    });
  }

  /* ── the range switch ────────────────────────────────────────────────── */
  var range = 30;
  ui.seg(rangeEl, { value: "30", onChange: function (v) { range = Number(v); paintRange(true); } });
  function segDisabled(on) { $$(".seg__item", rangeEl).forEach(function (b) { b.disabled = on; }); }

  /* ── views ───────────────────────────────────────────────────────────── */
  var data = null, attempt = 0;
  function setView(v) {
    page.setAttribute("data-view", v);
    page.setAttribute("aria-busy", v === "loading" ? "true" : "false");
    alt.hidden = !(v === "offline" || v === "empty");
    segDisabled(v !== "ready");
  }

  function paintLoading() {
    setView("loading");
    cluster.setAttribute("data-state", "loading");
    updated.textContent = "Reading the verifier program…";
    setSubs("loading");
    plotSk.innerHTML = '<span class="skeleton"></span>';
    var sk = "";
    for (var i = 0; i < 5; i++) sk += '<li class="ex-row ex-row--sk" aria-hidden="true"><span class="skeleton ex-sk-n"></span><span class="skeleton ex-sk-id"></span><span class="skeleton ex-sk-v"></span><span class="skeleton ex-sk-p"></span></li>';
    rootsRows.innerHTML = sk; progRows.innerHTML = sk;
    rootsFoot.innerHTML = '<span class="skeleton ex-sk-id" aria-hidden="true" style="display:inline-block"></span>';
    progFoot.innerHTML = rootsFoot.innerHTML;
  }

  function paintCluster(x) {
    cluster.setAttribute("data-state", "live");
    if (!slotOdo) { slotEl.innerHTML = ""; slotOdo = M.odometer(slotEl, x.slot, { mode: "tick", format: fmt.slot }); }
    else slotOdo.set(x.slot);
    updated.textContent = "Updated " + fmt.timeAgo(x.updatedAt) + " · read-only";
  }

  /* last 24 h from the per-day series: today so far + the rest of yesterday's
     share of the window (the fixture carries days, not hours) */
  function last24(perDay) {
    var n = perDay.length; if (!n) return 0;
    var day0 = Math.floor(D.now() / D.DAY) * D.DAY, frac = Math.min(1, (D.now() - day0) / D.DAY);
    return perDay[n - 1].count + Math.round((n > 1 ? perDay[n - 2].count : 0) * (1 - frac));
  }

  function onData(x) {
    data = x;
    paintCluster(x);
    var total = x.consumed.total;
    if (!total) {   /* empty devnet */
      setView("empty");
      setSubs("ready");
      odo.total.set(0); odo.day.set(0); odo.roots.set(0); odo.programs.set(0);
      alt.className = "ex-alt";
      alt.innerHTML = ui.empty({
        icon: "layers",
        title: "No attestations consumed yet",
        body: "When a program verifies an attestation on devnet, the count shows here. Counts and hashes only: never the call, the agent or the operator.",
        actions: '<a class="btn secondary" href="../S03/index.html">' + ico("file-check") + 'Check an attestation</a>' +
                 '<a class="btn ghost" href="../S02/index.html">How attestations work' + ico("arrow-right") + "</a>"
      });
      enterAlt();
      return;
    }
    setView("ready");
    setSubs("ready");
    rollTo(odo.total, total);
    rollTo(odo.day, last24(x.consumed.perDay));
    rollTo(odo.roots, x.policyRoots.length);
    rollTo(odo.programs, x.consumerPrograms.length);
    paintRange(true);
    paintLists(x);
  }

  function onError(e) {
    data = null;
    setView("offline");
    cluster.setAttribute("data-state", "offline");
    if (slotOdo) { slotOdo = null; }
    slotEl.textContent = "unavailable";
    updated.textContent = "Last read failed · nothing cached";
    setSubs("ready");
    ["total", "day", "roots", "programs"].forEach(function (k) { odo[k].set(null); });
    var code = (e && (e.code || (e.error && e.error.code))) || "RPC_UNAVAILABLE";
    var msg = (e && e.message) || "Solana RPC unreachable. Retry in a moment.";
    var first = !alt.querySelector("#ex-retry");
    if (first) {
      alt.className = "ex-alt";
      alt.innerHTML =
        '<div class="ex-alt--error">' +
          '<span class="ex-alt__icon" aria-hidden="true">' + ico("circle-alert") + "</span>" +
          '<p class="ex-alt__title">Devnet RPC unavailable</p>' +
          '<p class="ex-alt__body"><span data-msg></span> The explorer reads the chain directly; this page caches nothing.</p>' +
          '<p class="ex-alt__meta" data-meta></p>' +
          '<span class="track ex-alt__track" aria-hidden="true"><span></span></span>' +
          '<div class="ex-alt__actions"><button type="button" class="btn secondary" id="ex-retry">' + ico("refresh-cw") + "<span>Retry</span></button></div>" +
        "</div>";
      $("#ex-retry").addEventListener("click", retry);
      enterAlt();
    }
    $("[data-msg]", alt).textContent = msg;
    $("[data-meta]", alt).textContent = "Attempt " + attempt + " · cluster devnet · " + code;
    var b = $("#ex-retry"); b.removeAttribute("aria-busy"); b.disabled = false;
    $(".ex-alt__track", alt).classList.remove("is-on");
  }
  function enterAlt() { alt.classList.remove("is-in"); void alt.offsetWidth; if (!reduced()) alt.classList.add("is-in"); }

  function load() {
    attempt++;
    return D.explorerLoad().then(onData, onError);
  }
  /* Retry keeps the frame: the panel stays, the button goes busy, a sweep runs, the load re-runs */
  function retry() {
    var b = $("#ex-retry");
    b.setAttribute("aria-busy", "true");
    $(".ex-alt__track", alt).classList.add("is-on");
    cluster.setAttribute("data-state", "loading");
    slotEl.innerHTML = '<span class="skeleton ex-sk-slot" aria-hidden="true"></span><span class="sr-only">reading</span>';
    updated.textContent = "Reading the verifier program…";
    load();
  }

  /* ══ the chart ═══════════════════════════════════════════════════════════ */
  var PAD_L = 40, PAD_T = 12, PAD_B = 28, H = 248, GAP = 2, BAR_MAX = 24, R = 4;
  var geo = null, hot = -1, cascadeTimer = 0;

  function niceTop(max) {
    if (max <= 0) return 10;
    var half = max / 2, unit = max < 100 ? 5 : max < 400 ? 10 : max < 2000 ? 50 : 100;
    return Math.ceil(half / unit) * unit * 2;
  }
  function barPath(x, yTop, w, yBase) {
    var h = yBase - yTop; if (h <= 0) return "";
    var r = Math.min(R, w / 2, h);
    return "M" + x + " " + yBase + "V" + (yTop + r) + "A" + r + " " + r + " 0 0 1 " + (x + r) + " " + yTop +
      "H" + (x + w - r) + "A" + r + " " + r + " 0 0 1 " + (x + w) + " " + (yTop + r) + "V" + yBase + "Z";
  }
  function xTicks(n) {
    var step = n <= 7 ? 1 : n <= 30 ? 7 : 15, out = [];
    for (var i = n - 1; i >= 0; i -= step) out.push(i);
    return out;
  }

  function days() { return data ? data.consumed.perDay.slice(-range) : []; }

  function draw(animate) {
    var list = days(), n = list.length;
    var W = Math.max(320, Math.round(plotSvg.clientWidth || plot.clientWidth));
    var plotH = H - PAD_T - PAD_B, slot = (W - PAD_L) / n, bw = Math.max(2, Math.min(BAR_MAX, slot - GAP));
    var max = 0; list.forEach(function (d) { if (d.count > max) max = d.count; });
    var top = niceTop(max), yBase = PAD_T + plotH;
    function y(v) { return PAD_T + plotH * (1 - v / top); }
    geo = { list: list, n: n, W: W, slot: slot, bw: bw, y: y, yBase: yBase };

    var s = '<svg viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '" aria-hidden="true" focusable="false">';
    s += '<g class="ex-axis">';
    [top, top / 2].forEach(function (v) {
      var yy = Math.round(y(v)) + 0.5;
      s += '<line x1="' + PAD_L + '" x2="' + W + '" y1="' + yy + '" y2="' + yy + '"></line>';
      s += '<text x="' + (PAD_L - 10) + '" y="' + (yy + 4) + '" text-anchor="end">' + esc(fmt.int(v)) + "</text>";
    });
    s += '<line class="ex-axis__base" x1="' + PAD_L + '" x2="' + W + '" y1="' + (yBase + 0.5) + '" y2="' + (yBase + 0.5) + '"></line>';
    s += '<text x="' + (PAD_L - 10) + '" y="' + (yBase + 4) + '" text-anchor="end">0</text>';
    xTicks(n).forEach(function (i) {
      var cx = PAD_L + slot * i + slot / 2, anchor = "middle";
      if (cx - PAD_L < 20) { cx = PAD_L + slot * i + (slot - bw) / 2; anchor = "start"; }
      if (W - cx < 20) { cx = PAD_L + slot * i + (slot + bw) / 2; anchor = "end"; }
      s += '<text class="ex-axis__x" x="' + cx.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="' + anchor + '">' + esc(dayLabel(list[i].day)) + "</text>";
    });
    s += "</g>";

    var spread = n > 1 ? Math.min(30, 900 / (n - 1)) : 30;
    s += '<g class="ex-bars' + (animate && !reduced() ? " is-cascading" : "") + '" style="--ex-step:' + spread.toFixed(2) + 'ms">';
    list.forEach(function (d, i) {
      var x = PAD_L + slot * i + (slot - bw) / 2;
      var p = barPath(+x.toFixed(2), +y(d.count).toFixed(2), +bw.toFixed(2), yBase);
      if (p) s += '<path class="ex-bar" data-i="' + i + '" style="--i:' + i + '" d="' + p + '"></path>';
    });
    s += "</g></svg>";
    plotSvg.innerHTML = s;

    clearTimeout(cascadeTimer);
    if (animate && !reduced()) {
      var g = $(".ex-bars", plotSvg);
      cascadeTimer = setTimeout(function () { if (g) g.classList.remove("is-cascading"); }, M.scale((n - 1) * spread + 350 + 60));
    }
    hot = -1; hideTip();
  }

  function paintRange(animate) {
    if (!data) return;
    var list = days(), sum = 0;
    list.forEach(function (d) { sum += d.count; });
    sumOdo.set(sum);
    sumLabel.textContent = "in the last " + range + " days";
    plotSvg.setAttribute("aria-label", "Attestations consumed per day, last " + range + " days (UTC). Arrow keys read each day.");
    draw(animate);
    /* the table view: every value reachable without hovering */
    $("caption", table).textContent = "Attestations consumed per day, last " + range + " days (UTC)";
    $("tbody", table).innerHTML = list.map(function (d) { return "<tr><td>" + esc(d.day) + "</td><td>" + esc(fmt.int(d.count)) + "</td></tr>"; }).join("");
  }

  /* ── the tooltip ─────────────────────────────────────────────────────── */
  var TODAY = new Date(Math.floor(D.now() / D.DAY) * D.DAY).toISOString().slice(0, 10);
  function showTip(i, instant) {
    if (!geo || i < 0 || i >= geo.n) return;
    var d = geo.list[i];
    if (hot !== i) {
      var prev = $(".ex-bar.is-hot", plotSvg); if (prev) prev.classList.remove("is-hot");
      var bar = $('.ex-bar[data-i="' + i + '"]', plotSvg); if (bar) bar.classList.add("is-hot");
      hot = i;
    }
    $(".ex-tip__d", tip).textContent = dayLabel(d.day);
    $(".ex-tip__v", tip).textContent = fmt.int(d.count);
    $(".ex-tip__note", tip).textContent = d.day === TODAY ? "so far" : "";
    var cx = PAD_L + geo.slot * i + geo.slot / 2, w = tip.offsetWidth;
    cx = Math.max(w / 2, Math.min(geo.W - w / 2, cx));
    var yy = Math.min(geo.y(d.count), geo.yBase - 2);
    tip.style.left = cx.toFixed(1) + "px";
    tip.style.top = yy.toFixed(1) + "px";
    tip.classList.toggle("is-instant", !!instant || tip.classList.contains("is-on"));
    tip.classList.add("is-on");
  }
  function hideTip() {
    tip.classList.remove("is-instant");
    tip.classList.remove("is-on");
    var prev = $(".ex-bar.is-hot", plotSvg); if (prev) prev.classList.remove("is-hot");
    hot = -1;
  }
  function indexAt(clientX) {
    if (!geo) return -1;
    var r = plotSvg.getBoundingClientRect(), x = clientX - r.left - PAD_L;
    return Math.max(0, Math.min(geo.n - 1, Math.floor(x / geo.slot)));
  }
  plotSvg.addEventListener("pointermove", function (e) {
    if (page.getAttribute("data-view") !== "ready") return;
    var r = plotSvg.getBoundingClientRect(), yIn = e.clientY - r.top;
    if (yIn > H - PAD_B + 4 || e.clientX - r.left < PAD_L - 4) { hideTip(); return; }
    showTip(indexAt(e.clientX), false);
  });
  plotSvg.addEventListener("pointerleave", hideTip);
  /* keyboard: arrows read each day; never animated */
  plotSvg.addEventListener("keydown", function (e) {
    if (!geo) return;
    var i = hot < 0 ? geo.n - 1 : hot;
    if (e.key === "ArrowLeft") i = hot < 0 ? geo.n - 1 : Math.max(0, i - 1);
    else if (e.key === "ArrowRight") i = hot < 0 ? geo.n - 1 : Math.min(geo.n - 1, i + 1);
    else if (e.key === "Home") i = 0;
    else if (e.key === "End") i = geo.n - 1;
    else if (e.key === "Escape") { hideTip(); return; }
    else return;
    e.preventDefault();
    showTip(i, true);
    var d = geo.list[i];
    live.textContent = dayLabel(d.day) + ": " + fmt.int(d.count) + " consumed" + (d.day === TODAY ? " so far" : "");
  });
  plotSvg.addEventListener("blur", hideTip);

  var resizeT = 0;
  window.addEventListener("resize", function () {
    clearTimeout(resizeT);
    resizeT = setTimeout(function () { if (data && page.getAttribute("data-view") === "ready") draw(false); }, 120);
  });

  /* ══ the lists ══════════════════════════════════════════════════════════ */
  function pct(c, t) { if (!t) return "0%"; var p = c / t * 100; return (p < 1 ? "<1" : String(Math.round(p))) + "%"; }
  function rowHtml(i, idHtml, count, total) {
    var share = total ? count / total : 0;
    return '<li class="ex-row" style="--i:' + i + '">' +
      '<span class="ex-row__n">' + String(i + 1).padStart(2, "0") + "</span>" +
      '<span class="ex-row__id">' + idHtml + "</span>" +
      '<span class="ex-row__v">' + esc(fmt.int(count)) + "</span>" +
      '<span class="ex-row__share"><span class="ex-row__meter" aria-hidden="true"><i style="transform:scaleX(' + share.toFixed(4) + ')"></i></span>' +
      '<span class="ex-row__pct">' + esc(pct(count, total)) + "</span></span></li>";
  }
  function enterRows(list) {
    list.classList.remove("is-entering"); void list.offsetWidth;
    if (!reduced()) {
      list.classList.add("is-entering");
      setTimeout(function () { list.classList.remove("is-entering"); }, M.scale(220 + 8 * 30 + 60));
    }
  }
  var listsPainted = false;
  function paintLists(x) {
    var total = x.consumed.total;
    var roots = x.policyRoots.slice().sort(function (a, b) { return b.count - a.count; });
    rootsRows.innerHTML = roots.map(function (r, i) {
      return rowHtml(i, ui.hash(r.root, { label: "Policy root", lg: true }), r.count, total);
    }).join("");
    var rs = roots.reduce(function (a, r) { return a + r.count; }, 0);
    rootsFoot.textContent = roots.length + " roots · sums to " + fmt.int(rs) + (rs === total ? ", the total consumed" : "");

    var progs = x.consumerPrograms.slice().sort(function (a, b) { return b.count - a.count; });
    var unnamed = 0;
    progRows.innerHTML = progs.map(function (p, i) {
      var name = p.name || D.programName(p.programId);
      if (!name) unnamed++;
      var nameHtml = name ? '<span class="ex-row__name">' + esc(name) + "</span>" : '<span class="ex-row__name is-none">No public name</span>';
      return rowHtml(i, ui.hash(p.programId, { label: "Program id" }) + nameHtml, p.count, total);
    }).join("");
    var ps = progs.reduce(function (a, p) { return a + p.count; }, 0);
    progFoot.textContent = progs.length + " programs · " + unnamed + " without a public name · sums to " + fmt.int(ps);
    /* first paint: the container's .reveal.cascade is the entrance (below the fold); later repaints rise in place */
    if (listsPainted) { enterRows(rootsRows); enterRows(progRows); }
    listsPainted = true;
  }

  /* ── go ──────────────────────────────────────────────────────────────── */
  paintLoading();
  if (!FORCE_LOADING) load();
})();
