/* ============================================================================
   _shared/site.js — BS.mountSite(): the marketing-site chrome (D05)
   ----------------------------------------------------------------------------
   Usage (end of <body>, after the other _shared scripts; site.css loaded):
     <main id="main-content" class="site-main">
       <section class="hero"> <div class="hero__space"></div> … </section>
       <section class="site-section reveal"> … </section>
     </main>
     <script>BS.mountSite({ active: "how" });</script>

   Options:
     active     "home" | "how" | "verify" | "docs" | "explorer" | "changelog"
                (home lights no link; the brand is the home link)
     action     { label, href } for the notch's right-hand button (round 1 only; the pill has none, D49)
     routes     { id: href } — default BS.ROUTES.site
     nav        "pill" (DEFAULT, round 2: the reference glass pill, nav.css) | "notch" (round 1). The chrome is
                server-rendered from site-templates.cjs navHtml({ nav }); mountSite adopts whichever it
                finds (a .nav-pill in the header means "pill"), so this option only documents intent.
     navigate   true (default): links load their page. false (kitchen sink):
                a click slides the white pill in place (240ms out-quint) and
                toasts, nothing loads.
     footer     ignored (D39: there is no footer; site-templates footerHtml() returns "")
     space      true (default): fill every .hero__space with BS.mountSpace
                (data-intensity="faint" on the host halves it) and every
                [data-space] host likewise
     hero       { background: "nebula" (default) | "crt" | "banner", crt: { …BS.CRT_DEFAULTS }, src }
                — or data-bg="crt" | "banner" on the .hero__space: the ATTRIBUTE WINS (round-1
                semantics; in the app mountSite runs only on the first route, so a page's own
                data-bg is the reliable switch — the port sets data-bg="banner" on Home's
                .hero__space). The option applies to hosts without a data-bg.
                "crt" mounts BS.mountCRT (crt.js, D37); without crt.js or WebGL2 it falls back to the
                nebula (data-bg="nebula"). "banner" (D38) puts the owner's dial banner in the host as
                <img class="hero__banner"> (src: hero.src or BS.ASSETS.brand + "banner-dial.webp";
                an img.hero__banner already in the host is adopted, not duplicated): no CRT, no nebula.

   It adopts (never creates) the server-rendered chrome: the frame (.site-frame, hidden under the pill),
   the nav (.site-notch > .nav-pill, or the notch row); plays the hero's masthead rise (.hero.is-rising,
   CSS: rise-16 450ms at 0 / 30 / 180 / 260ms, trust +60ms each); wires the
   install blocks' copy ([data-copy], ui.js); arms every .reveal (reveal.js).
   The pill is glass at all times and static on scroll (reference hides its pill behind an intro at the top;
   we do not), so nothing listens to scroll.

   API: BS.site = { refs, nav ("pill" | "notch"), setActive(id, { animate }), setNav() (warns: fixed),
                    toast(o), spaces (the nebula mounts), crt (the CRT api or null),
                    banner (the hero banner <img> or null), mountSpaces() }
   ========================================================================== */
