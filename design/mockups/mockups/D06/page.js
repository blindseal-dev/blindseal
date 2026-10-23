/* ============================================================================
   D06 · Settings — page.js
   ----------------------------------------------------------------------------
   Renders #d06 from BS.data:
   head band   the proxy (127.0.0.1:<BS.PORTS.proxy>), version, uptime (tick
               odometer), detector; stats Upstreams n/6 · Judge · Prover.
   upstreams   status.upstreams → .table: name · transport chip · health (live
               dot / muted dot) · last seen · Restart (a 900 ms request, then a
               toast; a healthy row flashes and reads "just now"). Any
               unreachable upstream raises the banner "n upstream(s) unreachable".
   judge (L3)  .seg Local · TEE · Off on status.l3.mode. Switching is visual
               only: a toast "Mode changes apply on proxy restart" and a pending
               line with a "Keep <mode>" link. When status.l3.mode is "tee"
               (?state=tee) the quote sub-panel shows BS.data.teeQuote():
               mode nitro, quoteHash (.hash.lg), PCR0–2, Download quote
               (BS.data.exportTeeQuote) and Copy quote.
   prover      status.prover: dot + label, last proof (roll odometer), Test
               prover → 1.2 s running → the odometer rolls to the new value,
               toast "Proof generated in n ms". prover-down: unavailable, the
               button disabled, "Install the prover package →".
   token       masked bsd_••••••••••••<last 4>; Rotate token → .dialog →
               BS.data.rotateToken() (600 ms) → the token ONCE in a .code block
               with copy → after copy (900 ms later) or Done it collapses back to
               the masked line; toast "Token rotated". The full token lives in a
               closure variable only while it is on screen.
   about       .kv--rows: proxy, dashboard, uptime (odometer), detector, policy
               root, audit head, mock mode; Open docs ↗ · Changelog ↗.
   Invented values (board log): unreachable last-seen offsets browser 2 h 14 m
   / slack 38 m (healthy rows = the newest decision for that server) · the
   token's bsd_ prefix over the fixture's 48 hex · test-prover times from the
   rng stream "d06-test" in 3,900–4,600 ms · handshake 140–320 ms · collapse
   900 ms after a copy · restart 900 ms.
   QA hook: window.D06.state() (read-only).
   ========================================================================== */
