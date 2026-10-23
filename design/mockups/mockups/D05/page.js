/* ============================================================================
   D05 — Dashboard: Attestations (page.js)
   ----------------------------------------------------------------------------
   Track every proof from request to consumption, submit one, export one
   (01-PAGES §2.5). GET /attestations?status is the status filter; WS
   `attestation` events are the live updates (progress bars move, chips
   change); the detail is a side sheet over the list (DECISIONS D10).

   ?id=<attestationId>  opens the sheet on load (D02 "Open attestation")
   ?state=empty         "No attestations yet." + the pointer to D01

   Kit only: BS.mountShell, BS.openSheet, BS.diagrams.render("lifecycle"),
   BS.ui.{seg, hash, status, setStatus, progress, empty, toast},
   BS.motion.{odometer, enterRow, flash, restart, scale, whenUncovered},
   BS.data.{attestations, decisions, submit, exportAttestation, slotNow,
   slotAt, sha256, hx, canonical, programName}, BS.fmt.
   Every hash (hex and base58) goes through BS.ui.hash(). Red appears only
   inside BS.ui.status() for rejected / failed. No colour literal here.

   Invented (logged on the board):
   - The fixtures carry six attestations, one per status except `failed`.
     The page adds the seventh, built with the fixtures' own functions from
     the first pass + action send_transaction decision older than 12 h:
     created 75 s after the decision, stopped at 41 %, no proof bytes, and a
     `reason` (the same non-§5 field the fixtures give `rejected`).
   - The generating row ticks 62 → 100 % in 11 uneven steps (≈ 8 s total,
     ×4 in slow-mo), then flips to `generated` with its proof bytes filled.
     Each step is a window "bs:attestation" event, the same channel the
     fixtures' submit() uses, so one handler drives every live change.
   - Lifecycle notes per status, toast copy, the explorer-link toast.
   ========================================================================== */
