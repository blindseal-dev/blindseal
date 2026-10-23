/* ============================================================================
   D02 · Decision detail — page.js
   ----------------------------------------------------------------------------
   Renders one Decision (BS.data.decision(id)) into #d02: header band, then
   7 / 5 columns — Layers (figure + four rows) · Redaction · Action | Hashes ·
   Audit position · Attestation · Payload.

   id      ?id=<ulid>, else BS.data.featured.decisionId (state-aware: no-action
           → a decision without action, not-found → a missing id).
   prev /  BS.data.neighbors(id): prev = newer, next = older. In-place swap:
   next    pushState(?id=), the layers figure patches in place (no redraw), the
           audit # odometer rolls, the raw payload is DROPPED (never carried).
   attest  BS.data.requestAttestation(id, onProgress) → generating (chip +
           2px bar + "proving… n %" odometer) → generated (+ id hash + link).
           PROVER_UNAVAILABLE inline under the button; NO_ACTION_FIELDS =
           no button, the reason instead.
   reveal  Show redacted = BS.data.payloadRedacted(id) (sync, safe). Reveal raw
           = confirm dialog → BS.data.api("POST", "/decisions/:id/reveal", null,
           { "X-Confirm": "reveal" }). The raw string lives in one closure
           variable; Hide, prev / next, popstate and pagehide null it. Nothing
           touches localStorage / sessionStorage / IndexedDB / cookies.
   ========================================================================== */
