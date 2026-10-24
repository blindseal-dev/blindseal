/* ============================================================================
   S03 · Verify — page.js
   ----------------------------------------------------------------------------
   The client-side checker. One run (token-guarded, so Clear or a new load
   cancels the old one) walks the steps in order:
     1  Schema valid           BS.data.schemaCheck(text)       (running ≥ 240 ms)
     2  Proof verifies         BS.data.verifyAttestation(text) (≈ 600 ms, sweep)
     3  Public inputs decoded  the .kv grid, every hex through BS.ui.hash
     4  Nullifier status       NOT automatic: "Check on devnet" in the row →
                               BS.data.nullifierStatus (≈ 900 ms; held ≥
                               M.scale(900) so slow-mo shows it) →
                               unused / consumed in tx … / expired, or under
                               ?state=offline "RPC unavailable · try again"
     5  "What this does not reveal" — a panel, shown once step 1 passes,
        kept through every later failure.
   A failed step stops the ones after it (they go to "skip"), never panel 5.
   Load sample / Load tampered / a dropped file fill the textarea and run; the
   Verify button runs pasted text (Ctrl/⌘ + Enter in the textarea too).
   Nothing touches storage; the attestation lives in this tab's memory only.
   ========================================================================== */
(function () {
  "use strict";
  var BS = window.BS;
  var M = BS.motion, D = BS.data, ui = BS.ui, fmt = BS.fmt || ui.fmt;

  BS.mountSite({ active: "verify" });

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return [].slice.call((r || document).querySelectorAll(s)); }
  function esc(s) { return ui.esc(s); }
  function ico(n) { return BS.icon ? BS.icon(n) : ""; }
  function hash(v, label) { return ui.hash(v, { label: label, lg: true }); }
  function reduced() { return M.reduced(); }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  /* ── masthead field + the entrance ───────────────────────────────────── */
  var mast = $(".vf-mast"), grid = $(".vf");
  if (BS.mountSpace) BS.mountSpace($(".vf-mast__space"), { intensity: "faint", fade: false });
  $$(".vf-enter").forEach(function (el, i) { el.style.setProperty("--e", String(Math.min(i, 6))); });
  if (!reduced()) {
    mast.classList.add("is-rising"); grid.classList.add("is-rising");
    // drop the class once the entrance has played, so no finished animation lingers on the glass button
    setTimeout(function () { grid.classList.remove("is-rising"); }, M.scale(260 + 6 * 40 + 400 + 80));
  }

  /* ── refs ────────────────────────────────────────────────────────────── */
  var drop = $("#vf-drop"), file = $("#vf-file"), text = $("#vf-text"), help = $("#vf-help");
  var btnSample = $("#vf-load-sample"), btnTampered = $("#vf-load-tampered"), btnVerify = $("#vf-verify"), btnClear = $("#vf-clear");
  var out = $(".vf-out"), banner = $("#vf-banner"), source = $("#vf-source"), list = $("#vf-checks");
  var hiddenPanel = $("#vf-hidden"), hiddenRows = $("#vf-hidden-rows");

  /* ── the steps ───────────────────────────────────────────────────────── */
  var STEPS = [
    { n: 1, title: "Schema valid",                  idle: "Version 1, groth16 on bn254, every required field present." },
    { n: 2, title: "Proof verifies",                idle: "In this tab, via blindseal-verifier-wasm (mock until it ships)." },
    { n: 3, title: "Public inputs decoded",         idle: "Action hash, policy root, detector version, expiry slot, nullifier." },
    { n: 4, title: "Nullifier status on chain",     idle: "Optional · reads devnet · the only step that touches the network." }
  ];
  var HIDDEN = [
    ["Prompt", "What the agent was asked."],
    ["Tool arguments", "What the call actually carried."],
    ["Policy contents", "Rules and thresholds stay local."],
    ["Agent identity", "Which agent was screened."]
  ];
  hiddenRows.innerHTML = HIDDEN.map(function (r, i) {
    return '<li class="vf-hidden__row" style="--i:' + i + '"><span class="vf-hidden__name">' + esc(r[0]) + '</span>' +
      '<span class="vf-hidden__why">' + esc(r[1]) + '</span><span class="chip neutral">hidden</span></li>';
  }).join("");

  function li(i) { return list.children[i]; }
  function paintIdle() {
    list.innerHTML = STEPS.map(function (s) { return ui.checkItem({ n: s.n, title: s.title, detail: s.idle, state: "pending" }); }).join("");
    // step 3 gets its kv slot; step 4 gets its on-demand button row
    var main3 = li(2).querySelector(".check__main");
    var kv = document.createElement("div"); kv.className = "kv vf-kv"; kv.hidden = true; main3.appendChild(kv);
    var main4 = li(3).querySelector(".check__main");
    var row = document.createElement("div"); row.className = "vf-n4"; row.hidden = true;
    row.innerHTML = '<button type="button" class="btn secondary sm" data-n4>' + ico("radio") + '<span>Check on devnet</span></button>';
    main4.appendChild(row);
    row.querySelector("[data-n4]").addEventListener("click", checkNullifier);
  }
  paintIdle();

  /* a state change: the kit's ui.check + the detail / reason line rising in (rise-8, 220 out-expo) */
  function setCheck(i, state, o) {
    o = o || {};
    var el = li(i);
    ui.check(el, state, { reason: o.reason != null ? o.reason : "", end: o.end != null ? o.end : "", detail: o.detail, html: o.html });
    if (state === "skip") { el.querySelector(".check__end").textContent = "Skipped"; }
    if (state === "pass" || state === "fail" || state === "skip") {
      [".check__detail", ".check__reason"].forEach(function (s) { var x = el.querySelector(s); if (x) M.restart(x, "is-new"); });
    }
  }

  /* ── banner ──────────────────────────────────────────────────────────── */
  function setBanner(tone, title, sub, end) {
    banner.setAttribute("data-tone", tone);
    $(".vf-banner__mark", banner).innerHTML = tone === "pass" ? ico("check") : tone === "fail" ? ico("circle-alert") : "";
    $(".vf-banner__title", banner).textContent = title;
    $(".vf-banner__sub", banner).textContent = sub;
    $(".vf-banner__end", banner).textContent = end || "";
    banner.classList.remove("is-drop", "is-fade");
    if (tone === "idle") return;
    M.restart(banner, tone === "running" ? "is-fade" : "is-drop");
  }
  function idleBanner() {
    setBanner("idle", "Waiting for an attestation", "");
    // the demo path above the fold: the same handlers as the input panel's buttons
    $(".vf-banner__sub", banner).innerHTML =
      '<button type="button" class="btn link vf-banner__link" data-demo="sample">Load a sample</button>' +
      '<span class="vf-banner__dot" aria-hidden="true">·</span>' +
      '<button type="button" class="btn link vf-banner__link" data-demo="tampered">Load the tampered one</button>';
  }
  banner.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-demo]");
    if (!b) return;
    if (b.getAttribute("data-demo") === "sample") loadSample(); else loadTampered();
  });

  function setSource(kind, label) {
    if (!kind) { source.hidden = true; source.textContent = ""; source.removeAttribute("data-tip"); return; }
    source.hidden = false;
    source.innerHTML = ico(kind === "file" || kind === "pasted" ? "file-json" : "file-check") + '<span class="vf-source__name">' + esc(label) + "</span>";
    source.setAttribute("data-tip", label);
  }

  /* ── textarea → the Verify gate ──────────────────────────────────────── */
  function parses(s) { try { var v = JSON.parse(s); return v && typeof v === "object"; } catch (e) { return false; } }
  var running = false, hasResult = false, runTok = 0, decoded = null;
  function syncGate() {
    var v = text.value.trim();
    var ok = v.length > 0 && parses(v);
    btnVerify.disabled = !ok || running;
    help.classList.toggle("is-warn", v.length > 0 && !ok);
    help.textContent = !v.length ? "Paste the JSON, or load a sample below." :
      ok ? (fmt.bytes ? fmt.bytes(new Blob([v]).size) : v.length + " chars") + " of JSON, held in this tab only." :
      "Not valid JSON yet. Verify unlocks when it parses.";
  }
  text.addEventListener("input", function () {
    if (hasResult || running) resetResults(false);
    setSource(text.value.trim() ? "pasted" : null, "pasted");
    syncGate();
  });
  text.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !btnVerify.disabled) { e.preventDefault(); verifyCurrent(); }
  });

  /* ── reset: fade-out 140 in-quick, then the idle checklist (instant under reduce) ── */
  function resetResults(animate) {
    var tok = ++runTok;
    running = false; hasResult = false; decoded = null;
    btnVerify.removeAttribute("aria-busy");
    var finish = function () {
      if (tok !== runTok) return;
      out.classList.remove("is-clearing");
      paintIdle(); idleBanner(); hiddenPanel.hidden = true; hiddenPanel.classList.remove("is-in");
      syncGate();
    };
    if (animate && !reduced()) { out.classList.add("is-clearing"); setTimeout(finish, M.scale(140)); }
    else finish();
    return tok;
  }

  /* ── the run ─────────────────────────────────────────────────────────── */
  function stale(tok) { return tok !== runTok; }
  /* a step's running hold is a timer, not an animation: under reduce it keeps its
     unscaled length (M.wait would make it 0 ms beside step 2's ~600 ms verifier) */
  function hold(ms) { return reduced() ? new Promise(function (r) { setTimeout(r, ms); }) : M.wait(ms); }
  function skipFrom(from, why) { for (var i = from; i < 4; i++) setCheck(i, "skip", { detail: why }); }

  function run(json, kind, label) {
    var tok = resetResults(false);
    setSource(kind, label);
    running = true; syncGate(); btnVerify.setAttribute("aria-busy", "true");
    setBanner("running", "Verifying in this tab", "Step 1 of 3 · Schema valid", "");

    // 1 · schema
    setCheck(0, "running");
    hold(240).then(function () {
      if (stale(tok)) return;
      var sc = D.schemaCheck(json);
      if (!sc.ok) {
        var more = sc.errors.length > 1 ? " (+" + (sc.errors.length - 1) + " more)" : "";
        setCheck(0, "fail", { detail: "The file does not match the Attestation schema.", reason: sc.errors[0] + more });
        skipFrom(1, "Skipped: the schema check failed.");
        return done(tok, false, 1, "Schema valid");
      }
      setCheck(0, "pass", { detail: "version 1 · groth16 · bn254 · 5 public inputs · required fields present" });
      showHidden();

      // 2 · proof (the mock verifier holds ≈ 600 ms, scaled in slow-mo)
      setCheck(1, "running");
      setBanner("running", "Verifying in this tab", "Step 2 of 3 · Proof verifies", "");
      var t0 = now();
      return D.verifyAttestation(json).then(function (res) {
        if (stale(tok)) return;
        var ms = fmt.ms(Math.round(now() - t0));
        decoded = res.decoded;
        if (!res.ok) {
          setCheck(1, "fail", { detail: "The proof does not verify against its public inputs.", reason: res.reason, end: ms });
          skipFrom(2, "Skipped: the proof did not verify.");
          return done(tok, false, 2, "Proof verifies");
        }
        setCheck(1, "pass", { detail: "The groth16 proof verifies against its five public inputs.", end: ms });

        // 3 · decode
        setCheck(2, "running");
        setBanner("running", "Verifying in this tab", "Step 3 of 3 · Public inputs decoded", "");
        return hold(220).then(function () {
          if (stale(tok)) return;
          setCheck(2, "pass", { detail: "Five public inputs, exactly as an on-chain program reads them." });
          renderKv(res.decoded, json);
          // 4 · on demand
          var row = $(".vf-n4", li(3)); row.hidden = false;
          setCheck(3, "pending", { detail: STEPS[3].idle });
          done(tok, true);
        });
      });
    });
  }

  function done(tok, ok, failedAt, failedName) {
    if (stale(tok)) return;
    running = false; hasResult = true;
    btnVerify.removeAttribute("aria-busy"); syncGate();
    if (ok) setBanner("pass", "Valid attestation", "Schema, proof and public inputs check out. The nullifier check is optional.", "3 of 3");
    else setBanner("fail", "Does not verify", "Failed at step " + failedAt + ", " + failedName + "." + (failedAt < 3 ? " Later steps were skipped." : ""), "Step " + failedAt);
  }

  /* panel 5: once step 1 passes; never removed by a later failure */
  function showHidden() {
    if (!hiddenPanel.hidden) return;
    hiddenPanel.hidden = false;
    if (!reduced()) M.restart(hiddenPanel, "is-in");
  }

  /* step 3's grid: every hex through BS.ui.hash (.lg), the slot as a mono number */
  function renderKv(dec, json) {
    var kv = $(".vf-kv", li(2));
    var att = null; try { att = JSON.parse(json); } catch (e) { /* schema passed, so it parses */ }
    var dvh = dec.detectorVersionHash;
    var dvName = dec.detectorVersion && dec.detectorVersion !== dvh ? dec.detectorVersion : null;
    var proofBytes = att && att.proof && att.proof.bytes ? (att.proof.bytes.length - 2) / 2 : 0;
    var items = [
      ["Action hash", hash(dec.actionHash, "Action hash")],
      ["Policy root", hash(dec.policyRoot, "Policy root")],
      ["Nullifier", hash(dec.nullifier, "Nullifier")],
      ["Detector version", (dvName ? '<span class="vf-mono">' + esc(dvName) + "</span>" : "") + hash(dvh, "Detector version hash")],
      ["Expiry slot", '<span class="vf-mono num">' + esc(fmt.slot(dec.expirySlot)) + "</span>"],
      ["Proof", '<span class="vf-mono">groth16 · bn254 · ' + esc(fmt.bytes(proofBytes)) + "</span>"]
    ];
    kv.innerHTML = items.map(function (p, i) {
      return '<div class="kv__item" style="--i:' + i + '"><span class="kv__k">' + esc(p[0]) + '</span><span class="kv__v">' + p[1] + "</span></div>";
    }).join("") +
      '<div class="vf-kv__foot"><p class="help">Download them as text; the attestation itself stays here.</p>' +
      '<button type="button" class="btn ghost sm" data-dl>' + ico("download") + "<span>Public inputs .txt</span></button></div>";
    kv.hidden = false;
    kv.classList.remove("is-in");
    if (!reduced()) M.restart(kv, "is-in");
    kv.querySelector("[data-dl]").addEventListener("click", function () { downloadInputs(dec); });
  }

  function downloadInputs(dec) {
    var lines = [
      "Blindseal attestation: decoded public inputs",
      "actionHash       " + dec.actionHash,
      "policyRoot       " + dec.policyRoot,
      "detectorVersion  " + (dec.detectorVersion && dec.detectorVersion !== dec.detectorVersionHash ? dec.detectorVersion + "  " : "") + dec.detectorVersionHash,
      "expirySlot       " + dec.expirySlot,
      "nullifier        " + dec.nullifier,
      ""
    ].join("\n");
    try {
      var url = URL.createObjectURL(new Blob([lines], { type: "text/plain" }));
      var a = document.createElement("a"); a.href = url; a.download = "public-inputs.txt"; a.style.display = "none";
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
    } catch (e) { /* no-op */ }
    BS.toast({ title: "Saved public-inputs.txt", body: "Five public inputs as text. The attestation never left this tab.", tone: "ok", id: "vf-dl" });
  }

  /* ── step 4: the one network step, on its button ─────────────────────── */
  function checkNullifier() {
    if (!decoded || !decoded.nullifier) return;
    var tok = runTok;
    var row = $(".vf-n4", li(3)), b = row.querySelector("[data-n4]");
    b.disabled = true; b.setAttribute("aria-busy", "true");
    setCheck(3, "running", { detail: "Looking up the nullifier PDA on devnet…" });
    var t0 = now();
    Promise.all([
      D.nullifierStatus(decoded.nullifier).then(function (r) { return { ok: true, r: r }; }, function (e) { return { ok: false, e: e }; }),
      M.wait(900)
    ]).then(function (res) {
      if (stale(tok)) return;
      var r = res[0];
      var ms = fmt.ms(Math.round(now() - t0));
      b.disabled = false; b.removeAttribute("aria-busy");
      if (!r.ok) {
        setCheck(3, "fail", { detail: "The devnet RPC did not answer. Steps 1–3 stand without it.", reason: "RPC unavailable · try again" });
        b.querySelector("span").textContent = "Try again";
        return;
      }
      var s = r.r.status, html;
      if (s === "consumed") html = '<span class="vf-res">' + ui.status("consumed") + "<span>in tx</span>" + ui.hash(r.r.txSig, { label: "Transaction", lg: true }) + "</span>";
      else if (s === "expired") html = '<span class="vf-res">' + ui.status("expired") + "<span>The expiry slot passed before it was used.</span></span>";
      else html = '<span class="vf-res"><span class="chip outline">unused</span><span>No transaction has consumed this nullifier yet.</span></span>';
      setCheck(3, "pass", { detail: html, html: true, end: "devnet · " + ms });
      b.querySelector("span").textContent = "Check again";
    });
  }

  /* ── inputs ──────────────────────────────────────────────────────────── */
  function load(att, kind, label) {
    text.value = JSON.stringify(att, null, 2);
    text.scrollTop = 0; text.scrollLeft = 0;
    syncGate();
    run(text.value, kind, label);
  }
  function loadSample() { load(D.attestationSample, "sample", "attestation-sample.json"); }
  function loadTampered() { load(D.attestationTampered, "tampered", "attestation-tampered.json"); }
  btnSample.addEventListener("click", loadSample);
  btnTampered.addEventListener("click", loadTampered);
  function verifyCurrent() {
    var v = text.value.trim(); if (!v) return;
    var label = source.hidden ? "pasted" : (source.textContent || "pasted");
    var kind = /attestation-sample/.test(label) ? "sample" : /attestation-tampered/.test(label) ? "tampered" : label === "pasted" ? "pasted" : "file";
    run(v, kind, label);
  }
  btnVerify.addEventListener("click", verifyCurrent);
  btnClear.addEventListener("click", function () {
    text.value = ""; file.value = "";
    setSource(null);
    resetResults(true);
    text.focus();
  });

  /* drop zone: click = the file picker; drag = accent hairline (150 ms) */
  drop.addEventListener("click", function () { file.click(); });
  file.addEventListener("change", function () { if (file.files && file.files[0]) readFile(file.files[0]); });
  var depth = 0;
  drop.addEventListener("dragenter", function (e) { e.preventDefault(); depth++; drop.classList.add("is-over"); });
  drop.addEventListener("dragover", function (e) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; });
  drop.addEventListener("dragleave", function () { depth = Math.max(0, depth - 1); if (!depth) drop.classList.remove("is-over"); });
  drop.addEventListener("drop", function (e) {
    e.preventDefault(); depth = 0; drop.classList.remove("is-over");
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) readFile(f);
  });
  // a file dropped anywhere else must not navigate the tab away
  ["dragover", "drop"].forEach(function (t) { window.addEventListener(t, function (e) { if (!drop.contains(e.target)) e.preventDefault(); }); });

  function readFile(f) {
    if (f.size > 256 * 1024) {
      BS.toast({ title: "That file is too large", body: f.name + " is " + fmt.bytes(f.size) + ". An attestation is about 2 KB.", tone: "warn", id: "vf-file" });
      return;
    }
    var r = new FileReader();
    r.onload = function () {
      text.value = String(r.result || "");
      text.scrollTop = 0; syncGate();
      run(text.value, "file", f.name);
    };
    r.readAsText(f);
  }

  idleBanner();
  syncGate();

  // QA hook (read-only): lets a test drive a file drop without a real drag
  window.S03 = { verifyText: function (s, name) { text.value = s; syncGate(); run(s, name ? "file" : "pasted", name || "pasted"); } };
})();