(function () {
  "use strict";

  var BS = window.BS, D = BS.data, ui = BS.ui, M = BS.motion, fmt = BS.fmt;
  var STATUSES = ["generating", "generated", "submitted", "consumed", "expired", "rejected", "failed"];
  var SLOT_MS = 400;                                   /* the fixtures' devnet slot model */
  var EXPIRY_SLOTS = 150000;                           /* the fixtures' default expiry window */
  var TICKS = [66, 70, 73, 77, 81, 84, 88, 91, 94, 97, 100];
  var TICK_MS = [760, 820, 640, 760, 820, 700, 640, 800, 700, 680, 680];   /* Σ ≈ 8.0 s */
  var FAILED_AT = 41;                                  /* % where the invented failed proof stopped */

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return [].slice.call((r || document).querySelectorAll(s)); }
  function esc(s) { return ui.esc(s); }
  function ico(n, o) { return BS.icon(n, o); }
  function reduced() { return M.reduced(); }
  function H(v, label, lg) { return ui.hash(v, { label: label, lg: !!lg }); }
  function nil() { return '<span class="d05-nil" aria-label="none">—</span>'; }
  /* a tooltip whose owner was just removed (sheet closed, rows re-rendered under a still pointer) must not linger */
  function dropTip() { var t = document.getElementById("bs-tooltip"); if (t) t.classList.remove("is-on"); }

  /* links carry the frozen clock and the motion mode, so the next page rebuilds the same fixtures */
  var CARRY = (function () {
    var q = new URLSearchParams(location.search), out = "";
    ["now", "motion"].forEach(function (k) { if (q.get(k)) out += "&" + k + "=" + encodeURIComponent(q.get(k)); });
    return out;
  })();
  function d02(id) { return "../D02/index.html?id=" + encodeURIComponent(id) + CARRY; }
  var D01_HREF = "../D01/index.html" + (CARRY ? "?" + CARRY.slice(1) : "");

  var EMPTY = BS.state.is("empty");

  /* ══ 1 · the seventh status: a failed attestation (fixtures carry six) ════ */
  var CROCK = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  function ulid(ms, seed) {
    var t = "", n = ms, i;
    for (i = 0; i < 10; i++) { t = CROCK.charAt(n % 32) + t; n = Math.floor(n / 32); }
    var h = D.sha256(seed), r = "";
    for (i = 0; i < 16; i++) r += CROCK.charAt(parseInt(h.substr(i * 2, 2), 16) % 32);
    return t + r;
  }
  function pad64(hex) { while (hex.length < 64) hex = "0" + hex; return hex; }
  (function addFailed() {
    if (EMPTY || D.attestations.some(function (a) { return a.status === "failed"; })) return;
    var dec = D.decisions.filter(function (d) {
      return d.action && d.action.chain === "solana" && d.verdict === "pass" && !d.attestationId &&
        d.tool === "send_transaction" && Date.parse(d.ts) < D.NOW - 12 * D.HOUR;
    })[0];
    if (!dec) return;
    var created = Math.min(Date.parse(dec.ts) + 75 * D.SEC, D.NOW - 20 * D.SEC);
    var nonce = "0x" + D.sha256("d05:failed:nonce:" + dec.id).slice(0, 32);
    var actionHash = D.hx(D.canonical(dec.action));
    var expirySlot = D.slotAt(created) + EXPIRY_SLOTS;
    var nullifier = D.hx("nullifier:" + nonce + actionHash);
    var a = {
      id: "att_" + ulid(created, "d05:failed:" + dec.id), version: 1, decisionId: dec.id,
      actionHash: actionHash, policyRoot: dec.policyRoot, detectorVersion: dec.detectorVersion,
      expirySlot: expirySlot, nullifier: nullifier, nonce: nonce,
      publicInputs: [actionHash, dec.policyRoot, D.hx(dec.detectorVersion), "0x" + pad64(expirySlot.toString(16)), nullifier],
      proof: { protocol: "groth16", curve: "bn254", bytes: "" },
      status: "failed",
      reason: "The local prover stopped at " + FAILED_AT + "%: witness generation ran out of memory. Nothing was submitted; request a new attestation from the decision.",
      createdAt: new Date(created).toISOString()
    };
    dec.attestationId = a.id;
    D.attestations.push(a);
    D.attestations.sort(function (x, y) { return Date.parse(y.createdAt) - Date.parse(x.createdAt); });
  })();

  /* ══ 2 · the shell ════════════════════════════════════════════════════════ */
  BS.mountShell({ active: "attestations", title: "Attestations" });

  var refs = {
    filters: $("#d05-filters"), seg: $("#d05-seg"), shown: $("#d05-shown"),
    life: $("#d05-life"), fig: $("#d05-life-fig"), note: $("#d05-life-note"),
    box: $("#d05-tablebox"), rows: $("#d05-rows"), none: $("#d05-none"), empty: $("#d05-empty")
  };

  /* ══ 3 · data helpers ═════════════════════════════════════════════════════ */
  function list() { return D.attestations.slice().sort(function (x, y) { return Date.parse(y.createdAt) - Date.parse(x.createdAt); }); }
  function find(id) { for (var i = 0; i < D.attestations.length; i++) if (D.attestations[i].id === id) return D.attestations[i]; return null; }
  function decisionOf(a) { for (var i = 0; i < D.decisions.length; i++) if (D.decisions[i].id === a.decisionId) return D.decisions[i]; return null; }
  function counts() {
    var c = { all: 0 };
    STATUSES.forEach(function (s) { c[s] = 0; });
    D.attestations.forEach(function (a) { c.all++; c[a.status] = (c[a.status] || 0) + 1; });
    return c;
  }
  function hasProof(a) { return /^0x[0-9a-f]{512}$/.test(a.proof.bytes || ""); }
  function proofBytes(a) { return hasProof(a) ? (a.proof.bytes.length - 2) / 2 : 0; }
  /* "≈ 16h 40m left" / "passed 2d ago" from the devnet slot model */
  function span(ms) {
    var m = Math.round(Math.abs(ms) / 60000);
    if (m < 60) return m + "m";
    var h = Math.floor(m / 60);
    if (h < 48) return h + "h " + (m % 60) + "m";
    return Math.floor(h / 24) + "d " + (h % 24) + "h";
  }
  function expiryNote(a) {
    var left = (a.expirySlot - D.slotNow()) * SLOT_MS;
    if (a.status === "consumed") return "spent before its expiry slot";
    return left > 0 ? "≈ " + span(left) + " left" : "passed ≈ " + span(left) + " ago";
  }
  function actionLine(act) {
    if (!act) return "";
    var prog = D.programName(act.targetProgram) || fmt.shortB58(act.targetProgram);
    var unit, dec = 9;
    if (act.chain === "solana") {
      if (act.mint) { unit = D.programName(act.mint) || "token"; if (/USDC/.test(unit)) { unit = "USDC"; dec = 6; } else if (/Wrapped SOL/.test(unit)) unit = "wSOL"; }
      else unit = "SOL";
    } else { unit = "base units"; dec = 0; }
    return '<span class="d05-act__prog">' + esc(prog) + "</span>" +
      (act.instruction ? '<span class="d05-act__sep">·</span><span class="d05-act__ix">' + esc(act.instruction) + "</span>" : "") +
      (act.amount ? '<span class="d05-act__sep">·</span><span class="num">' + esc(fmt.amount(act.amount, dec)) + "</span>&nbsp;" + esc(unit) : "") +
      (act.recipient ? '<span class="d05-act__sep">→</span>' + H(act.recipient, "Recipient") : "");
  }

  /* ══ 4 · the lifecycle strip (the legend of the statuses) ════════════════ */
  var LIFE_NOTE = {
    all: "Six steps from a screened decision to a spent nullifier. Expired, rejected and failed end the path early.",
    generating: "The local prover is building the Groth16 proof.",
    generated: "Proof ready. Valid until its expiry slot; it can be submitted once.",
    submitted: "Sent to the verifier program. The nullifier is not spent yet.",
    consumed: "Verified on chain. The nullifier is spent, so it cannot be used again.",
    expired: "The expiry slot passed before it was used. It is worthless now.",
    rejected: "The verifier refused the transaction. Nothing was consumed.",
    failed: "Proof generation stopped before it finished. Nothing was submitted.",
    empty: "Every attestation starts from a screened decision that parsed as an on-chain action."
  };
  function renderLife(key) {
    var status = key === "all" ? "consumed" : key === "empty" ? "decision" : key;
    BS.diagrams.render("lifecycle", refs.fig, { status: status, caption: false });
    refs.note.textContent = LIFE_NOTE[key] || "";
    if (!reduced()) M.restart(refs.note, "fade-in");
  }

  /* ══ ?state=empty ═════════════════════════════════════════════════════════ */
  if (EMPTY || !D.attestations.length) {
    refs.filters.hidden = true;
    refs.box.hidden = true;
    refs.empty.hidden = false;
    refs.empty.innerHTML = ui.empty({
      icon: "stamp",
      title: "No attestations yet.",
      body: "An attestation proves that one screened call passed a committed policy, without showing the call. It is requested from a decision.",
      actions: '<a class="btn secondary d05-empty__go" href="' + D01_HREF + '">Request one from a decision that has action fields<span class="nudge">' + ico("arrow-right") + "</span></a>"
    });
    renderLife("empty");
    return;
  }

  /* ══ 5 · rows ═════════════════════════════════════════════════════════════ */
  function decCell(a) {
    return '<span class="d05-dec">' + H(a.decisionId, "Decision id") +
      '<a class="d05-go" href="' + d02(a.decisionId) + '" data-tip="Open decision" aria-label="Open decision ' + esc(a.decisionId) + '">' + ico("arrow-up-right") + "</a></span>";
  }
  function txCell(a) { return a.txSig ? H(a.txSig, "Transaction signature (" + (a.cluster || "devnet") + ")") : nil(); }
  function teeCell(a) { return a.tee ? '<span class="chip outline d05-tee" data-tip="L3 ran in a ' + esc(a.tee.mode) + ' enclave; the quote is attested">' + ico("cpu") + esc(a.tee.mode) + "</span>" : nil(); }
  /* the row's spoken label carries the TEE sentence too (the chip itself is not a stop) */
  function rowLabel(a) {
    return "Attestation " + a.id + ", " + a.status + (a.tee ? ", L3 ran in a " + a.tee.mode + " enclave, quote attested" : "") + ". Open details";
  }
  function rowHtml(a) {
    var expired = a.status === "expired";
    return '<tr class="table__row is-clickable d05-row" data-id="' + esc(a.id) + '" tabindex="0" aria-label="' + esc(rowLabel(a)) + '">' +
      "<td>" + H(a.id, "Attestation id") + "</td>" +
      "<td>" + decCell(a) + "</td>" +
      '<td class="d05-st">' + ui.status(a.status, { progress: a.progressPct }) + "</td>" +
      '<td class="is-time"><span data-tip="' + esc(fmt.dateTime(a.createdAt)) + '">' + esc(fmt.timeAgo(a.createdAt)) + "</span></td>" +
      '<td class="num d05-slot' + (expired ? " is-past" : "") + '"><span data-tip="' + esc(expiryNote(a)) + '">' + esc(fmt.slot(a.expirySlot)) + "</span></td>" +
      '<td class="d05-tx">' + txCell(a) + "</td>" +
      "<td>" + teeCell(a) + "</td>" +
      "</tr>";
  }
  function rowOf(id) { return refs.rows.querySelector('tr[data-id="' + CSS.escape(id) + '"]'); }

  /* the filter cascade: card-in, 20 ms per row (page.css sets --stagger-card) */
  function cascade(nodes) {
    if (reduced() || !nodes.length) return;
    nodes.forEach(function (n, i) { n.style.setProperty("--i", String(i)); n.classList.remove("card-in"); });
    void refs.rows.offsetWidth;
    nodes.forEach(function (n) { n.classList.add("card-in"); });
  }
  refs.rows.addEventListener("animationend", function (e) {
    if (e.animationName === "card-in") { e.target.classList.remove("card-in"); e.target.style.removeProperty("--i"); }
  });

  /* ══ 6 · the filter ═══════════════════════════════════════════════════════ */
  var filter = "all", openId = null;
  var segOdo = {};
  $$("[data-count]", refs.filters).forEach(function (el) { segOdo[el.getAttribute("data-count")] = M.odometer(el, 0, { mode: "tick", format: fmt.int }); });
  var shownOdo = M.odometer($("[data-shown]", refs.shown), 0, { mode: "tick", format: fmt.int });
  var totalOdo = M.odometer($("[data-total]", refs.shown), 0, { mode: "tick", format: fmt.int });

  function matches(a) { return filter === "all" || a.status === filter; }
  function setCounts() {
    var c = counts();
    Object.keys(segOdo).forEach(function (k) { segOdo[k].set(c[k] || 0); });
    totalOdo.set(c.all);
    shownOdo.set(refs.rows.querySelectorAll("tr.d05-row").length);
  }
  function renderRows(animate) {
    var items = list().filter(matches);
    refs.rows.innerHTML = items.map(rowHtml).join("");
    if (openId) { var r = rowOf(openId); if (r) r.classList.add("is-open"); }
    var none = !items.length;
    refs.box.classList.toggle("is-none", none);
    refs.none.hidden = !none;
    if (none) {
      refs.none.innerHTML = ui.empty({
        bare: true, icon: "filter",
        title: "No attestations are " + filter + ".",
        body: LIFE_NOTE[filter],
        actions: '<button type="button" class="btn secondary sm" data-show-all>Show all</button>'
      });
    }
    setCounts();
    if (animate) cascade($$("tr.d05-row", refs.rows));
  }
  var seg = ui.seg(refs.seg, {
    value: "all",
    onChange: function (v) { filter = v; dropTip(); renderRows(true); renderLife(v); }
  });
  refs.none.addEventListener("click", function (e) { if (e.target.closest("[data-show-all]")) seg.set("all"); });

  /* row click / Enter / Space opens the sheet; the hash buttons and the decision link keep their own job */
  refs.rows.addEventListener("click", function (e) {
    if (e.target.closest(".hash, a, button")) return;
    var tr = e.target.closest("tr.d05-row");
    if (tr) openDetail(tr.getAttribute("data-id"), tr);
  });
  refs.rows.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var tr = e.target;
    if (!tr.matches || !tr.matches("tr.d05-row")) return;
    e.preventDefault();
    openDetail(tr.getAttribute("data-id"), tr);
  });

  /* ══ 7 · live updates: one handler for every WS-style attestation event ══ */
  function apply(ev) {
    if (!ev || !ev.id) return;
    var a = find(ev.id);
    if (!a) return;
    var tr = rowOf(a.id);
    if (tr) {
      var chip = $(".d05-st .status", tr);
      var was = chip && chip.getAttribute("data-s");
      ui.setStatus(chip, a.status, { progress: a.progressPct });
      if (was !== a.status) {
        if (!reduced()) M.restart(chip, "fade-in");
        M.flash(tr);
        $(".d05-tx", tr).innerHTML = txCell(a);
        tr.setAttribute("aria-label", rowLabel(a));
      }
    } else if (matches(a)) {
      /* a row that now matches the filter slides in at its place */
      var tmp = document.createElement("tbody");
      tmp.innerHTML = rowHtml(a);
      var row = tmp.firstElementChild, items = list().filter(matches), idx = items.indexOf(a), before = null;
      for (var i = idx + 1; i < items.length && !before; i++) before = rowOf(items[i].id);
      refs.rows.insertBefore(row, before);
      refs.box.classList.remove("is-none"); refs.none.hidden = true;
      M.enterRow(row);
    }
    /* a row that stops matching stays until the filter changes: nothing jumps out from under the pointer */
    setCounts();
    if (openId === a.id) updateSheet(a, ev);
  }
  window.addEventListener("bs:attestation", function (e) { apply(e.detail); });

  /* the generating proof advances 62 → 100 %, then flips to generated */
  function runProver(a) {
    var i = 0;
    while (i < TICKS.length && TICKS[i] <= (a.progressPct || 0)) i++;
    function emit(detail) { window.dispatchEvent(new CustomEvent("bs:attestation", { detail: detail })); }
    function step() {
      if (a.status !== "generating") return;
      if (i >= TICKS.length) {
        var bytes = "0x";
        for (var k = 0; k < 8; k++) bytes += D.sha256("groth16:" + a.publicInputs.join("") + ":" + k);
        a.proof.bytes = bytes;
        a.status = "generated";
        delete a.progressPct;
        emit({ id: a.id, status: a.status });
        return;
      }
      a.progressPct = TICKS[i];
      emit({ id: a.id, status: a.status, progressPct: a.progressPct });
      /* at 100 % the full bar holds for a beat before the chip flips */
      var wait = TICKS[i] === 100 ? 520 : (TICK_MS[i + 1] || 600);
      i++;
      setTimeout(step, M.scale(wait));
    }
    setTimeout(step, M.scale(TICK_MS[0]));
  }

  /* ══ 8 · the detail sheet ═════════════════════════════════════════════════ */
  var sheet = null;          /* { api, id, pctOdo } */
  function kvRow(k, v, idx) {
    return '<div class="kv__item"><span class="kv__k">' + (idx != null ? '<span class="d05-pi" aria-label="public input ' + idx + '">' + idx + "</span>" : "") + esc(k) + '</span><span class="kv__v">' + v + "</span></div>";
  }
  function boundBlock(a) {
    var d = decisionOf(a);
    return '<section class="sheet__block d05-s-bound">' +
      '<p class="sheet__h">Bound to</p>' +
      '<div class="d05-bound">' +
        '<p class="d05-bound__call">' + (d ? esc(d.server) + '<span class="d05-act__sep">·</span>' + esc(d.tool) : "Decision") +
          "</p>" +
        (d && d.action ? '<p class="d05-act">' + actionLine(d.action) + "</p>" : "") +
        '<p class="d05-bound__sub"><span data-tip="' + esc(fmt.dateTime(a.createdAt)) + '">Requested ' + esc(fmt.timeAgo(a.createdAt)) + '</span><span class="d05-act__sep">·</span>decision ' + H(a.decisionId, "Decision id") + "</p>" +
      "</div></section>";
  }
  function inputsBlock(a) {
    return '<section class="sheet__block">' +
      '<p class="sheet__h">Public inputs decoded <span class="d05-h-sub">five inputs the verifier checks · the nonce is not one</span></p>' +
      '<div class="kv kv--rows d05-kv">' +
        kvRow("Action hash", H(a.actionHash, "Action hash", true), 0) +
        kvRow("Policy root", H(a.policyRoot, "Policy root", true), 1) +
        kvRow("Detector version", '<span class="d05-det">' + esc(a.detectorVersion) + "</span>" + H(a.publicInputs[2], "Detector version hash", true), 2) +
        kvRow("Expiry slot", '<span class="d05-slotv num" data-tip="' + esc(expiryNote(a)) + '">' + esc(fmt.slot(a.expirySlot)) + "</span>", 3) +
        kvRow("Nullifier", H(a.nullifier, "Nullifier", true), 4) +
        kvRow("Nonce", H(a.nonce, "Nonce", true)) +
      "</div></section>";
  }
  function proofState(a) {
    if (a.status === "generating") {
      return '<div class="d05-proving"><p class="d05-proving__t">proving… <span class="num" data-pct>' + Math.round(a.progressPct || 0) + "</span>%</p>" +
        '<div class="progress d05-proving__bar"><i style="--p:' + ((a.progressPct || 0) / 100) + '"></i></div></div>';
    }
    if (a.status === "rejected" || a.status === "failed") {
      return '<p class="d05-reason">' + ico("circle-alert") + "<span>" + esc(a.reason || (a.status === "failed" ? "Proof generation failed." : "The verifier rejected the transaction.")) + "</span></p>";
    }
    var line = {
      generated: "Proof ready on this machine. Not on chain yet.",
      submitted: "Proof submitted. The verifier program checks it in one instruction.",
      consumed: "Proof verified on chain and the nullifier spent.",
      expired: "Proof intact, but its expiry slot has passed."
    }[a.status] || "";
    return '<p class="d05-proofline">' + ico(a.status === "consumed" ? "circle-check" : "file-check") + "<span>" + esc(line) + "</span></p>";
  }
  function proofBlock(a) {
    var n = proofBytes(a);
    return '<section class="sheet__block">' +
      '<p class="sheet__h">Proof</p>' +
      '<div class="kv kv--rows d05-kv">' +
        kvRow("Protocol · curve", '<span class="d05-mono">groth16</span><span class="d05-act__sep">·</span><span class="d05-mono">bn254</span>') +
        kvRow("Bytes", '<span class="num" data-bytes>' + (n ? esc(fmt.bytes(n)) : "—") + "</span>") +
      "</div>" +
      '<div class="d05-proofstate" data-proofstate>' + proofState(a) + "</div>" +
      "</section>";
  }
  function teeBlock(a) {
    if (!a.tee) return "";
    return '<section class="sheet__block">' +
      '<p class="sheet__h">TEE</p>' +
      '<div class="kv kv--rows d05-kv">' +
        kvRow("Mode", '<span class="chip outline d05-tee">' + ico("cpu") + esc(a.tee.mode) + "</span>") +
        (a.tee.quoteHash ? kvRow("Quote hash", H(a.tee.quoteHash, "TEE quote hash", true)) : "") +
      "</div>" +
      '<p class="d05-note">The model layers ran inside the enclave. Its quote is attested, not proven.</p>' +
      "</section>";
  }
  function footInner(a) {
    var gen = a.status === "generated";
    var why = {
      generating: "Submit opens when the proof is generated.",
      submitted: "Submitted to " + (a.cluster || "devnet") + ". It is spent the first time a program verifies it.",
      consumed: "Consumed on " + (a.cluster || "devnet") + ". Single-use: it cannot be submitted again.",
      expired: "The expiry slot has passed. Request a new attestation from the decision.",
      rejected: "The verifier refused it. Request a new attestation from the decision.",
      failed: "There is no proof to submit. Request a new attestation from the decision."
    }[a.status] || "";
    var tx = a.txSig ?
      '<div class="d05-txline"><span class="d05-txline__k">Tx</span>' + H(a.txSig, "Transaction signature (" + (a.cluster || "devnet") + ")", true) +
        '<span class="chip outline d05-cluster">' + esc(a.cluster || "devnet") + "</span>" +
        '<a class="btn link sm d05-explorer" href="#" data-explorer>View on explorer<span aria-hidden="true">&nbsp;↗</span></a></div>' : "";
    var canExport = hasProof(a);
    return tx +
      '<div class="d05-actions">' +
        '<span class="select-wrap d05-cluster-sel"><select class="select" data-cluster aria-label="Cluster"' + (gen ? "" : " disabled") + ">" +
          '<option value="devnet"' + (a.cluster === "mainnet-beta" ? "" : " selected") + ">devnet</option>" +
          '<option value="mainnet-beta"' + (a.cluster === "mainnet-beta" ? " selected" : "") + ">mainnet-beta</option></select>" + ico("chevron-down") + "</span>" +
        '<button type="button" class="glass-btn primary sm d05-submit" data-submit' + (gen ? "" : " disabled") + ">" + ico("upload") + "<span data-label>Submit</span></button>" +
        '<span class="d05-actions__spacer"></span>' +
        (canExport ? "" : '<span class="d05-export-wrap" data-tip="No proof to export yet">') +
        '<button type="button" class="btn secondary d05-export" data-export' + (canExport ? "" : " disabled") + ">" + ico("download") + "Export attestation.json</button>" +
        (canExport ? "" : "</span>") +
      "</div>" +
      '<div class="d05-foot__row"><p class="d05-why">' + esc(why || "Submit sends it to the verifier program on the selected cluster, once.") + "</p>" +
        '<a class="btn link sm d05-open" href="' + d02(a.decisionId) + '">Open decision<span class="nudge">' + ico("arrow-right") + "</span></a></div>";
  }
  function footBlock(a) { return '<section class="sheet__block d05-foot" data-foot>' + footInner(a) + "</section>"; }

  function leadExtras(a) {
    return H(a.id, "Attestation id", true) + ui.status(a.status, { progress: a.progressPct });
  }
  function openDetail(id, trigger) {
    var a = find(id);
    if (!a) {
      BS.toast({ title: "Attestation not found", body: "No attestation with id " + id + " on this proxy.", tone: "warn", id: "d05-missing" });
      return;
    }
    var html = boundBlock(a) + inputsBlock(a) + proofBlock(a) + teeBlock(a) + footBlock(a);
    var api = BS.openSheet(html, {
      eyebrow: "Attestation", kind: "attestation", trigger: trigger,
      param: { key: "id", value: a.id },
      onClose: function () {
        var r = openId && rowOf(openId);
        if (r) r.classList.remove("is-open");
        openId = null; sheet = null;
        dropTip();
      }
    });
    var prev = openId && rowOf(openId);
    if (prev) prev.classList.remove("is-open");
    openId = a.id;
    var row = rowOf(a.id);
    if (row) row.classList.add("is-open");
    var lead = $(".sheet__lead", api.el);
    lead.insertAdjacentHTML("beforeend", '<span class="d05-lead">' + leadExtras(a) + "</span>");
    sheet = { api: api, id: a.id, pctOdo: null };
    wireSheet(a);
  }
  function wireSheet(a) {
    var body = sheet.api.body;
    var pct = $("[data-pct]", body);
    sheet.pctOdo = pct ? M.odometer(pct, Math.round(a.progressPct || 0), { mode: "tick", format: function (v) { return String(v); } }) : null;
  }
  function updateSheet(a, ev) {
    if (!sheet || sheet.id !== a.id) return;
    var root = sheet.api.el, body = sheet.api.body;
    var chip = $(".d05-lead .status", root);
    var was = chip && chip.getAttribute("data-s");
    ui.setStatus(chip, a.status, { progress: a.progressPct });
    if (was === a.status && a.status === "generating") {
      if (sheet.pctOdo) sheet.pctOdo.set(Math.round(a.progressPct || 0));
      ui.progress($(".d05-proving__bar", body), (a.progressPct || 0) / 100);
      return;
    }
    if (was !== a.status) {
      if (!reduced()) M.restart(chip, "fade-in");
      var ps = $("[data-proofstate]", body);
      ps.innerHTML = proofState(a);
      var n = proofBytes(a);
      $("[data-bytes]", body).textContent = n ? fmt.bytes(n) : "—";
      var foot = $("[data-foot]", body);
      foot.innerHTML = footInner(a);
      if (!reduced()) { M.restart(ps, "fade-in"); M.restart(foot, "d05-swap"); }
      wireSheet(a);
    }
  }

  /* sheet actions (delegated: the sheet re-renders its footer in place) */
  document.addEventListener("click", function (e) {
    if (!sheet) return;
    var t = e.target;
    var sub = t.closest && t.closest("[data-submit]");
    var exp = t.closest && t.closest("[data-export]");
    var ex = t.closest && t.closest("[data-explorer]");
    if (sub && !sub.disabled) doSubmit(sub);
    else if (exp && !exp.disabled) doExport();
    else if (ex) {
      e.preventDefault();
      var a = find(sheet.id);
      BS.toast({ title: "Explorer link", body: "In the product this opens the transaction on the " + ((a && a.cluster) || "devnet") + " explorer.", tone: "info", id: "d05-explorer" });
    }
  });
  function doSubmit(btn) {
    var a = find(sheet.id);
    if (!a) return;
    var foot = btn.closest("[data-foot]");
    var sel = $("[data-cluster]", foot);
    var cluster = sel ? sel.value : "devnet";
    btn.setAttribute("aria-busy", "true");
    $("[data-label]", btn).textContent = "Submitting…";
    if (sel) sel.disabled = true;
    D.submit(a.id, cluster).then(function (r) {
      /* the fixtures emitted "attestation" first: the chip, the row and the footer already show submitted */
      BS.toast({ title: "Submitted · " + fmt.shortB58(r.txSig), body: "On " + cluster + ". Single-use: the first program to verify it spends the nullifier.", tone: "ok", id: "d05-submit" });
    }).catch(function (err) {
      if (btn.isConnected) { btn.removeAttribute("aria-busy"); $("[data-label]", btn).textContent = "Submit"; if (sel) sel.disabled = false; }
      BS.toast({ title: "Submit failed", body: (err && (err.code ? err.code + " · " : "") + (err.message || "")) || "The proxy did not answer.", tone: "danger", id: "d05-submit" });
    });
  }
  function doExport() {
    var r = D.exportAttestation(sheet.id);
    if (r) BS.toast({ title: "Exported " + r.filename, body: fmt.bytes(r.bytes) + " · public inputs and the proof, nothing from the payload.", tone: "ok", id: "d05-export" });
    else BS.toast({ title: "Export failed", body: "No attestation with that id.", tone: "danger", id: "d05-export" });
  }

  /* ══ 9 · first paint ══════════════════════════════════════════════════════ */
  renderRows(false);
  renderLife("all");

  var q = new URLSearchParams(location.search).get("id");
  M.whenUncovered().then(function () {
    if (q && BS.state.is("not-found")) BS.toast({ title: "Attestation not found", body: "No attestation with id " + q + " on this proxy.", tone: "warn", id: "d05-missing" });
    else if (q) openDetail(q, rowOf(q) || null);
    D.attestations.filter(function (a) { return a.status === "generating"; }).forEach(runProver);
  });
})();