(function () {
  "use strict";

  var BS = window.BS, D = BS.data, fmt = BS.fmt, ui = BS.ui, M = BS.motion;
  var esc = ui.esc, ico = function (n, o) { return BS.icon(n, o); };
  var ROOT = document.getElementById("d02");

  var LAYER = {
    L0: { name: "Rules", sees: "raw payload · proven" },
    L1: { name: "Patterns", sees: "raw payload · proven" },
    L2: { name: "Similarity", sees: "redacted · attested" },
    L3: { name: "Judge", sees: "redacted · attested" }
  };

  /* thresholds the policy commits to (r23 l2.score, r25 l3.confidence), read from the rules */
  function threshold(layer) {
    var re = layer === "L2" ? /^l2\.score\s*>=\s*([\d.]+)/ : /^l3\.confidence\s*>=\s*([\d.]+)/;
    var r = (D.policy.rules || []).filter(function (x) { return x.kind === "threshold" && x.enabled && re.test(x.value); })[0];
    return r ? { id: r.id, t: parseFloat(re.exec(r.value)[1]), value: r.value } : null;
  }
  function ruleTip(id) {
    var r = (D.policy.rules || []).filter(function (x) { return x.id === id; })[0];
    return r ? r.id + " · " + r.layer + " " + r.kind + (r.note ? " · " + r.note : "") : id;
  }

  /* ── page state (memory only) ──────────────────────────────────────────── */
  var cur = { id: null, d: null };
  var view = "hidden";          /* payload: hidden | redacted | loading | raw | error */
  var raw = null;               /* the revealed payload: memory only, dropped on nav */
  var attUi = { phase: "idle", error: null };   /* idle | busy | generating | generated | error */
  var figHost = null, odoEl = null, odo = null, pctOdo = null;
  var first = true;

  function q(s, r) { return (r || ROOT).querySelector(s); }
  function qa(s, r) { return [].slice.call((r || ROOT).querySelectorAll(s)); }
  function H(value, label, lg, full) { return ui.hash(value, { label: label, lg: lg !== false, short: full ? false : undefined }); }

  function idFromUrl() {
    var p = new URLSearchParams(location.search);
    return p.get("id") || D.featured.decisionId || "";
  }

  /* ── top bar: breadcrumb + prev / next ─────────────────────────────────── */
  var crumb = document.createElement("div");
  crumb.className = "d02-crumb";
  crumb.innerHTML =
    '<nav class="d02-crumb__trail" aria-label="Breadcrumb">' +
      '<a class="d02-crumb__root" href="' + esc(BS.ROUTES.dashboard.decisions) + '">Decisions</a>' +
      '<span class="d02-crumb__sep" aria-hidden="true">/</span>' +
      '<span class="d02-crumb__id" aria-current="page" data-crumb-id></span>' +
    "</nav>" +
    '<span class="d02-pager">' +
      '<button type="button" class="icon-btn" data-step="prev" aria-label="Newer decision" data-tip="Newer decision">' + ico("chevron-left") + "</button>" +
      '<button type="button" class="icon-btn" data-step="next" aria-label="Older decision" data-tip="Older decision">' + ico("chevron-right") + "</button>" +
      '<span class="d02-pager__pos" data-pos></span>' +
    "</span>";

  BS.mountShell({ active: "decisions", title: "Decision", actions: crumb });

  crumb.addEventListener("click", function (e) {
    var b = e.target.closest("[data-step]");
    if (!b || b.disabled) return;
    var to = b.getAttribute("data-step") === "prev" ? cur.prevId : cur.nextId;
    if (!to) return;
    go(to, true);
    /* keep the pager usable from the keyboard at either end of the list */
    var other = q('[data-step="' + (b.getAttribute("data-step") === "prev" ? "next" : "prev") + '"]', crumb);
    if (b.disabled && other && !other.disabled) other.focus();
  });

  function setCrumb(id, d) {
    q("[data-crumb-id]", crumb).textContent = ui.shortHash(id);
    q("[data-crumb-id]", crumb).setAttribute("title", id);
    var nb = d ? D.neighbors(id) : { prev: null, next: null };
    cur.prevId = nb.prev; cur.nextId = nb.next;
    q('[data-step="prev"]', crumb).disabled = !nb.prev;
    q('[data-step="next"]', crumb).disabled = !nb.next;
    var i = d ? D.decisions.indexOf(d) : -1;
    q("[data-pos]", crumb).textContent = i >= 0 ? fmt.int(i + 1) + " of " + fmt.int(D.decisions.length) : "";
  }

  /* ── pieces ────────────────────────────────────────────────────────────── */
  function verdictLg(v) { return ui.verdict(v).replace('class="verdict ', 'class="verdict d02-verdict '); }

  function head(d) {
    var ran = d.layers.filter(function (l) { return l.ran; }).length;
    return '<section class="panel d02-head" data-rise>' +
      '<div class="d02-head__main">' + verdictLg(d.verdict) +
        '<h1 class="d02-head__title"><span>' + esc(d.server) + '</span><i aria-hidden="true">·</i><span>' + esc(d.tool) +
        '</span><i aria-hidden="true">·</i><span class="d02-head__dir">' + esc(d.direction) + "</span></h1></div>" +
      '<dl class="d02-meta">' +
        '<div class="d02-meta__item"><dt>Screened</dt><dd><span class="num">' + esc(fmt.dateTime(d.ts)) + '</span><span class="d02-meta__ago">' + esc(fmt.timeAgo(d.ts)) + "</span></dd></div>" +
        '<div class="d02-meta__item"><dt>Latency</dt><dd class="num">' + esc(fmt.ms(d.latencyMs)) + "</dd></div>" +
        '<div class="d02-meta__item"><dt>Layers</dt><dd>' + ui.layerStrip(d.layers, { lg: true }) + '<span class="d02-meta__ago">' + ran + " of 4 ran</span></dd></div>" +
        '<div class="d02-meta__item"><dt>Decision id</dt><dd>' + H(d.id, "Decision id") + "</dd></div>" +
        '<div class="d02-meta__item"><dt>Detector</dt><dd><span class="chip outline d02-mono">' + esc(d.detectorVersion) + "</span></dd></div>" +
      "</dl></section>";
  }

  function scoreCell(l) {
    if (!l.ran) return '<span class="d02-faint">' + (l.layer === "L3" ? "not run: L0–L2 clean" : "not run") + "</span>";
    var th = threshold(l.layer);
    var s = Math.max(0, Math.min(1, Number(l.score) || 0));
    return '<span class="d02-score"><span class="d02-bar" data-p="' + s + '"><i></i>' +
      (th ? '<b class="d02-bar__tick" style="--t:' + th.t + '" tabindex="0" role="img" aria-label="' + esc("Policy threshold " + th.id + ": " + th.value) + '" data-tip="' + esc(th.id + " · " + th.value) + '"></b>' : "") +
      '</span><span class="d02-score__v num">' + s.toFixed(2) + "</span></span>";
  }
  function rulesCell(l) {
    var ids = l.ruleIds || [];
    if (!ids.length) return '<span class="d02-faint">no rule hits</span>';
    return '<span class="d02-rules">' + ids.map(function (r) {
      return '<span class="chip outline d02-mono d02-rule" tabindex="0" data-tip="' + esc(ruleTip(r)) + '">' + esc(r) + "</span>";
    }).join("") + "</span>";
  }
  function layersPanel(d) {
    var ran = d.layers.filter(function (l) { return l.ran; });
    var ms = ran.reduce(function (a, l) { return a + (l.latencyMs || 0); }, 0);
    var rows = d.layers.map(function (l) {
      var meta = LAYER[l.layer] || { name: l.layer, sees: "" };
      var model = l.layer === "L2" || l.layer === "L3";
      return '<div class="d02-lrow" role="row" data-layer="' + esc(l.layer) + '">' +
        '<span role="cell" class="d02-lrow__layer"><b>' + esc(l.layer) + "</b><span>" + esc(meta.name) + "<small>" + esc(meta.sees) + "</small></span></span>" +
        '<span role="cell">' + (l.ran ? '<span class="d02-ran">ran</span>' : '<span class="chip outline">skipped</span>') + "</span>" +
        '<span role="cell">' + (l.ran ? ui.verdict(l.verdict) : '<span class="d02-faint">—</span>') + "</span>" +
        '<span role="cell" class="d02-lrow__evidence">' + (model ? scoreCell(l) : rulesCell(l)) + "</span>" +
        '<span role="cell">' + (model && l.ran && l.mode ? '<span class="chip neutral d02-mono">' + esc(l.mode) + "</span>" : '<span class="d02-faint">—</span>') + "</span>" +
        '<span role="cell" class="d02-lrow__ms num">' + (l.ran ? esc(fmt.ms(l.latencyMs)) : '<span class="d02-faint">—</span>') + "</span>" +
      "</div>";
    }).join("");
    return '<section class="panel d02-layers" data-rise>' +
      '<header class="panel__head"><h2 class="panel__title">Layers</h2><p class="sub num">' + ran.length + " ran · " + (4 - ran.length) + " skipped · " + esc(fmt.ms(ms)) + " in layers</p></header>" +
      '<div class="d02-fig-slot"></div>' +
      '<div class="d02-ltable" role="table" aria-label="Layer results">' +
        '<div class="d02-lrow d02-lrow--head" role="row"><span role="columnheader">Layer</span><span role="columnheader">Ran</span><span role="columnheader">Verdict</span><span role="columnheader">Score · rule hits</span><span role="columnheader">Mode</span><span role="columnheader" class="d02-lrow__ms">Latency</span></div>' +
        rows + "</div></section>";
  }

  function redactionPanel(d) {
    var total = d.redactions.reduce(function (a, r) { return a + r.count; }, 0);
    var kinds = d.redactions.length
      ? '<div class="d02-kinds">' + d.redactions.map(function (r) {
          return '<span class="chip neutral d02-mono">' + esc(r.kind) + ' <span class="d02-kinds__x">×</span> ' + r.count + "</span>";
        }).join("") + "</div>"
      : '<p class="d02-note">Nothing matched a redaction kind, so L2 and L3 saw the payload as sent: the two hashes are identical.</p>';
    return '<section class="panel d02-red" data-rise>' +
      '<header class="panel__head"><h2 class="panel__title">Redaction</h2><p class="sub num">' +
        (total ? total + (total === 1 ? " value" : " values") + " in " + d.redactions.length + (d.redactions.length === 1 ? " kind" : " kinds") : "Nothing redacted") + "</p></header>" +
      kinds +
      '<div class="d02-pair' + (d.payloadHash === d.redactedHash ? " is-same" : "") + '">' +
        '<div class="d02-pair__side"><p class="d02-k">pre-redaction</p>' + H(d.payloadHash, "payloadHash") + "</div>" +
        '<span class="d02-pair__arrow" aria-hidden="true">' + ico(d.payloadHash === d.redactedHash ? "minus" : "arrow-right") + "</span>" +
        '<div class="d02-pair__side"><p class="d02-k">what L2 and L3 saw</p>' + H(d.redactedHash, "redactedHash") + "</div>" +
      "</div></section>";
  }

  function amountOf(a) {
    if (a.amount == null) return { v: "—", sub: "" };
    if (a.chain === "evm") return { v: fmt.amount(a.amount, 18) + " ETH", sub: fmt.int(Number(a.amount)) + " wei" };
    if (!a.mint) return { v: fmt.amount(a.amount, 9) + " SOL", sub: fmt.amount(a.amount, 0) + " lamports" };
    return { v: fmt.amount(a.amount, 0), sub: "base units of the mint" };
  }
  function actionPanel(d) {
    var a = d.action; if (!a) return "";
    var amt = amountOf(a);
    var progName = D.programName(a.targetProgram), mintName = a.mint ? D.programName(a.mint) : null;
    function item(k, v, sub) { return '<div class="kv__item"><span class="kv__k">' + k + '</span><span class="kv__v">' + v + "</span>" + (sub ? '<span class="d02-kvsub">' + sub + "</span>" : "") + "</div>"; }
    return '<section class="panel d02-action" data-rise>' +
      '<header class="panel__head"><h2 class="panel__title">Action</h2><p class="sub">parsed from the payload · hashed into any attestation</p></header>' +
      '<div class="kv d02-kv3">' +
        item("Chain", '<span class="chip neutral d02-mono">' + esc(a.chain) + "</span>") +
        item("Instruction", '<span class="d02-mono d02-ink">' + esc(a.instruction || "—") + "</span>") +
        item("Amount", '<span class="num">' + esc(amt.v) + "</span>", esc(amt.sub)) +
        item("Target program", H(a.targetProgram, "Target program"), progName ? esc(progName) : "") +
        item("Recipient", a.recipient ? H(a.recipient, "Recipient") : '<span class="d02-faint">—</span>') +
        item("Mint", a.mint ? H(a.mint, "Mint") : '<span class="d02-faint">native</span>', mintName ? esc(mintName) : "") +
      "</div></section>";
  }

  function hashesPanel(d) {
    var curRoot = d.policyRoot === D.policy.root;
    function row(k, v, label, extra) { return '<div class="kv__item"><span class="kv__k">' + k + '</span><span class="kv__v">' + (extra || "") + H(v, label) + "</span></div>"; }
    return '<section class="panel d02-hashes" data-rise>' +
      '<header class="panel__head"><h2 class="panel__title">Hashes</h2><p class="sub">click to copy</p></header>' +
      '<div class="kv kv--rows">' +
        row("Payload hash", d.payloadHash, "payloadHash") +
        row("Redacted hash", d.redactedHash, "redactedHash") +
        row("Policy root", d.policyRoot, "policyRoot", '<span class="chip ' + (curRoot ? "neutral" : "outline") + '">' + (curRoot ? "current" : "earlier") + "</span>") +
        row("Audit hash", d.auditHash, "auditHash") +
      "</div></section>";
  }

  function auditPanel(d) {
    var e = D.entry(d.auditIndex);
    var total = D.audit.head.index + 1;
    return '<section class="panel d02-audit" data-rise>' +
      '<header class="panel__head"><h2 class="panel__title">Audit position</h2><p class="sub num">' + fmt.int(total) + " entries · head #" + fmt.int(D.audit.head.index) + "</p></header>" +
      '<div class="d02-audit__main"><span class="d02-audit__odo" data-odo-slot></span>' +
        '<div class="d02-audit__chain">' +
          '<p><span class="d02-k">entry</span>' + H(d.auditHash, "auditHash") + "</p>" +
          (e ? '<p><span class="d02-k">prev</span>' + H(e.prevHash, "prevHash") + "</p>" : "") +
        "</div></div>" +
      '<div class="panel__foot"><span class="d02-faint">chained, content-free</span>' +
        '<a class="btn link" href="../D03/index.html?index=' + d.auditIndex + '">Open in audit<span class="nudge">' + ico("arrow-right") + "</span></a></div>" +
      "</section>";
  }

  function attestationPanel() {
    return '<section class="panel d02-att" data-rise aria-live="polite">' +
      '<header class="panel__head"><h2 class="panel__title">Attestation</h2><span data-att-chip></span></header>' +
      '<div class="d02-att__body" data-att-body></div></section>';
  }

  function payloadPanel() {
    return '<section class="panel d02-pay" data-rise>' +
      '<header class="panel__head"><h2 class="panel__title">Payload</h2><span data-pay-chip></span></header>' +
      '<p class="d02-note" data-pay-note>Hidden by default. The redacted view is safe to show; the raw payload needs a confirmation and is never stored.</p>' +
      '<div class="d02-pay__actions" data-pay-actions></div>' +
      '<div class="d02-pay__out" data-pay-out></div></section>';
  }

  function notFound(id) {
    /* the kit's .empty markup, written out so the id can sit in mono */
    return '<section class="panel d02-nf" data-rise><div class="empty" role="status">' +
      '<span class="empty__icon">' + ico("circle-alert") + "</span>" +
      '<p class="empty__title">No decision with that id.</p>' +
      '<p class="empty__body">Nothing in the local log matches ' + (id ? '<span class="d02-mono d02-ink">' + esc(id) + "</span>" : "this id") + ". It may belong to another proxy, or the link was cut short.</p>" +
      '<div class="empty__actions"><a class="btn secondary" href="' + esc(BS.ROUTES.dashboard.decisions) + '">' + ico("chevron-left") + "Back to decisions</a></div>" +
      "</div></section>";
  }

  /* ── attestation panel states ──────────────────────────────────────────── */
  var attOff = null;
  function renderAtt(fx) {
    var d = cur.d, chip = q("[data-att-chip]"), body = q("[data-att-body]");
    if (!d || !body) return;
    var html = "", chipHtml = "";
    var a = d.attestationId ? D.attestation(d.attestationId) : null;

    if (a) {
      var gen = a.status === "generating";
      chipHtml = ui.status(a.status, { progress: a.progressPct });
      html =
        '<div class="d02-att__id"><span class="d02-k">attestation</span>' + H(a.id, "Attestation id", true, true) + "</div>" +
        (gen
          ? '<div class="progress d02-att__bar"><i style="--p:' + ((a.progressPct || 0) / 100) + '"></i></div>' +
            '<p class="d02-att__line"><span>proving…</span><span class="d02-att__pct" data-pct></span><span>%</span></p>'
          : '<p class="d02-att__meta num">' + attMeta(a) + "</p>") +
        '<div class="panel__foot"><span class="d02-faint">' + (gen ? "generated locally · single-use" : "bound to this action · single-use") + "</span>" +
        '<a class="btn link" href="../D05/index.html?id=' + encodeURIComponent(a.id) + '">Open attestation<span class="nudge">' + ico("arrow-right") + "</span></a></div>";
    } else if (!d.action) {
      html = '<p class="d02-note">No attestation can be requested for this decision. It did not parse as an on-chain action, so there is no target program, recipient or amount to bind a proof to.</p>' +
        '<p class="d02-code-tag"><span class="d02-mono">NO_ACTION_FIELDS</span></p>';
    } else if (d.verdict !== "pass") {
      html = '<p class="d02-note">Only a call that passed can be attested. This one was ' + (d.verdict === "block" ? "blocked" : "flagged") + ", so the proof would have nothing true to say.</p>" +
        '<div class="d02-att__actions"><button type="button" class="glass-btn primary" disabled>' + ico("stamp") + "Request attestation</button></div>";
    } else {
      var busy = attUi.phase === "busy";
      html = '<p class="d02-note">Bind a zero-knowledge attestation to this action: target program, recipient, amount, policy root and expiry are hashed into it. It is single-use.</p>' +
        '<div class="d02-att__actions"><button type="button" class="glass-btn primary" data-request' + (busy ? ' aria-busy="true" disabled' : "") + ">" +
          ico("stamp") + (busy ? "Requesting…" : attUi.phase === "error" ? "Try again" : "Request attestation") + "</button>" +
          '<span class="d02-faint">≈ 6 s on this machine</span></div>' +
        (attUi.phase === "error" ? errLine(attUi.error) : "");
    }

    chip.innerHTML = chipHtml;
    body.innerHTML = html;
    if (fx) { M.restart(body, "fade-in"); if (chipHtml) M.restart(chip, "fade-in"); }

    var pctEl = q("[data-pct]");
    if (pctEl) pctOdo = M.odometer(pctEl, Math.round(a.progressPct || 0), { format: function (v) { return String(v); } });
    else pctOdo = null;

    var btn = q("[data-request]");
    if (btn) btn.addEventListener("click", request);
  }
  function attMeta(a) {
    var bits = [];
    if (a.createdAt) bits.push("created " + esc(fmt.timeAgo(a.createdAt)));
    if (a.expirySlot != null) bits.push("expires slot " + esc(fmt.slot(a.expirySlot)));
    if (a.tee && a.tee.mode) bits.push("tee " + esc(a.tee.mode));
    return bits.join(" · ");
  }
  function errLine(e) {
    var code = (e && e.code) || "ERROR";
    if (code === "PROVER_UNAVAILABLE") {
      return '<p class="d02-err" role="alert">' + ico("triangle-alert") + '<span>Prover unavailable · <a class="link" href="' + esc(BS.ROUTES.dashboard.settings) + '">see Settings →</a></span><span class="d02-mono d02-err__code">' + code + "</span></p>";
    }
    return '<p class="d02-err" role="alert">' + ico("triangle-alert") + "<span>" + esc((e && e.message) || "The request failed.") + '</span><span class="d02-mono d02-err__code">' + esc(code) + "</span></p>";
  }

  function request() {
    var d = cur.d; if (!d || attUi.phase === "busy" || attUi.phase === "generating") return;
    var id = d.id;
    attUi = { phase: "busy", error: null };
    renderAtt(false);
    /* the POST round trip: a short acknowledged press before the 202 (or the error) */
    M.wait(320).then(function () {
      if (cur.id !== id) { attUi = { phase: "idle", error: null }; return null; }
      var p = D.requestAttestation(id, function (pct, a) {
        if (cur.id !== id) return;
        if (attUi.phase !== "generating") { attUi = { phase: "generating", error: null }; renderAtt(true); return; }
        progress(pct);
      });
      return p.then(function (a) {
        if (cur.id !== id) return;
        attUi = { phase: "generated", error: null };
        renderAtt(true);
        BS.toast({ title: "Attestation generated", body: "Proved locally in " + fmt.ms(D.status.prover.lastProofMs) + ". Single-use; open it to submit or export.", tone: "ok", id: "att" });
      }, function (e) {
        if (cur.id !== id) return;
        attUi = { phase: "error", error: e };
        renderAtt(true);
      });
    });
  }
  function progress(pct) {
    var chip = q("[data-att-chip] .status");
    if (chip) ui.setStatus(chip, "generating", { progress: pct });
    ui.progress(q(".d02-att__bar"), pct / 100);
    if (pctOdo) pctOdo.set(Math.round(pct));
  }
  /* live updates for attestations driven elsewhere (the event bus mirrors WS /events) */
  D.on("attestation", function (ev) {
    var d = cur.d;
    if (!d || d.attestationId !== ev.id || attUi.phase === "generating") return;
    var chip = q("[data-att-chip] .status");
    if (ev.status === "generating" && chip && chip.getAttribute("data-s") === "generating") progress(ev.progressPct || 0);
    else renderAtt(true);
  });

  /* ── payload panel ─────────────────────────────────────────────────────── */
  function codeRedacted(text) {
    var body = esc(text).replace(/\[REDACTED:([a-z_]+)\]/g, '<span class="d02-redmark">[REDACTED:$1]</span>');
    return '<div class="code d02-code"><span class="code__lang">redacted</span><pre><code>' + body + "</code></pre>" +
      '<button type="button" class="copy code__copy" data-copy="' + esc(text) + '" aria-label="Copy the redacted payload">' + ico("copy") + "</button></div>";
  }
  /* align raw against the redacted text: the gaps between literal runs are the secrets */
  function markSecrets(rawText, redText) {
    var parts = redText.split(/\[REDACTED:[a-z_]+\]/);
    var kinds = (redText.match(/\[REDACTED:([a-z_]+)\]/g) || []).map(function (m) { return m.slice(10, -1); });
    if (!kinds.length) return esc(rawText);
    var pat = parts.map(function (p) { return p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).join("([\\s\\S]*?)");
    var m = new RegExp("^" + pat + "$").exec(rawText);
    if (!m) return esc(rawText);
    var out = "";
    parts.forEach(function (p, i) {
      out += esc(p);
      if (i < kinds.length) out += '<mark class="d02-secret" data-kind="' + esc(kinds[i]) + '" data-tip="' + esc(kinds[i]) + ' · redacted before L2">' + esc(m[i + 1]) + "</mark>";
    });
    return out;
  }
  function codeRaw(rawText, redText) {
    return '<div class="code d02-code is-raw"><span class="code__lang">raw</span><pre><code>' + markSecrets(rawText, redText) + "</code></pre></div>";
  }

  function renderPay(fx) {
    var d = cur.d; if (!d) return;
    var chip = q("[data-pay-chip]"), acts = q("[data-pay-actions]"), out = q("[data-pay-out]"), note = q("[data-pay-note]");
    var chipHtml = { hidden: '<span class="chip outline">hidden</span>', redacted: '<span class="chip neutral">redacted view</span>',
      loading: '<span class="chip outline">revealing…</span>', raw: '<span class="chip flag">raw · in memory</span>', error: '<span class="chip outline">hidden</span>' }[view];
    chip.innerHTML = chipHtml;
    note.hidden = view === "raw";
    if (view === "raw") {
      acts.innerHTML = '<p class="d02-raw-note">' + ico("info") + "Shown in memory only. Leaving this decision drops it.</p>" +
        '<button type="button" class="btn link" data-hide>Hide</button>';
    } else {
      acts.innerHTML =
        '<button type="button" class="btn secondary sm" data-redacted aria-pressed="' + (view === "redacted") + '">Show redacted</button>' +
        '<button type="button" class="btn ghost sm" data-reveal' + (view === "loading" ? ' aria-busy="true" disabled' : "") + ">" + (view === "loading" ? "Revealing…" : "Reveal raw") + "</button>";
    }
    var html = "";
    if (view === "redacted") html = codeRedacted(D.payloadRedacted(d.id));
    else if (view === "raw" && raw != null) html = codeRaw(raw, D.payloadRedacted(d.id));
    else if (view === "loading") html = '<div class="d02-loading"><span class="track"><span></span></span><span class="d02-mono d02-faint">POST /decisions/' + esc(ui.shortHash(d.id)) + "/reveal · X-Confirm: reveal</span></div>";
    else if (view === "error") html = errLine(cur.payErr);
    out.innerHTML = html;
    if (fx && html) M.restart(out, "d02-details-in");
    var b;
    if ((b = q("[data-redacted]"))) b.addEventListener("click", function () {
      if (view === "redacted") { view = "hidden"; leave(function () { renderPay(false); focusPay("[data-redacted]"); }); }
      else { view = "redacted"; renderPay(true); focusPay("[data-redacted]"); }
    });
    if ((b = q("[data-reveal]"))) b.addEventListener("click", confirmReveal);
    if ((b = q("[data-hide]"))) b.addEventListener("click", function () {
      dropRaw();                                   /* memory first; the DOM copy fades 140ms, then goes */
      leave(function () { renderPay(false); focusPay("[data-reveal]"); });
    });
  }
  /* exit: the kit's fade-out (140ms in-quick) on the code block, then clear; instant under reduce */
  function leave(then) {
    var out = q("[data-pay-out]");
    if (!out || !out.firstChild || M.reduced()) { then(); return; }
    out.classList.remove("d02-details-in");
    out.classList.add("d02-leaving");
    setTimeout(function () { out.classList.remove("d02-leaving"); then(); }, M.scale(140));
  }
  function focusPay(sel) { var el = q(sel); if (el) el.focus({ preventScroll: true }); }
  function dropRaw() { raw = null; if (view === "raw" || view === "loading") view = "hidden"; }

  function confirmReveal() {
    var d = cur.d; if (!d) return;
    ui.dialog({
      title: "Reveal the raw tool call?",
      body: '<p>It is shown in memory only and never written to disk or browser storage.</p>' +
        '<p class="d02-dialog-detail"><span class="d02-mono">POST /decisions/' + esc(ui.shortHash(d.id)) + "/reveal</span><span class=\"d02-mono\">X-Confirm: reveal</span></p>",
      actions: [
        { label: "Cancel", cls: "btn secondary" },
        { label: "Reveal", cls: "btn primary", onClick: function () { doReveal(d.id); } }
      ]
    });
  }
  function doReveal(id) {
    view = "loading"; renderPay(true);
    D.api("POST", "/decisions/" + id + "/reveal", null, { "X-Confirm": "reveal" }).then(function (res) {
      if (cur.id !== id || view !== "loading") return;      /* navigated away: drop it */
      raw = res.payload; view = "raw"; renderPay(true);
      var h = q("[data-hide]"); if (h) h.focus({ preventScroll: true });
    }, function (e) {
      if (cur.id !== id) return;
      cur.payErr = e; view = "error"; renderPay(true);
    });
  }

  /* ── render ────────────────────────────────────────────────────────────── */
  function fillBars(animate) {
    qa(".d02-bar").forEach(function (b) {
      var p = b.getAttribute("data-p");
      if (!animate || M.reduced()) { b.classList.add("is-instant"); b.style.setProperty("--p", p); return; }
      b.style.setProperty("--p", "0");
      M.whenUncovered().then(function () { M.raf2(function () { b.style.setProperty("--p", p); }); });
    });
  }

  function render(id, swap) {
    cur.id = id;
    cur.d = D.decision(id);
    var d = cur.d;
    setCrumb(id, d);

    if (!d) {
      ROOT.innerHTML = notFound(id);
      document.title = "Decision not found · Blindseal";
      if (first) M.rise(qa("[data-rise]"), { y: 14 });
      return;
    }
    document.title = "Decision " + ui.shortHash(d.id) + " · Blindseal";

    ROOT.innerHTML = head(d) +
      '<div class="d02-cols">' +
        '<div class="d02-col d02-col--l">' + layersPanel(d) + redactionPanel(d) + actionPanel(d) + "</div>" +
        '<div class="d02-col d02-col--r">' + hashesPanel(d) + auditPanel(d) + attestationPanel() + payloadPanel() + "</div>" +
      "</div>";

    /* the figure host and the odometer persist across swaps: the figure patches, the digits roll */
    var hl = (d.layers.filter(function (l) { return l.ran && l.verdict !== "pass"; })[0] || {}).layer || "L3";
    if (!figHost) { figHost = document.createElement("figure"); figHost.className = "fig d02-fig"; }
    q(".d02-fig-slot").appendChild(figHost);
    BS.diagrams.render("layers", figHost, { highlight: hl, verdict: d.verdict, results: d.layers, caption: false });

    if (!odoEl) { odoEl = document.createElement("span"); odoEl.className = "d02-odo"; odo = M.odometer(odoEl, d.auditIndex, { format: function (v) { return "#" + fmt.int(v); } }); }
    q("[data-odo-slot]").appendChild(odoEl);
    odo.set(d.auditIndex);

    renderAtt(false);
    renderPay(false);
    fillBars(true);

    if (first) {
      M.rise(q(".d02-head"), { y: 14 });
      M.rise(qa(".d02-col--l > [data-rise]"), { y: 14, from: 1 });
      M.rise(qa(".d02-col--r > [data-rise]"), { y: 14, from: 1 });
    } else if (swap) {
      /* prev / next is a frequent action: no page-wide fade. Only the header line
         settles in (200ms); the figure patches, the odometer rolls, the bars refill. */
      M.restart(q(".d02-head__main"), "fade-in");
    }
  }

  function go(id, push) {
    dropRaw(); view = "hidden"; cur.payErr = null;
    attUi = { phase: "idle", error: null };
    if (push) {
      var p = new URLSearchParams(location.search); p.set("id", id);
      history.pushState({ id: id }, "", "?" + p.toString());
    }
    render(id, true);
    var main = document.getElementById("main-content");
    if (main && main.scrollTop > 0) main.scrollTo({ top: 0, behavior: M.reduced() ? "auto" : "smooth" });
  }

  /* settle: once an entrance has played, drop its class so no animated ancestor
     stays over the glass button (the backdrop-root rule) */
  ROOT.addEventListener("animationend", function (e) {
    var t = e.target;
    if (!t.classList) return;
    ["bs-rise", "fade-in", "d02-details-in"].forEach(function (c) { if (t.classList.contains(c) && e.animationName !== "") t.classList.remove(c); });
  });

  window.addEventListener("popstate", function () { go(idFromUrl(), false); });
  window.addEventListener("pagehide", function () { raw = null; });

  render(idFromUrl(), false);
  first = false;

  /* QA hook for the Playwright checks (read-only view of page state, never the payload) */
  window.D02 = { state: function () { return { id: cur.id, view: view, rawHeld: raw != null, att: attUi.phase }; } };
})();
