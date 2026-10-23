/* ============================================================================
   _shared/shell.js — BS.mountShell(): the dashboard frame (DECISIONS D06)
   ----------------------------------------------------------------------------
   Port of the V1 sidebar shell (the shell
   + the kit route cover), re-wired for Blindseal. The V2 top-nav branch
   is not ported (Blindseal has one dashboard shell).

   Usage (end of <body>, after the other _shared scripts):
     <main id="main-content"> …page… </main>
     <script>BS.mountShell({ active: "decisions", title: "Decisions" });</script>

   Options:
     active     "decisions" | "audit" | "policy" | "attestations" | "settings"
     title      the top bar's page title (defaults to the nav label)
     actions    HTML string or Node: the top bar's actions slot, after the title
     routes     { id: href } — default BS.ROUTES.dashboard (relative to mockups/<JOB>/)
     navigate   true (default): a nav click slides the pill under a rising
                cover, then loads the page, which lifts the cover quick.
                false: stay on this page and play the in-place swap (kitchen sink).
     onNavigate fn(id) — navigate:false only, called at the swap moment
     cover      true (default): play the first-paint cover
     status     a Status-shaped object; default BS.data.status (fixtures.js),
                else built-in samples
     connection "connected" (default; else BS.data.connection: live → connected,
                reconnecting, offline — fixtures.js sets it from ?state=)

   Frame: sidebar 244 (rail 64, remembered) · brand row = mark A + Blindseal +
   a "local" chip · NAV Decisions (list) · Audit (link) · Policy (scroll-text) ·
   Attestations (stamp) · Settings (settings) · foot = the proxy identity
   ("Proxy", the signer pubkey as a .hash, "v0.4.0 · up 3h 12m") + the rail
   toggle. Top bar 68 (glass): title + actions | connection pill, MOCK chip
   when status.mock (no theme toggle: dark only, light mode will not be added). Status bar 36 (glass):
   live dot + Screening · audit # (tick odometer) + head hash · policy root ·
   detector · L3 mode · MOCK chip when status.mock | Privacy · Docs · Help. html[data-shell="sidebar"] and
   .bs-app[data-shell="sidebar"] are set.

   Route cover (brief numbers, BS.motion.createRouteTransition):
     first paint   INSTANT → mount → hold 650 → out 420 in-out
     page → page   in 180 in-out → swap → hold 100 → out 240 in-out
     across documents the old page slides the pill (240) under a rising cover
     (180), leaves a token in sessionStorage and navigates; the new page opens
     with the cover INSTANT and takes the quick path (hold 100, out 240).
     While the cover is up html[data-covered] is set; reveals wait for
     "bs:uncover" (reveal.js). Reduced motion: no cover, no slide.

   API: BS.shell = { refs, NAV, routes, setActive(id, {animate}), setTitle(t),
        cover(instant) → Promise, uncover(quick) → Promise, replayCover(),
        go(id), setRail(bool), setConnection("connected"|"reconnecting"|"offline"),
        setAuditHead({ index, hash, ts }), setPolicyRoot(hex), connection }
   Events: listens on window AND document (fixtures.js dispatches on window)
           for "bs:audit" { detail: AuditHead } → setAuditHead and "bs:status"
           { detail: Status } → audit head + policy root;
           fires "bs:route" { id } after an in-place swap,
           "bs:connection" { state } on setConnection.
   ========================================================================== */
