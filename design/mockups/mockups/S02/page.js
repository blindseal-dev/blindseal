/* ============================================================================
   S02 · How it works — page.js
   ----------------------------------------------------------------------------
   Mounts the site chrome, the faint masthead field, the four figures (each
   with a replay link), fills every value from the fixtures (BS.data), and
   drives the TOC from one place, as the kit's Whitepaper.tsx does:
     1. scroll progress → the rail fill (transform scaleY, damped 100 ms linear)
     2. scroll-spy      → the active link (IO rootMargin -20% 0px -70% 0px:
                          the deepest section in the reader's band), plus two
                          edges the kit leaves open: above section 01 nothing
                          is active, and at the very bottom the last section is
     3. TOC links smooth-scroll (instant under reduced motion), update the
        hash and move focus to the section title.
   Every hash goes through BS.ui.hash(value, { label }).
   ========================================================================== */
(function () {
  "use strict";
  var BS = window.BS;
  var M = BS.motion, D = BS.data, ui = BS.ui, fmt = BS.fmt || ui.fmt;

  BS.mountSite({ active: "how" });

  function reduced() { return M.reduced(); }
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return [].slice.call((r || document).querySelectorAll(s)); }
  function esc(s) { return ui.esc ? ui.esc(s) : String(s); }
  function hash(v, label) { return ui.hash(v, { label: label }); }
  function kvItem(k, v, sub) {
    return '<div class="kv__item"><span class="kv__k">' + esc(k) + '</span><span class="kv__v">' + v + "</span>" +
      (sub ? '<span class="hiw-kv__sub">' + sub + "</span>" : "") + "</div>";
  }
  function ico(n) { return BS.icon ? BS.icon(n) : ""; }

  /* ── masthead: the faint field + the stagger ─────────────────────────── */
  var mast = $(".hiw-mast"), body = $(".hiw");
  if (BS.mountSpace) BS.mountSpace($(".hiw-mast__space"), { intensity: "faint", fade: false });
  if (!reduced()) { mast.classList.add("is-rising"); body.classList.add("is-rising"); }

  /* ── fixture picks ───────────────────────────────────────────────────── */
  var decs = D.decisions || [];
  var ex = decs.filter(function (d) { return d.redactions.length >= 2 && d.layers[2] && d.layers[2].verdict === "flag" && d.verdict === "pass"; })[0] ||
           decs.filter(function (d) { return d.redactions.length >= 1; })[0] || decs[0];
  var att = D.attestation(D.featured && D.featured.consumedAttestationId) ||
            (D.attestations || []).filter(function (a) { return a.status === "consumed"; })[0] || (D.attestations || [])[0];
  var attDec = att ? D.decision(att.decisionId) : null;
  var action = attDec && attDec.action;

  /* ── 01 · the route line ─────────────────────────────────────────────── */
  $("[data-port]").textContent = ":" + ((BS.PORTS && BS.PORTS.proxy) || 7777);
  var ups = (D.status && D.status.upstreams) || [];
  if (ups.length) $("[data-upstreams]").textContent = ups.length + " upstream servers";

  /* ── 02 · rule counts + the example decision ─────────────────────────── */
  var rules = (D.policy && D.policy.rules) || [];
  ["L0", "L1"].forEach(function (L) {
    var n = rules.filter(function (r) { return r.layer === L; }).length;
    var el = $('[data-count="' + L + '"]');
    if (el && n) el.textContent = n + " rules in the example policy.";
  });
  if (ex) {
    $("[data-ex-tool]").innerHTML = esc(ex.server) + "<span> · </span>" + esc(ex.tool);
    $("[data-ex-strip]").innerHTML = ui.layerStrip(ex.layers);
    $("[data-ex-verdict]").innerHTML = ui.verdict(ex.verdict);
    var l2 = ex.layers[2], l3 = ex.layers[3];
    var note;
    if (l2 && l2.verdict === "flag" && l3 && l3.ran && l3.verdict === "pass") {
      note = "L2 flagged it at " + l2.score.toFixed(2) + ". The judge read the redacted payload, cleared it at " +
        l3.score.toFixed(2) + ", and the call went through. L0 and L1 found nothing.";
    } else {
      note = "Each cell is one layer. The verdict is the worst of the rules and the model layer that ran last.";
    }
    $("[data-ex-note]").textContent = note;
  } else { $("[data-example]").hidden = true; }

  /* ── 03 · redaction: the two hashes and the kinds ────────────────────── */
  if (ex) {
    $("[data-ph]").innerHTML = hash(ex.payloadHash, "payloadHash");
    $("[data-rh]").innerHTML = hash(ex.redactedHash, "redactedHash");
    $("[data-kinds]").innerHTML = ex.redactions.map(function (r) {
      return '<span class="chip neutral">' + esc(r.kind) + " ×" + r.count + "</span>";
    }).join("");
  }
  M.mountDrawIn($(".hiw-redact__arrow"));

  /* ── 04 · the attestation in the figure ──────────────────────────────── */
  if (att) {
    $("[data-att-kv]").innerHTML =
      kvItem("Status", ui.status(att.status)) +
      kvItem("Action hash", hash(att.actionHash, "Action hash")) +
      kvItem("Nullifier", hash(att.nullifier, "Nullifier"), "spent on consume") +
      kvItem("Expiry slot", '<span class="hiw-kv__mono">' + esc(fmt.slot(att.expirySlot)) + "</span>") +
      kvItem("Transaction", att.txSig ? hash(att.txSig, "Transaction") : '<span class="hiw-kv__sub">not submitted</span>');
  }

  /* ── 05 · what binds it: the five fields → the action hash ───────────── */
  var altered = false;
  function actionHashOf(a) { return D.hx(D.canonical(a)); }
  function renderBind() {
    if (!action || !att) return;
    var a = Object.assign({}, action);
    if (altered) a.amount = String(BigInt(action.amount) + 1n);
    var lamports = fmt.int ? fmt.int(Number(a.amount)) : a.amount;
    $("[data-bind-kv]").innerHTML =
      kvItem("Target program", hash(a.targetProgram, "Target program"), esc(D.programName(a.targetProgram) || a.instruction || "")) +
      kvItem("Recipient", hash(a.recipient, "Recipient")) +
      kvItem("Amount", '<span data-amount>' + esc(fmt.amount(a.amount)) + " SOL</span>", '<span data-amount>' + esc(lamports) + " lamports</span>") +
      kvItem("Policy root", hash(att.policyRoot, "Policy root")) +
      kvItem("Expiry slot", '<span class="hiw-kv__mono">' + esc(fmt.slot(att.expirySlot)) + "</span>");
    var h = actionHashOf(a), ok = h === att.actionHash;
    $("[data-bind-hash]").innerHTML = hash(h, "Action hash");
    $("[data-bind-state]").innerHTML = ok
      ? '<span class="chip neutral">' + ico("check") + "Matches the attestation</span>"
      : '<span class="chip flag">' + ico("circle-alert") + "No match · worthless for this call</span>";
    var btn = $("[data-bind-toggle]");
    btn.setAttribute("aria-pressed", altered ? "true" : "false");
    btn.querySelector("span").textContent = altered ? "Restore the amount" : "Change the amount by one lamport";
  }
  renderBind();
  $("[data-bind-toggle]").addEventListener("click", function () {
    var box = $("[data-bind]");
    altered = !altered;
    if (reduced()) { renderBind(); return; }
    box.classList.add("is-swapping");
    M.wait(140).then(function () { renderBind(); M.raf2(function () { box.classList.remove("is-swapping"); }); });
  });

  /* ── 06 · the head + walk the chain ──────────────────────────────────── */
  var head = D.audit && D.audit.head;
  if (head) {
    var hk = $("[data-head-kv]");
    hk.style.setProperty("--kv-cols", "3");
    hk.innerHTML =
      kvItem("Chain head", '<span class="hiw-kv__mono">#' + esc(fmt.int ? fmt.int(head.index) : head.index) + "</span>") +
      kvItem("Head hash", hash(head.hash, "Head hash")) +
      kvItem("Window shown", '<span class="hiw-kv__mono">#4 – #7</span>');
  }
  var walkBtn = $("[data-walk-btn]"), walkList = $("[data-walk]");
  walkBtn.addEventListener("click", function () {
    if (walkBtn.getAttribute("aria-busy") === "true") return;
    var n = (D.audit && D.audit.entries) ? D.audit.entries.length : 0;
    walkList.innerHTML = ui.checkItem({ title: "Recompute " + n + " entries back from the head", state: "running", end: "" });
    var li = walkList.firstElementChild;
    walkBtn.setAttribute("aria-busy", "true");
    walkBtn.disabled = true;
    M.wait(900).then(function () {
      var r = D.verifyChain();
      if (r.ok) ui.check(li, "pass", { end: "#" + r.checkedFrom + " – #" + r.checkedTo + " intact" });
      else ui.check(li, "fail", { end: "breaks at #" + r.brokenAt, reason: "Entry #" + r.brokenAt + " does not match the hash its successor recorded. #" + r.checkedFrom + " – #" + r.checkedTo + " are intact." });
      walkBtn.removeAttribute("aria-busy");
      walkBtn.disabled = false;
      walkBtn.querySelector("span").textContent = "Walk it again";
    });
  });

  /* ── the four figures, each with a replay link ───────────────────────── */
  var entries = (D.audit && D.audit.entries || []).slice(0, 10).map(function (e) { return { index: e.index, hash: e.hash }; });
  var FIGS = [
    ["#fig-architecture", "architecture", {}],
    ["#fig-layers", "layers", { highlight: "L2", verdict: "flag" }],
    ["#fig-lifecycle", "lifecycle", { status: "consumed" }],
    ["#fig-chain", "chain", entries.length ? { window: [4, 7], entries: entries } : { window: [4, 7] }]
  ];
  FIGS.forEach(function (f) {
    var host = BS.diagrams.render(f[1], $(f[0]), f[2]);
    if (!host) return;
    var cap = host.querySelector(":scope > figcaption");
    if (cap) cap.setAttribute("data-n", host.getAttribute("data-fig-n"));
    var b = document.createElement("button");
    b.type = "button"; b.className = "hiw-replay"; b.setAttribute("data-replay", f[1]);
    b.setAttribute("aria-label", "Replay figure " + host.getAttribute("data-fig-n"));
    b.innerHTML = ico("rotate-ccw") + "<span>Replay</span>";
    host.appendChild(b);
    /* a figure that has not drawn yet cannot replay (BS.diagrams keeps it for the scroll) */
    var sync = function () { b.disabled = !host.classList.contains("is-drawn"); };
    sync();
    new MutationObserver(sync).observe(host, { attributes: true, attributeFilter: ["class"] });
    b.addEventListener("click", function () {
      if (reduced()) { BS.toast({ title: "Reduced motion is on", body: "Figures are shown drawn; replay is off.", tone: "info", id: "replay" }); return; }
      BS.diagrams.replay(host);
    });
  });

  /* ── the TOC: progress fill + scroll-spy + navigation ────────────────── */
  var secs = $$(".hiw-sec");
  var links = {};
  $$("[data-toc]").forEach(function (a) { links[a.getAttribute("data-toc")] = a; });
  var fill = $(".hiw-toc__fill"), topBtn = $("[data-top]");
  var visible = {}, ioActive = "", active = null, atBottom = false;

  function setActive(id) {
    if (id === active) return;
    active = id;
    Object.keys(links).forEach(function (k) {
      var on = k === id;
      links[k].classList.toggle("is-active", on);
      if (on) links[k].setAttribute("aria-current", "location"); else links[k].removeAttribute("aria-current");
    });
  }
  function resolve() {
    if (atBottom) return setActive(secs[secs.length - 1].id);
    /* above the first section's band: nothing is active (the masthead is not in the contents) */
    if (secs[0].getBoundingClientRect().top > window.innerHeight * 0.3) return setActive("");
    setActive(ioActive);
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { if (e.isIntersecting) visible[e.target.id] = 1; else delete visible[e.target.id]; });
    for (var i = secs.length - 1; i >= 0; i--) { if (visible[secs[i].id]) { ioActive = secs[i].id; break; } }
    resolve();
  }, { rootMargin: "-20% 0px -70% 0px" });
  secs.forEach(function (s) { io.observe(s); });

  var pend = 0;
  function onScroll() {
    pend = 0;
    var se = document.scrollingElement || document.documentElement;
    var max = se.scrollHeight - window.innerHeight;
    var y = window.scrollY;
    var p = max > 0 ? Math.min(1, Math.max(0, y / max)) : 0;
    fill.style.transform = "scaleY(" + p.toFixed(4) + ")";
    atBottom = max > 0 && max - y < 2;
    topBtn.disabled = y < 8;
    resolve();
  }
  window.addEventListener("scroll", function () { if (!pend) pend = requestAnimationFrame(onScroll); }, { passive: true });
  window.addEventListener("resize", function () { if (!pend) pend = requestAnimationFrame(onScroll); });
  onScroll();

  function go(id) {
    var sec = document.getElementById(id);
    if (!sec) return;
    sec.scrollIntoView({ behavior: reduced() ? "instant" : "smooth", block: "start" });
    try { history.replaceState(null, "", "#" + id); } catch (e) { /* file:// */ }
    var h = sec.querySelector("h2");
    if (h) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
  }
  Object.keys(links).forEach(function (id) {
    links[id].addEventListener("click", function (e) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
      e.preventDefault();
      go(id);
    });
  });
  topBtn.addEventListener("click", function () {
    window.scrollTo({ top: 0, behavior: reduced() ? "instant" : "smooth" });
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* file:// */ }
    var t = $("#hiw-title"); t.setAttribute("tabindex", "-1"); t.focus({ preventScroll: true });
  });

  BS.page = { go: go, active: function () { return active; }, figures: FIGS.map(function (f) { return f[0]; }) };
})();