(function () {
  "use strict";
  var BS = (window.BS = window.BS || {});

  var NAV = (BS.siteTemplates && BS.siteTemplates.NAV) || [];
  var DEFAULT_ROUTES = (BS.ROUTES && BS.ROUTES.site) || {
    home: "../S01/index.html", how: "../S02/index.html", verify: "../S03/index.html", docs: "../S04/index.html", explorer: "../S05/index.html", changelog: "../S06/index.html"
  };

  function M() { return BS.motion; }
  function reduced() { return M() ? M().reduced() : false; }
  function scale(ms) { return M() ? M().scale(ms) : ms; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function ico(n, o) { return BS.icon ? BS.icon(n, o) : '<i data-lucide="' + n + '"></i>'; }
  function mark(size) { return BS.mark ? BS.mark("A", size) : ""; }
  function toast(o) { if (BS.toast) BS.toast(o); }

  var refs = null, opts = null, current = null, spaces = [];

  /* templates: kit/site-templates.cjs (window.BS.siteTemplates) — rendered server-side, adopted here */

  /* ── the sliding white pill (the shell's mechanics: translate + scaleX on a
     fixed base width, the ink layer clipped to the same rect, 240ms
     out-quint, armed one frame after first paint) ─────────────────────── */
  var pillBase = 0, lastKey = "", glideUntil = 0;
  /* the ink clip's corner: --pill-r on .notch__items (the pill: 10, the reference bar's item radius); the notch: a full pill */
  function pillR(h) {
    var v = parseFloat(getComputedStyle(refs.items).getPropertyValue("--pill-r"));
    return isFinite(v) ? Math.min(v, h / 2) : h / 2;
  }
  function measure(animate) {
    var box0 = refs.items;
    var a = box0.querySelector('.notch__item[aria-current="page"]');
    if (!a || !a.offsetWidth) { box0.classList.remove("has-pill"); return; }
    var box = [a.offsetLeft, a.offsetTop, a.offsetWidth, a.offsetHeight], key = box.join(",");
    var W = box0.offsetWidth, H = box0.offsetHeight;
    var apply = function () {
      if (!pillBase || !animate) pillBase = box[2];
      refs.pill.style.width = pillBase + "px";
      refs.pill.style.height = box[3] + "px";
      refs.pill.style.transform = "translate(" + box[0] + "px," + box[1] + "px) scaleX(" + (box[2] / pillBase) + ")";
      refs.ink.style.clipPath = "inset(" + box[1] + "px " + (W - box[0] - box[2]) + "px " + (H - box[1] - box[3]) + "px " + box[0] + "px round " + pillR(box[3]) + "px)";
      lastKey = key;
      box0.classList.add("has-pill");
    };
    if (animate === true || Date.now() < glideUntil) { if (animate === true) glideUntil = Date.now() + scale(260); apply(); return; }
    if (lastKey === key && box0.classList.contains("has-pill")) return;
    box0.classList.add("is-nofx");
    apply();
    void getComputedStyle(refs.pill).transform;
    requestAnimationFrame(function () { box0.classList.remove("is-nofx"); if (!reduced()) box0.classList.add("is-animated"); });
  }
  function setActive(id, o) {
    o = o || {};
    current = id;
    [].forEach.call(refs.items.querySelectorAll(".notch__item"), function (a) {
      if (a.getAttribute("data-site-nav") === id) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    [].forEach.call(document.querySelectorAll("[data-site-foot]"), function (a) {
      if (a.getAttribute("data-site-foot") === id) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    [].forEach.call(document.querySelectorAll("[data-site-menu-link]"), function (a) {   /* the phone menu sheet */
      if (a.getAttribute("data-site-menu-link") === id) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    measure(!!o.animate && !reduced() && refs.items.classList.contains("is-animated"));
  }

  function wire() {
    refs.notch.addEventListener("click", function (e) {
      var a = e.target.closest("[data-site-nav], [data-site-home], [data-site-cta], [data-site-social]");
      if (!a || a.closest(".notch__ink")) return;
      if (opts.navigate) return;                       /* real links: let them load */
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
      e.preventDefault();
      if (a.hasAttribute("data-site-social")) { toast({ title: a.getAttribute("data-site-social") === "x" ? "X" : "GitHub", body: "Opens " + a.getAttribute("href").replace(/^https:\/\//, "") + " in a new tab (navigate: false keeps you here).", tone: "info", id: "site-nav" }); return; }
      if (a.hasAttribute("data-site-cta")) { toast({ title: a.textContent.trim(), body: "Opens " + a.getAttribute("href") + " (navigate: false keeps you here).", tone: "info", id: "site-nav" }); return; }
      var id = a.getAttribute("data-site-nav") || "home";
      setActive(id, { animate: true });
      toast({ title: id === "home" ? "Home" : a.textContent, body: "In-place navigation: the pill slides, nothing loads (navigate: false).", tone: "info", id: "site-nav" });
    });
    if ("ResizeObserver" in window) new ResizeObserver(function () { measure(); }).observe(refs.items);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { measure(); });
  }

  var crt = null, banner = null;
  function narrow() { return !!(window.matchMedia && window.matchMedia("(max-width: 719.98px)").matches); }
  /* the hero background: data-bg="crt" on the .hero__space (or BS.mountSite({ hero: { background: "crt", crt: {…} } }))
     mounts the CRT field (crt.js, D37); anything else, or no WebGL2, the nebula (D04) */
  function heroBg(host) {
    var hero = opts.hero || {};
    return host.getAttribute("data-bg") || hero.background || "nebula";   /* the attribute wins */
  }
  /* D38: the dial banner, right-anchored at full hero height (site.css .hero__banner); adopts a server-rendered img */
  function mountBannerHero(host) {
    if (heroBg(host) !== "banner") return false;
    host.dataset.bg = "banner";
    var img = host.querySelector("img.hero__banner");
    if (!img) {
      var base = (BS.ASSETS && BS.ASSETS.brand) || (BS.siteTemplates && BS.siteTemplates.BRAND_BASE) || "/kit/brand/";
      var src = (opts.hero && opts.hero.src) || base + "banner-dial.webp";
      img = document.createElement("img");
      img.className = "hero__banner"; img.alt = ""; img.setAttribute("aria-hidden", "true");
      img.decoding = "async"; img.draggable = false; img.setAttribute("fetchpriority", "high");
      img.src = src;
      host.appendChild(img);
    }
    banner = img;
    return true;
  }
  function mountCrtHero(host) {
    var hero = opts.hero || {};
    var want = heroBg(host);
    if (want !== "crt") return false;
    /* phone width (< 720 px): the nebula, not the CRT — the WebGL field is capped at 1.5× DPR and reads
       blocky on a 3× phone, and a full-screen multi-pass shader is the wrong battery trade there; the
       nebula is CSS gradients + SVG, crisp at any DPR */
    if (narrow()) { host.dataset.bg = "nebula"; return false; }
    var api = BS.mountCRT ? BS.mountCRT(host, hero.crt || {}) : null;
    if (!api) { host.dataset.bg = "nebula"; return false; }
    crt = api;
    return true;
  }
  function mountSpaces() {
    if (!BS.mountSpace && !BS.mountCRT) return;
    [].forEach.call(document.querySelectorAll(".hero__space, [data-space]"), function (host) {
      if (host.hasAttribute("data-space-mounted")) return;
      host.setAttribute("data-space-mounted", "");
      if (host.matches(".hero__space") && (mountBannerHero(host) || mountCrtHero(host))) return;
      if (!BS.mountSpace) return;
      var i = host.getAttribute("data-intensity") || host.getAttribute("data-space") || "hero";
      spaces.push(BS.mountSpace(host, { intensity: i === "faint" ? "faint" : "hero", fade: host.getAttribute("data-fade") !== "false" }));
    });
  }

  function rise() {
    [].forEach.call(document.querySelectorAll(".hero__trust"), function (t) {
      [].forEach.call(t.children, function (li, i) { li.style.setProperty("--i", String(i)); });
    });
    if (reduced()) return;
    [].forEach.call(document.querySelectorAll(".hero"), function (h) { h.classList.add("is-rising"); });
  }

  /* the nav mode is chosen by the server-rendered template (navHtml({ nav: "pill" | "notch" })); the glass variant lived in setNav */
  function setNav() { if (console && console.warn) console.warn("BS.site.setNav: the site renders its nav server-side (site-templates navHtml({ nav })); the mode is fixed"); }

  /* ADOPT-ONLY: the chrome — skip-link, frame, notch, footer — is rendered by React
     on the server from kit/site-templates.cjs (the same strings this file used to build). mountSite finds
     those nodes and wires them; it creates nothing and writes nothing on html, head or body children. */
  function mountSite(o) {
    if (refs) return BS.site;
    opts = Object.assign({ active: "home", navigate: true, footer: false, space: true, nav: "pill" }, o || {});
    opts.routes = Object.assign({}, DEFAULT_ROUTES, opts.routes || {});
    var notch = document.querySelector("header.site-notch[data-site-nav-root]");
    var frame = document.querySelector(".site-frame");
    var main = document.getElementById("main-content");
    if (!notch || !frame || !main) { if (console && console.warn) console.warn("BS.mountSite: chrome not found in the document (it must be server-rendered)"); return null; }
    refs = { notch: notch, frame: frame, main: main };
    refs.items = notch.querySelector(".notch__items");
    refs.pill = notch.querySelector(".notch__pill");
    refs.ink = notch.querySelector(".notch__ink");
    refs.footer = main.querySelector(".site-footer");   /* round 2: empty (or absent) — D39 */
    refs.bar = notch.querySelector(".nav-pill");
    opts.nav = refs.bar ? "pill" : "notch";
    setActive(opts.active);
    wire();
    if (opts.space) mountSpaces();
    rise();
    if (BS.ui && BS.ui.copy) BS.ui.copy(document);
    if (M()) M().mountReveals(document);
    return BS.site;
  }

  BS.mountSite = mountSite;
  BS.site = {
    get refs() { return refs; },
    get spaces() { return spaces; },
    get crt() { return crt; },
    get banner() { return banner; },
    get nav() { return opts ? opts.nav : null; },
    NAV: NAV,
    setActive: function (id, o) { setActive(id, o); },
    setNav: setNav,
    toast: toast,
    mountSpaces: mountSpaces
  };
})();