(function () {
  "use strict";
  var BS = (window.BS = window.BS || {});

  var NAV = BS.NAV || [
    { id: "decisions", label: "Decisions", icon: "list" },
    { id: "audit", label: "Audit", icon: "link" },
    { id: "policy", label: "Policy", icon: "scroll-text" },
    { id: "attestations", label: "Attestations", icon: "stamp" },
    { id: "settings", label: "Settings", icon: "settings" }
  ];
  var DEFAULT_ROUTES = (BS.ROUTES && BS.ROUTES.dashboard) || {
    decisions: "../D01/index.html", audit: "../D03/index.html", policy: "../D04/index.html", attestations: "../D05/index.html", settings: "../D06/index.html"
  };
  var ROUTE_KEY = "bs-route-v1";
  var RAIL_KEY = "bs-sidebar-v1";

  /* samples for a page that runs without fixtures.js (the shapes of FRONTEND §5) */
  var SAMPLE = {
    version: "0.4.0",
    uptimeSec: 11536,
    policyRoot: "0x7c3f9a2e14b8d05c6e91a3f27b48c0d5e9a16f3b2c8d47e05a19b6c3f2d8e714",
    detectorVersion: "det-2026.10.1",
    audit: { index: 4182, hash: "0x2b9e41c7d05a83f6e1b2c94d7a06f53e8c1d29b4a7f06e3c5d18b92a4e7f0c61", ts: "2026-10-22T15:58:12Z" },
    l3: { mode: "local" },
    prover: { available: true, lastProofMs: 4180 },
    mock: true,
    signerPubkey: "7xKq3mVb9TfR2nWcPzE8hLdJ4yA6sGuQ1oNiXeB5rZtH"
  };

  function M() { return BS.motion; }
  function reduced() { return M() ? M().reduced() : false; }
  function wait(ms) { return M() ? M().wait(ms) : new Promise(function (r) { setTimeout(r, ms); }); }
  function scale(ms) { return M() ? M().scale(ms) : ms; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function ico(n, o) { return BS.icon ? BS.icon(n, o) : '<i data-lucide="' + n + '"></i>'; }
  function mark(size) { return BS.mark ? BS.mark("A", size) : ""; }
  function hash(v, o) { return BS.ui && BS.ui.hash ? BS.ui.hash(v, o) : '<span class="hash">' + esc(v) + "</span>"; }
  function int(n) { return BS.fmt && BS.fmt.int ? BS.fmt.int(n) : String(n); }
  function toast(o) { if (BS.toast) BS.toast(o); }
  function labelOf(id) { for (var i = 0; i < NAV.length; i++) if (NAV[i].id === id) return NAV[i].label; return ""; }
  function store(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { return null; } }
  function lstore(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  function brandName() { return BS.BRAND || "Blindseal"; }
  function uptime(sec) { sec = Math.max(0, Number(sec) || 0); var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return h ? h + "h " + m + "m" : m + "m"; }

  var refs = null, opts = null, current = null, route = null, status = null, connection = "connected", auditOdo = null;

  function readStatus() {
    var s = opts.status || (BS.data && BS.data.status) || null;
    var out = {};
    Object.keys(SAMPLE).forEach(function (k) { out[k] = SAMPLE[k]; });
    if (s) Object.keys(s).forEach(function (k) { if (s[k] != null) out[k] = s[k]; });
    if (!out.signerPubkey && BS.data && BS.data.signerPubkey) out.signerPubkey = BS.data.signerPubkey;
    if (!out.signerPubkey) out.signerPubkey = SAMPLE.signerPubkey;
    return out;
  }

  /* ── build ────────────────────────────────────────────────────────────── */
  function navItem(n, ink) {
    var inner = '<span class="bs-navitem__g">' + ico(n.icon) + '</span><span class="bs-navitem__t">' + esc(n.label) + "</span>";
    if (ink) return '<span class="bs-navitem" data-nav="' + n.id + '">' + inner + "</span>";
    return '<a class="bs-navitem" href="' + esc(opts.routes[n.id] || "#") + '" data-nav="' + n.id + '" aria-label="' + esc(n.label) + '">' + inner + "</a>";
  }

  function footHtml() {
    var ver = (BS.VERSION && BS.VERSION.proxy) || status.version || "0.4.0";
    return '<div class="bs-proxy"><span class="bs-proxy__k"><span class="live-dot" aria-hidden="true"></span>Proxy</span>' +
      hash(status.signerPubkey, { label: "Proxy signer (ed25519)" }) + "</div>" +
      '<div class="bs-side__footrow"><span class="bs-side__ver" data-ver>v' + esc(ver) + " · up " + esc(uptime(status.uptimeSec)) + "</span>" +
      '<button type="button" class="icon-btn" data-collapse>' + ico("panel-left") + "</button></div>";
  }

  function connHtml() {
    return '<button type="button" class="conn" data-conn data-state="connected" aria-live="polite"><span class="live-dot" aria-hidden="true"></span>' +
      '<span data-conn-label>Connected</span><span class="conn__addr" data-conn-addr>127.0.0.1:7777</span></button>';
  }

  function statusHtml() {
    return '<footer class="glass-bar glass-bar--bottom bs-status" aria-label="Proxy status">' +
      '<span class="bs-sb" data-sb-conn data-state="connected"><span class="live-dot" aria-hidden="true"></span><span class="bs-sb__v" data-sb-conn-label>Screening</span></span>' +
      '<span class="bs-sb"><span class="bs-sb__k">audit #</span><span class="bs-sb__v num" data-sb-audit></span><span data-sb-audit-hash>' + hash(status.audit.hash, { label: "Audit head hash" }) + "</span></span>" +
      '<span class="bs-sb"><span class="bs-sb__k">policy</span><span data-sb-policy>' + hash(status.policyRoot, { label: "Policy root" }) + "</span></span>" +
      '<span class="bs-sb"><span class="bs-sb__k">detector</span><span class="bs-sb__v">' + esc(status.detectorVersion) + "</span></span>" +
      '<span class="bs-sb"><span class="bs-sb__k">L3</span><span class="bs-sb__v">' + esc((status.l3 && status.l3.mode) || "local") + "</span></span>" +
      (status.mock ? '<span class="bs-sb"><span class="chip mock" title="Mock mode: fixture data, fake event stream">MOCK</span></span>' : "") +
      '<span class="bs-status__spacer"></span>' +
      '<a class="glass-item" href="#privacy" data-stub="Privacy">Privacy</a>' +
      '<a class="glass-item" href="' + esc((BS.ROUTES && BS.ROUTES.site && BS.ROUTES.site.docs) || "../S04/index.html") + '">Docs</a>' +
      '<a class="glass-item" href="#help" data-stub="Help">Help</a>' +
      "</footer>";
  }

  function build(main) {
    var html = document.documentElement;
    html.classList.add("bs-shell");
    html.setAttribute("data-shell", "sidebar");
    var name = brandName();
    var app = document.createElement("div");
    app.className = "bs-app";
    app.setAttribute("data-shell", "sidebar");
    app.innerHTML =
      '<a class="skip-link" href="#main-content">Skip to content</a>' +
      '<aside class="bs-side" aria-label="' + esc(name) + '">' +
        '<div class="bs-side__brand"><a class="bs-wordmark" href="' + esc(opts.routes.decisions) + '" data-nav-link="decisions" aria-label="' + esc(name) + ', decisions">' +
          mark(20) + '<span class="bs-wordmark__word">' + esc(name) + '</span></a><span class="chip outline">local</span></div>' +
        '<nav class="bs-side__nav" aria-label="Sections"><p class="bs-nav__label">Dashboard</p><div class="bs-nav"><span class="bs-nav__pill" aria-hidden="true"></span>' +
          NAV.map(function (n) { return navItem(n, false); }).join("") +
          '<div class="bs-nav__ink" aria-hidden="true">' + NAV.map(function (n) { return navItem(n, true); }).join("") + "</div>" +
        "</div></nav>" +
        '<div class="bs-side__foot" data-foot>' + footHtml() + "</div>" +
      "</aside>" +
      '<div class="bs-work">' +
        '<header class="glass-bar glass-bar--top bs-top">' +
          '<div class="bs-top__lead"><p class="bs-top__title" data-title></p><span class="bs-top__actions" data-actions></span></div>' +
          '<div class="bs-top__right">' + connHtml() +
            (status.mock ? '<span class="chip mock" title="Mock mode: fixture data, fake event stream">MOCK</span>' : "") +
          "</div>" +
        "</header>" +
      "</div>" +
      '<div class="bs-cover" aria-hidden="true"><div class="bs-cover__ind">' + mark(28) + '<div class="track"><span></span></div></div></div>';
    document.body.insertBefore(app, document.body.firstChild);
    var work = app.querySelector(".bs-work");
    main.id = "main-content";
    main.classList.add("bs-main");
    main.setAttribute("tabindex", "-1");
    work.appendChild(main);
    app.insertAdjacentHTML("beforeend", statusHtml());
    document.body.classList.add("bs-mounted");

    refs = {
      app: app, side: app.querySelector(".bs-side"), nav: app.querySelector(".bs-nav"),
      pill: app.querySelector(".bs-nav__pill"), ink: app.querySelector(".bs-nav__ink"),
      items: [].slice.call(app.querySelectorAll(".bs-nav > .bs-navitem")),
      title: app.querySelector("[data-title]"), actions: app.querySelector("[data-actions]"),
      foot: app.querySelector("[data-foot]"), cover: app.querySelector(".bs-cover"),
      top: app.querySelector(".bs-top"), conn: app.querySelector("[data-conn]"),
      status: app.querySelector(".bs-status"), main: main
    };
    route = M() ? M().createRouteTransition(refs.cover) : null;
    setTitle(opts.title || labelOf(opts.active));
    if (opts.actions) { if (opts.actions.nodeType) refs.actions.appendChild(opts.actions); else refs.actions.innerHTML = opts.actions; }
    wireFoot();
    wireTop();
    wireNav();
    wireStatus();
    wireFlyout();
    applyRail(lstore(RAIL_KEY) === "rail", false);
  }

  /* ── the white sliding pill + its ink layer ───────────────────────────── */
  var pillBase = 0, glideUntil = 0, lastKey = "";
  function measure(animate) {
    var a = refs.nav.querySelector('.bs-navitem[aria-current="page"]');
    if (!a || !a.offsetWidth) { refs.nav.classList.remove("has-pill"); return; }
    var box = [a.offsetLeft, a.offsetTop, a.offsetWidth, a.offsetHeight];
    var key = box.join(",");
    var W = refs.nav.offsetWidth, H = refs.nav.offsetHeight;
    var apply = function () {
      if (!pillBase || !animate) pillBase = box[2];   /* base = the item width → scaleX 1 */
      refs.pill.style.width = pillBase + "px";
      refs.pill.style.height = box[3] + "px";
      refs.pill.style.transform = "translate(" + box[0] + "px," + box[1] + "px) scaleX(" + (box[2] / pillBase) + ")";
      refs.ink.style.clipPath = "inset(" + box[1] + "px " + (W - box[0] - box[2]) + "px " + (H - box[1] - box[3]) + "px " + box[0] + "px round 8px)";
      lastKey = key;
      refs.nav.classList.add("has-pill");
    };
    if (animate === true || Date.now() < glideUntil) {
      if (animate === true) glideUntil = Date.now() + scale(260);
      apply();
      return;
    }
    if (lastKey === key && refs.nav.classList.contains("has-pill")) return;
    refs.nav.classList.add("is-nofx");
    apply();
    void getComputedStyle(refs.pill).transform;
    requestAnimationFrame(function () {
      refs.nav.classList.remove("is-nofx");
      if (!reduced()) refs.nav.classList.add("is-animated");
    });
  }
  function setActive(id, o) {
    o = o || {};
    current = id;
    refs.items.forEach(function (a) {
      if (a.getAttribute("data-nav") === id) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    measure(!!o.animate && !reduced() && refs.nav.classList.contains("is-animated"));
  }
  function setTitle(t) {
    refs.title.textContent = t || "";
    try { if (t) document.title = t + " · " + brandName(); } catch (e) {}
  }

  /* ── the route cover ──────────────────────────────────────────────────── */
  function cover(instant) {
    document.documentElement.setAttribute("data-covered", "");
    if (instant || !route) { if (route) route.cover(); else refs.cover.classList.add("is-visible"); return Promise.resolve(); }
    return route.show();
  }
  function uncover(quick, hold) {
    var lift = function () {
      document.documentElement.removeAttribute("data-covered");
      document.dispatchEvent(new CustomEvent("bs:uncover"));
    };
    if (!route) { refs.cover.classList.remove("is-visible"); lift(); return Promise.resolve(); }
    return route.hide({ quick: !!quick, hold: hold }).then(lift);
  }
  /* kitchen sink: replay the first-paint path (instant / 650 / 420) */
  function replayCover() {
    if (reduced()) return Promise.resolve();
    cover(true);
    return uncover(false, 650);
  }

  /* ── navigation ───────────────────────────────────────────────────────── */
  var navToken = 0;
  function go(id, href) {
    if (!id || id === current) return;
    var token = ++navToken;
    if (reduced()) {
      setActive(id);
      if (opts.navigate) { location.href = href; return; }
      swapInPlace(id);
      return;
    }
    setActive(id, { animate: true });
    if (opts.navigate) {
      cover(false).then(function () { return wait(60); }).then(function () {
        if (token !== navToken) return;
        store(ROUTE_KEY, String(Date.now()));
        location.href = href;
      });
      return;
    }
    /* in place: in 180 → swap → hold 100 → out 240 */
    cover(false).then(function () {
      if (token !== navToken) return;
      swapInPlace(id);
      return uncover(true, 100);
    });
  }
  function swapInPlace(id) {
    setTitle(labelOf(id));
    refs.main.scrollTop = 0;
    try { refs.main.focus({ preventScroll: true }); } catch (e) {}
    if (typeof opts.onNavigate === "function") opts.onNavigate(id);
    document.dispatchEvent(new CustomEvent("bs:route", { detail: { id: id } }));
  }
  function wireNav() {
    refs.app.addEventListener("click", function (e) {
      var a = e.target.closest("[data-nav], [data-nav-link]");
      if (!a || !refs.app.contains(a) || a.closest(".bs-nav__ink")) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;   /* new tab keeps working */
      var id = a.getAttribute("data-nav") || a.getAttribute("data-nav-link");
      e.preventDefault();
      if (refs.fly) refs.fly.classList.remove("is-on");
      go(id, opts.routes[id]);
    });
    if ("ResizeObserver" in window) new ResizeObserver(function () { measure(); }).observe(refs.nav);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { measure(); });
  }

  /* ── the icon rail + its flyout ───────────────────────────────────────── */
  function applyRail(rail, persist) {
    refs.app.classList.toggle("is-rail", !!rail);
    var b = refs.foot.querySelector("[data-collapse]");
    if (b) {
      b.setAttribute("aria-pressed", String(!!rail));
      b.setAttribute("aria-label", rail ? "Expand the sidebar" : "Collapse the sidebar");
      b.title = b.getAttribute("aria-label");
    }
    if (persist) lstore(RAIL_KEY, rail ? "rail" : "full");
    pillBase = 0;
    measure();
  }
  function wireFlyout() {
    var fly = document.createElement("div");
    fly.className = "bs-flyout"; fly.setAttribute("aria-hidden", "true");
    document.body.appendChild(fly);
    refs.fly = fly;
    var t = 0;
    var show = function (a) {
      if (!refs.app.classList.contains("is-rail")) return;
      clearTimeout(t);
      var r = a.getBoundingClientRect();
      fly.textContent = a.getAttribute("aria-label");
      fly.classList.remove("is-on"); void fly.offsetWidth;
      fly.style.top = Math.round(r.top + r.height / 2 - fly.offsetHeight / 2) + "px";
      fly.style.left = Math.round(r.right + 10) + "px";
      fly.classList.add("is-on");
    };
    var hide = function () { clearTimeout(t); t = setTimeout(function () { fly.classList.remove("is-on"); }, 160); };
    refs.items.forEach(function (a) {
      a.addEventListener("pointerenter", function () { show(a); });
      a.addEventListener("pointerleave", hide);
      a.addEventListener("focus", function () { show(a); });
      a.addEventListener("blur", hide);
    });
  }

  /* ── foot + top bar ───────────────────────────────────────────────────── */
  function wireFoot() {
    var c = refs.foot.querySelector("[data-collapse]");
    if (c) c.addEventListener("click", function () { applyRail(!refs.app.classList.contains("is-rail"), true); });
  }
  var CONN = {
    connected: { label: "Connected", sb: "Screening", addr: "127.0.0.1:7777", note: "Connected to the local proxy at 127.0.0.1:7777. Events stream over /events." },
    reconnecting: { label: "Reconnecting…", sb: "Reconnecting", addr: "retry in 4s", note: "The proxy stopped answering. Cached data stays visible; the live stream is paused." },
    offline: { label: "Offline", sb: "Offline", addr: "127.0.0.1:7777", note: "The proxy is unreachable. Start it with `blindseal run`; cached data stays visible." }
  };
  function setConnection(state) {
    if (!CONN[state]) return;
    connection = state;
    var c = CONN[state];
    refs.conn.setAttribute("data-state", state);
    refs.conn.querySelector("[data-conn-label]").textContent = c.label;
    refs.conn.querySelector("[data-conn-addr]").textContent = c.addr;
    var sb = refs.status.querySelector("[data-sb-conn]");
    sb.setAttribute("data-state", state);
    sb.querySelector("[data-sb-conn-label]").textContent = c.sb;
    document.dispatchEvent(new CustomEvent("bs:connection", { detail: { state: state } }));
  }
  function wireTop() {
    refs.conn.addEventListener("click", function () { toast({ title: CONN[connection].label, body: CONN[connection].note, tone: connection === "connected" ? "info" : "warn", id: "conn" }); });
  }

  /* ── status bar: the audit head odometer + hashes ─────────────────────── */
  function setAuditHead(head) {
    if (!head) return;
    status.audit = { index: head.index, hash: head.hash || status.audit.hash, ts: head.ts || status.audit.ts };
    if (auditOdo) auditOdo.set(head.index);
    else refs.status.querySelector("[data-sb-audit]").textContent = int(head.index);
    if (head.hash) refs.status.querySelector("[data-sb-audit-hash]").innerHTML = hash(head.hash, { label: "Audit head hash" });
  }
  function setPolicyRoot(root) {
    if (!root) return;
    status.policyRoot = root;
    refs.status.querySelector("[data-sb-policy]").innerHTML = hash(root, { label: "Policy root" });
  }
  function wireStatus() {
    [].forEach.call(refs.status.querySelectorAll("[data-stub]"), function (a) {
      a.addEventListener("click", function (e) { e.preventDefault(); toast({ title: a.getAttribute("data-stub"), body: "This page is not part of the mockups yet.", tone: "info", id: "stub" }); });
    });
    var host = refs.status.querySelector("[data-sb-audit]");
    auditOdo = M() ? M().odometer(host, status.audit.index, { mode: "tick", format: int }) : null;
    if (!auditOdo) host.textContent = int(status.audit.index);
    /* fixtures.js dispatches bs:* on window, pages may dispatch on document:
       listen on both; an event seen once is not handled twice */
    var seenEv = null;
    var onAudit = function (e) { if (e === seenEv) return; seenEv = e; setAuditHead(e.detail); };
    var onStatus = function (e) {
      if (e === seenEv) return; seenEv = e;
      var s = e.detail || {};
      if (s.audit) setAuditHead(s.audit);
      if (s.policyRoot && s.policyRoot !== status.policyRoot) setPolicyRoot(s.policyRoot);
    };
    [window, document].forEach(function (t) { t.addEventListener("bs:audit", onAudit); t.addEventListener("bs:status", onStatus); });
  }

  /* ── mount ────────────────────────────────────────────────────────────── */
  function mountShell(o) {
    if (refs) return BS.shell;
    opts = Object.assign({ active: "decisions", title: "", navigate: true, cover: true }, o || {});
    opts.routes = Object.assign({}, DEFAULT_ROUTES, opts.routes || {});
    status = readStatus();
    var main = document.getElementById("main-content") || document.querySelector("body > main") || document.querySelector("main");
    if (!main) { main = document.createElement("main"); document.body.appendChild(main); }
    build(main);
    setActive(opts.active);
    /* fixtures.js says BS.data.connection = live | reconnecting | offline (from ?state=) */
    var dc = BS.data && BS.data.connection;
    if (!dc) { var q = /[?&]state=([a-z,-]+)/.exec(location.search); dc = q && /offline/.test(q[1]) ? "offline" : q && /reconnecting/.test(q[1]) ? "reconnecting" : "live"; }
    setConnection(opts.connection || (dc === "offline" ? "offline" : dc === "reconnecting" ? "reconnecting" : "connected"));

    /* first paint: INSTANT → hold (650, or 100 after an in-app hop) → out (420, or quick 240) */
    var token = store(ROUTE_KEY);
    store(ROUTE_KEY, null);
    var hop = token && Date.now() - Number(token) < 4000;
    if (opts.cover && !reduced()) {
      cover(true);
      var fonts = document.fonts && document.fonts.ready ? Promise.race([document.fonts.ready, wait(1200)]) : Promise.resolve();
      var held = wait(hop ? 100 : 650);
      Promise.all([held, fonts]).then(function () { requestAnimationFrame(function () { requestAnimationFrame(function () { uncover(hop, 0); }); }); });
    }
    if (M()) M().mountReveals(main);
    return BS.shell;
  }

  BS.mountShell = mountShell;
  BS.shell = {
    get refs() { return refs; },
    NAV: NAV,
    get routes() { return opts ? opts.routes : DEFAULT_ROUTES; },
    get connection() { return connection; },
    get status() { return status; },
    setActive: function (id, o) { setActive(id, o); },
    setTitle: function (t) { setTitle(t); },
    cover: function (instant) { return cover(instant); },
    uncover: function (quick) { return uncover(quick); },
    replayCover: replayCover,
    go: function (id) { go(id, opts.routes[id]); },
    setRail: function (on) { applyRail(on, true); },
    setConnection: setConnection,
    setAuditHead: setAuditHead,
    setPolicyRoot: setPolicyRoot
  };
})();