(function () {
  "use strict";

  var BS = window.BS, D = BS.data, fmt = BS.fmt, ui = BS.ui, M = BS.motion;
  var esc = ui.esc;
  function ico(n, o) { return BS.icon(n, o); }
  var ROOT = document.getElementById("d06");
  var S = D.status;
  var MIN = D.MIN, HOUR = D.HOUR;
  var HOST = "127.0.0.1:" + BS.PORTS.proxy;
  var LINKS = { docs: "../S04/index.html", install: "../S04/index.html?page=install", tee: "../S04/index.html?page=tee-mode", changelog: "../S06/index.html" };
  var MODE_LABEL = { local: "Local", tee: "TEE", off: "Off" };
  var EXPLAIN = {
    local: "L3 runs on this machine, next to the proxy. Nothing is sent anywhere.",
    tee: "L3 runs inside a Nitro enclave. Its quote lets a counterparty check what ran.",
    off: "L3 does not run. Verdicts come from L0–L2 alone, and L3 reads as skipped."
  };
  var rngTest = D.rng.stream("d06-test"), rngHs = D.rng.stream("d06-handshake");

  function q(s, r) { return (r || ROOT).querySelector(s); }
  function qa(s, r) { return [].slice.call((r || ROOT).querySelectorAll(s)); }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  function hm(sec) { sec = Math.max(0, Math.floor(sec)); return Math.floor(sec / 3600) + "h " + Math.floor((sec % 3600) / 60) + "m"; }
  function between(r, lo, hi) { return Math.round(lo + r() * (hi - lo)); }
  function rnd(stream) { return typeof stream === "function" ? stream : (stream.float ? function () { return stream.float(0, 1); } : Math.random); }
  var randTest = rnd(rngTest), randHs = rnd(rngHs);

  BS.mountShell({ active: "settings", title: "Settings" });

  /* ── data ──────────────────────────────────────────────────────────────── */
  var DOWN_AGO = { browser: 2 * HOUR + 14 * MIN, slack: 38 * MIN };   /* invented: when an unreachable upstream last answered */
  function newestFor(name) {
    for (var i = 0; i < D.decisions.length; i++) if (D.decisions[i].server === name) return Date.parse(D.decisions[i].ts);
    return null;
  }
  var ups = S.upstreams.map(function (u) {
    return { name: u.name, transport: u.transport, healthy: u.healthy, seen: u.healthy ? newestFor(u.name) : D.now() - (DOWN_AGO[u.name] || 45 * MIN) };
  });
  function healthyCount() { return ups.filter(function (u) { return u.healthy; }).length; }
  var running = S.l3.mode;                 /* what the proxy runs now */
  var selected = running;                  /* what the segment shows */
  var proverUp = !!S.prover.available;
  var quote = running === "tee" ? D.teeQuote() : null;
  var teeHash = running === "tee" && D.tee && D.tee.quoteHash ? D.tee.quoteHash : (quote ? quote.quoteHash : null);
  var tokenIssued = D.now() - S.uptimeSec * 1000;   /* the proxy prints a token on start */
  var rotatedAt = null, shown = null, testing = false, rotating = false, lastTest = null;
  var dashRelease = (D.changelog || []).filter(function (c) { return c.component === "dashboard"; })[0];

  function masked() { return "bsd_" + "••••••••••••" + String(D.token).slice(-4); }
  function full(t) { return "bsd_" + t; }

  /* ── markup ────────────────────────────────────────────────────────────── */
  function band() {
    return '<section class="panel d06-band" data-rise aria-labelledby="d06-band-h">' +
      '<div class="d06-band__main">' +
        '<p class="eyebrow d06-band__eyebrow" id="d06-band-h"><i class="live-dot" aria-hidden="true"></i>Local proxy</p>' +
        '<p class="d06-band__addr">' + esc(HOST.split(":")[0]) + '<span>:' + esc(HOST.split(":")[1]) + "</span></p>" +
        '<p class="d06-band__meta"><span>v' + esc(S.version) + '</span><i aria-hidden="true">·</i><span>up <b class="d06-odo" data-uptime="band"></b></span><i aria-hidden="true">·</i><span>detector <b class="d06-mono">' + esc(S.detectorVersion) + "</b></span></p>" +
        '<p class="d06-band__note">See what the proxy is connected to and how the judge runs. Settings are read-mostly; the one write here, rotating the token, asks first.</p>' +
      "</div>" +
      '<dl class="d06-stats">' +
        '<div class="d06-stat"><dt>Upstreams</dt><dd><span class="d06-odo" data-stat="up"></span><i>/' + ups.length + "</i></dd><p>healthy</p></div>" +
        '<div class="d06-stat"><dt>Judge</dt><dd data-stat="judge">' + esc(MODE_LABEL[running]) + "</dd><p>L3 mode</p></div>" +
        '<div class="d06-stat"><dt>Prover</dt><dd data-stat="prover" class="' + (proverUp ? "" : "is-off") + '">' + (proverUp ? "Up" : "Down") + "</dd><p>" + (proverUp ? "groth16 · bn254" : "unavailable") + "</p></div>" +
      "</dl></section>";
  }

  function upstreamsPanel() {
    return '<section class="table-box d06-up" data-rise aria-labelledby="d06-up-h">' +
      '<header class="d06-bar"><h2 class="panel__title" id="d06-up-h">Upstream servers</h2>' +
        '<span class="d06-bar__sub">MCP servers the proxy screens calls to</span><span class="d06-spacer"></span>' +
        '<span class="filter-bar__count"><b class="d06-ink d06-odo" data-upcount></b> of ' + ups.length + " healthy</span></header>" +
      '<div class="d06-banner" data-banner role="status" hidden></div>' +
      '<table class="table d06-table">' +
        '<colgroup><col class="c-name"><col class="c-tr"><col class="c-health"><col class="c-seen"><col class="c-act"></colgroup>' +
        '<thead><tr><th scope="col">Name</th><th scope="col">Transport</th><th scope="col">Health</th><th scope="col">Last seen</th><th scope="col" class="d06-th-act"><span class="d06-vh">Actions</span></th></tr></thead>' +
        "<tbody>" + ups.map(rowHtml).join("") + "</tbody></table></section>";
  }
  function healthHtml(u) {
    return u.healthy
      ? '<span class="d06-health is-ok"><i class="live-dot" aria-hidden="true"></i>healthy</span>'
      : '<span class="d06-health is-down"><i class="d06-dot" aria-hidden="true"></i>unreachable</span>';
  }
  function rowHtml(u) {
    return '<tr class="d06-row' + (u.healthy ? "" : " is-down") + '" data-up="' + esc(u.name) + '">' +
      '<td><span class="d06-name">' + ico(u.transport === "http" ? "radio" : "terminal") + '<span>' + esc(u.name) + "</span></span></td>" +
      '<td><span class="chip outline d06-chip">' + esc(u.transport) + "</span></td>" +
      '<td data-health>' + healthHtml(u) + "</td>" +
      '<td class="is-time" data-seen>' + (u.seen ? esc(fmt.timeAgo(u.seen)) : "—") + "</td>" +
      '<td class="d06-act"><button type="button" class="btn link d06-restart" data-restart="' + esc(u.name) + '" aria-label="Restart ' + esc(u.name) + '"><span>Restart</span></button></td></tr>';
  }

  function judgePanel() {
    return '<section class="panel d06-judge" data-rise aria-labelledby="d06-judge-h">' +
      '<header class="panel__head d06-head"><div class="d06-head__t"><h2 class="panel__title" id="d06-judge-h">Judge (L3)</h2>' +
        '<p class="d06-sub">Secrets and PII are redacted before the judge sees them.</p></div>' +
        '<span class="chip outline d06-chip" data-running>running · ' + esc(running) + "</span></header>" +
      '<div class="d06-judge__row">' +
        '<div class="seg d06-seg" id="d06-mode" aria-label="L3 mode">' +
          ["local", "tee", "off"].map(function (m) { return '<button type="button" class="seg__item" data-value="' + m + '">' + MODE_LABEL[m] + "</button>"; }).join("") +
        "</div>" +
        '<p class="d06-explain" data-explain aria-live="polite"></p>' +
      "</div>" +
      '<div class="d06-pending" data-pending aria-live="polite" hidden></div>' +
      judgeStats() +
      (running === "tee" ? quotePanel() : "") +
      '<p class="d06-scope">' + ico("info") + "<span>The model-based layers run locally or in a TEE and are attested, not proven.</span></p>" +
    "</section>";
  }
  /* what L3 actually did, from the decisions on this machine */
  function judgeStats() {
    var ran = [], total = D.decisions.length;
    D.decisions.forEach(function (d) { var l = d.layers[3]; if (l && l.ran) ran.push(l.latencyMs); });
    ran.sort(function (a, b) { return a - b; });
    var med = ran.length ? ran[Math.floor(ran.length / 2)] : null;
    var where = { local: "this machine", tee: "Nitro enclave", off: "—" }[running];
    return '<dl class="kv d06-jkv">' +
      '<div class="kv__item"><dt class="kv__k">Runs on</dt><dd class="kv__v">' + esc(where) + "</dd></div>" +
      '<div class="kv__item"><dt class="kv__k">Ran on</dt><dd class="kv__v"><span>' + esc(fmt.int(ran.length)) + '</span><span class="d06-faint">of ' + esc(fmt.int(total)) + " decisions</span></dd></div>" +
      '<div class="kv__item"><dt class="kv__k">Median latency</dt><dd class="kv__v">' + (med == null ? "—" : esc(fmt.ms(med))) + "</dd></div>" +
    "</dl>";
  }
  function quotePanel() {
    var size = quote ? Math.floor((quote.quote.length - 2) / 2) : 0;
    return '<div class="d06-quote" data-quote aria-labelledby="d06-quote-h">' +
      '<div class="d06-quote__head"><p class="eyebrow" id="d06-quote-h">TEE quote</p><span class="d06-spacer"></span>' +
        '<a class="btn link d06-ext" href="' + LINKS.tee + '">TEE mode docs' + ico("arrow-up-right") + "</a></div>" +
      '<div class="d06-quote__hash">' + ui.hash(teeHash, { label: "Quote hash", lg: true }) + '<span class="d06-k">quote hash · sha-256</span></div>' +
      '<dl class="kv d06-qkv">' +
        '<div class="kv__item"><dt class="kv__k">Mode</dt><dd class="kv__v"><span class="chip outline d06-chip">' + esc(quote.mode) + "</span></dd></div>" +
        '<div class="kv__item"><dt class="kv__k">Issued</dt><dd class="kv__v"><span data-tip="' + esc(fmt.dateTime(quote.issuedAt)) + '">' + esc(fmt.timeAgo(quote.issuedAt)) + "</span></dd></div>" +
        '<div class="kv__item"><dt class="kv__k">Size</dt><dd class="kv__v">' + esc(fmt.bytes(size)) + "</dd></div>" +
        '<div class="kv__item"><dt class="kv__k">PCR0</dt><dd class="kv__v">' + ui.hash(quote.pcrs.pcr0, { label: "PCR0" }) + "</dd></div>" +
        '<div class="kv__item"><dt class="kv__k">PCR1</dt><dd class="kv__v">' + ui.hash(quote.pcrs.pcr1, { label: "PCR1" }) + "</dd></div>" +
        '<div class="kv__item"><dt class="kv__k">PCR2</dt><dd class="kv__v">' + ui.hash(quote.pcrs.pcr2, { label: "PCR2" }) + "</dd></div>" +
      "</dl>" +
      '<div class="d06-quote__foot">' +
        '<button type="button" class="btn secondary sm" data-dl-quote>' + ico("download") + "Download quote</button>" +
        '<button type="button" class="copy d06-copyq" data-copy="' + esc(quote.quote) + '">' + ico("copy") + "<span>Copy quote</span></button>" +
        '<p class="d06-sub">Present this on demand to a counterparty.</p>' +
      "</div></div>";
  }

  function proverPanel() {
    return '<section class="panel d06-prover' + (proverUp ? "" : " is-down") + '" data-rise aria-labelledby="d06-prover-h">' +
      '<header class="panel__head d06-head"><h2 class="panel__title" id="d06-prover-h">Prover</h2>' +
        (proverUp ? '<span class="d06-health is-ok"><i class="live-dot" aria-hidden="true"></i>available</span>'
                  : '<span class="d06-health is-down"><i class="d06-dot" aria-hidden="true"></i>unavailable</span>') + "</header>" +
      '<div class="d06-prover__body">' +
        '<div class="d06-prover__stat"><p class="d06-k">Last proof</p>' +
          '<p class="d06-big"><span class="d06-odo" data-proof></span><span class="d06-unit">ms</span></p>' +
          '<p class="d06-sub" data-proof-when>' + (proverUp ? "groth16 · bn254 · from the last attestation" : "before the prover went away") + "</p></div>" +
        '<div class="d06-prover__act">' +
          '<button type="button" class="btn secondary sm d06-test" data-test' + (proverUp ? "" : " disabled") + ">" + ico("play") + '<span data-test-label>Test prover</span></button>' +
          '<span class="track d06-track" data-test-track hidden aria-hidden="true"><span></span></span>' +
        "</div>" +
      "</div>" +
      (proverUp
        ? '<p class="d06-note">A test proof is thrown away: not logged, not chained, not attested.</p>'
        : '<div class="d06-down"><p>' + ico("circle-alert") + "<span>No prover on this machine. Requesting an attestation returns <b class=\"d06-mono\">PROVER_UNAVAILABLE</b> until it is back.</span></p>" +
          '<a class="btn link d06-install" href="' + LINKS.install + '">Install the prover package <span class="nudge">' + ico("arrow-right") + "</span></a></div>") +
    "</section>";
  }

  function tokenPanel() {
    return '<section class="panel d06-token" data-rise aria-labelledby="d06-token-h">' +
      '<header class="panel__head d06-head"><div class="d06-head__t"><h2 class="panel__title" id="d06-token-h">Dashboard token</h2>' +
        '<p class="d06-sub">The bearer token this tab sends to the local API.</p></div></header>' +
      '<div class="d06-tok" data-tok>' + maskHtml() + "</div>" +
      '<div class="d06-token__foot">' +
        '<button type="button" class="btn secondary sm" data-rotate>' + ico("refresh-cw") + "Rotate token</button>" +
        '<span class="d06-path">~/.blindseal/dashboard.token</span>' +
      "</div></section>";
  }
  function maskHtml() {
    return '<div class="d06-mask" data-mask>' +
      '<code class="d06-mask__v" aria-label="Token ending ' + esc(String(D.token).slice(-4)) + '">' + esc(masked().slice(0, -4)) + '<b data-last4>' + esc(String(D.token).slice(-4)) + "</b></code>" +
      '<span class="d06-mask__when">' + (rotatedAt ? "rotated " + esc(fmt.timeAgo(rotatedAt)) : "issued at proxy start · " + esc(fmt.timeAgo(tokenIssued))) + "</span>" +
      '<p class="d06-mask__note">Kept in memory for this tab. Read once from the URL fragment, never written to browser storage.</p>' +
    "</div>";
  }
  function revealHtml(tok) {
    return '<div class="d06-reveal" data-reveal role="region" aria-label="New dashboard token">' +
      '<p class="d06-k">New token</p>' +
      ui.code(full(tok), { copy: true }) +
      '<p class="d06-reveal__note">' + ico("info") + "<span><b>Shown once.</b> Stored at <span class=\"d06-mono\">~/.blindseal/dashboard.token</span>. Every open dashboard tab will need it (<span class=\"d06-mono\">#token=…</span>).</span></p>" +
      '<div class="d06-reveal__foot"><button type="button" class="btn primary sm" data-done>Done</button><span class="d06-sub">It collapses after you copy it.</span></div>' +
    "</div>";
  }

  function aboutPanel() {
    var h = D.audit.head;
    return '<section class="panel d06-about" data-rise aria-labelledby="d06-about-h">' +
      '<header class="panel__head d06-head"><h2 class="panel__title" id="d06-about-h">About</h2></header>' +
      '<dl class="kv kv--rows d06-akv">' +
        '<div class="kv__item"><dt class="kv__k">Proxy</dt><dd class="kv__v d06-mono">' + esc(S.version) + "</dd></div>" +
        '<div class="kv__item"><dt class="kv__k">Dashboard</dt><dd class="kv__v"><span class="d06-mono">' + esc(BS.VERSION.dashboard) + "</span>" +
          (dashRelease ? '<span class="d06-faint">' + esc(fmt.date(dashRelease.date + "T00:00:00Z")) + "</span>" : "") + "</dd></div>" +
        '<div class="kv__item"><dt class="kv__k">Uptime</dt><dd class="kv__v"><span class="d06-odo" data-uptime="about"></span></dd></div>' +
        '<div class="kv__item"><dt class="kv__k">Detector</dt><dd class="kv__v d06-mono">' + esc(S.detectorVersion) + "</dd></div>" +
        '<div class="kv__item"><dt class="kv__k">Policy root</dt><dd class="kv__v">' + ui.hash(S.policyRoot, { label: "Policy root" }) + "</dd></div>" +
        '<div class="kv__item"><dt class="kv__k">Audit head</dt><dd class="kv__v"><span class="d06-mono">#' + esc(fmt.int(h.index)) + "</span>" + ui.hash(h.hash, { label: "Audit head" }) + "</dd></div>" +
        '<div class="kv__item"><dt class="kv__k">Mock mode</dt><dd class="kv__v">' + (S.mock ? '<span class="chip mock">MOCK</span><span class="d06-faint">fixtures are being served</span>' : '<span class="d06-faint">off</span>') + "</dd></div>" +
      "</dl>" +
      '<footer class="panel__foot d06-about__foot">' +
        '<a class="btn link d06-ext" href="' + LINKS.docs + '">Open docs' + ico("arrow-up-right") + "</a>" +
        '<a class="btn link d06-ext" href="' + LINKS.changelog + '">Changelog' + ico("arrow-up-right") + "</a>" +
      "</footer></section>";
  }

  ROOT.innerHTML = band() +
    '<div class="d06-grid">' +
      '<div class="d06-col">' + upstreamsPanel() + judgePanel() + "</div>" +
      '<div class="d06-col">' + proverPanel() + tokenPanel() + aboutPanel() + "</div>" +
    "</div>";

  /* ── odometers ─────────────────────────────────────────────────────────── */
  var upOdo = M.odometer(q("[data-stat=up]"), healthyCount(), { mode: "tick", format: fmt.int });
  var upCountOdo = M.odometer(q("[data-upcount]"), healthyCount(), { mode: "tick", format: fmt.int });
  var proofOdo = M.odometer(q("[data-proof]"), S.prover.lastProofMs, { mode: "roll", format: fmt.int });
  var uptimeOdo = qa("[data-uptime]").map(function (el) { return M.odometer(el, hm(S.uptimeSec), { mode: "tick" }); });
  setInterval(function () { var v = hm(S.uptimeSec); uptimeOdo.forEach(function (o) { o.set(v); }); }, 1000);

  /* ── upstreams ─────────────────────────────────────────────────────────── */
  function syncBanner() {
    var down = ups.filter(function (u) { return !u.healthy; });
    var b = q("[data-banner]");
    if (!down.length) { b.hidden = true; b.innerHTML = ""; return; }
    b.hidden = false;
    b.innerHTML = ico("circle-alert") + '<p><b>' + esc(plural(down.length, "upstream", "upstreams")) + " unreachable</b>" +
      '<span>' + down.map(function (u) { return '<span class="d06-mono">' + esc(u.name) + "</span>"; }).join(", ") +
      " · calls to " + (down.length === 1 ? "its" : "their") + " tools return an error until " + (down.length === 1 ? "it answers" : "they answer") + ".</span></p>";
  }
  syncBanner();

  function restart(btn) {
    var name = btn.getAttribute("data-restart");
    var u = ups.filter(function (x) { return x.name === name; })[0];
    if (!u || btn.getAttribute("aria-busy") === "true") return;
    var label = btn.querySelector("span");
    btn.setAttribute("aria-busy", "true"); label.textContent = "Restarting…";
    var tr = btn.closest("tr");
    tr.classList.add("is-busy");
    M.wait(900).then(function () {
      btn.removeAttribute("aria-busy"); label.textContent = "Restart";
      tr.classList.remove("is-busy");
      if (u.healthy) {
        u.seen = D.now();
        tr.querySelector("[data-seen]").textContent = fmt.timeAgo(u.seen);
        M.flash(tr);
        BS.toast({ title: name + " restarted", body: "It answered the handshake in " + fmt.ms(between(randHs, 140, 320)) + ".", tone: "ok", id: "restart" });
      } else {
        BS.toast({ title: name + " did not answer", body: "It stays unreachable. Check that its command runs on this machine, then restart it again.", tone: "warn", id: "restart" });
      }
    });
  }

  /* ── judge (L3) ────────────────────────────────────────────────────────── */
  var modeSeg = ui.seg(q("#d06-mode"), {
    value: selected,
    onChange: function (v) {
      selected = v;
      syncJudge(true);
      if (v !== running) BS.toast({ title: "Mode changes apply on proxy restart", body: "The judge keeps running " + MODE_LABEL[running] + " until then.", tone: "info", id: "l3" });
      else BS.toast({ title: "Kept " + MODE_LABEL[running], body: "Nothing changes on restart.", tone: "info", id: "l3", timeout: 2400 });
    }
  });
  function syncJudge(animate) {
    var ex = q("[data-explain]");
    ex.textContent = EXPLAIN[selected];
    if (animate) M.restart(ex, "d06-swap");
    var p = q("[data-pending]");
    if (selected === running) { p.hidden = true; p.innerHTML = ""; return; }
    p.hidden = false;
    p.innerHTML = '<span class="d06-pending__dot" aria-hidden="true"></span><span>Selected <b>' + esc(MODE_LABEL[selected]) + "</b> · the proxy runs <b>" + esc(MODE_LABEL[running]) + "</b> until it restarts.</span>" +
      '<button type="button" class="btn link" data-keep>Keep ' + esc(MODE_LABEL[running]) + "</button>";
    if (animate) M.restart(p, "d06-swap");
  }
  syncJudge(false);

  function downloadQuote() {
    var out = D.exportTeeQuote();
    BS.toast({ title: "Quote downloaded", body: out.filename + " · " + fmt.bytes(out.bytes) + " · mode " + quote.mode + ".", tone: "ok", id: "quote" });
  }

  /* ── prover ────────────────────────────────────────────────────────────── */
  function testProver(btn) {
    if (testing || !proverUp) return;
    testing = true;
    var label = q("[data-test-label]"), track = q("[data-test-track]");
    btn.setAttribute("aria-busy", "true"); label.textContent = "Proving…";
    track.hidden = false;
    q("[data-proof-when]").textContent = "generating a test proof…";
    M.wait(1200).then(function () {
      var ms = between(randTest, 3900, 4600);
      if (ms === S.prover.lastProofMs) ms += 7;
      S.prover.lastProofMs = ms;
      lastTest = D.now();
      proofOdo.set(ms);
      btn.removeAttribute("aria-busy"); label.textContent = "Test prover";
      track.hidden = true;
      q("[data-proof-when]").textContent = "groth16 · bn254 · test proof, " + fmt.timeAgo(lastTest);
      testing = false;
      BS.toast({ title: "Proof generated in " + fmt.int(ms) + " ms", body: "A throwaway proof: not logged, not chained, not attested.", tone: "ok", id: "prover" });
    });
  }

  /* ── token ─────────────────────────────────────────────────────────────── */
  function askRotate(btn) {
    if (rotating || shown) return;
    ui.dialog({
      title: "Rotate the dashboard token?",
      body: "<p>Every open dashboard tab will need the new one. The current token stops working at once.</p>",
      actions: [
        { label: "Cancel", cls: "btn secondary" },
        { label: "Rotate", cls: "btn primary", onClick: function () { rotate(btn); } }
      ]
    });
  }
  function rotate(btn) {
    rotating = true;
    /* aria-busy blocks clicks; the button stays enabled so the dialog's close() can return focus to it */
    btn.setAttribute("aria-busy", "true");
    D.rotateToken().then(function (r) {
      rotating = false; btn.removeAttribute("aria-busy"); btn.disabled = true;
      shown = r.token;
      rotatedAt = D.now();
      var slot = q("[data-tok]");
      swap(slot, revealHtml(shown), "d06-reveal-in", function () {
        var copyBtn = q("[data-reveal] .code__copy");
        if (copyBtn) try { copyBtn.focus({ preventScroll: true }); } catch (e) {}
      });
    }, function (e) {
      rotating = false; btn.removeAttribute("aria-busy"); btn.disabled = false;
      BS.toast({ title: "Could not rotate the token", body: (e && e.message) || "The proxy did not answer.", tone: "danger", id: "token" });
    });
  }
  var collapseT = 0;
  function collapse() {
    if (!shown) return;
    clearTimeout(collapseT);
    shown = null;
    var slot = q("[data-tok]");
    var btn = q("[data-rotate]");
    btn.disabled = false;
    swap(slot, maskHtml(), "d06-mask-in", function () {
      var last = q("[data-last4]");
      if (last && !M.reduced()) M.restart(last, "d06-last-flash");
      try { btn.focus({ preventScroll: true }); } catch (e) {}
    });
    BS.toast({ title: "Token rotated", body: "This tab already uses it. Other open tabs need the new token.", tone: "ok", id: "token" });
  }
  /* out 140 in-quick, then the new content in (no layout animation) */
  function swap(slot, html, inCls, then) {
    var old = slot.firstElementChild;
    var put = function () { slot.innerHTML = html; var n = slot.firstElementChild; if (n && !M.reduced()) M.restart(n, inCls); if (then) then(); };
    if (!old || M.reduced()) { put(); return; }
    old.classList.add("d06-out");
    setTimeout(put, M.scale(140));
  }
  document.addEventListener("bs:copy", function (e) {
    if (!shown || !e.detail || e.detail.value !== full(shown)) return;
    clearTimeout(collapseT);
    collapseT = setTimeout(collapse, M.reduced() ? 400 : M.scale(900));
  });

  /* ── events ────────────────────────────────────────────────────────────── */
  ROOT.addEventListener("click", function (e) {
    var t = e.target, b;
    if ((b = t.closest("[data-restart]"))) { restart(b); return; }
    if ((b = t.closest("[data-keep]"))) {
      modeSeg.set(running);
      var act = q("#d06-mode .seg__item.is-active");     /* the pending line (and its button) is gone: keep focus on the segment */
      if (act) try { act.focus({ preventScroll: true }); } catch (e2) {}
      return;
    }
    if (t.closest("[data-dl-quote]")) { downloadQuote(); return; }
    if ((b = t.closest("[data-test]"))) { testProver(b); return; }
    if ((b = t.closest("[data-rotate]"))) { askRotate(b); return; }
    if (t.closest("[data-done]")) { collapse(); return; }
  });
  ROOT.addEventListener("animationend", function (e) {
    var t = e.target; if (!t.classList) return;
    ["bs-rise", "d06-swap", "d06-reveal-in", "d06-mask-in", "d06-last-flash"].forEach(function (c) { if (t.classList.contains(c)) t.classList.remove(c); });
  });

  /* ── first paint ───────────────────────────────────────────────────────── */
  M.rise(qa("[data-rise]"), { y: 14 });

  /* QA hook for the Playwright checks (read-only) */
  window.D06 = {
    state: function () {
      return {
        upstreams: ups.map(function (u) { return { name: u.name, healthy: u.healthy }; }), healthy: healthyCount(),
        l3: { running: running, selected: selected }, quoteHash: teeHash,
        prover: { available: proverUp, lastProofMs: S.prover.lastProofMs, testing: testing },
        token: { masked: masked(), showing: !!shown, rotatedAt: rotatedAt }
      };
    }
  };
})();
