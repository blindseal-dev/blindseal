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
     action     { label, href } for the right-hand primary
                (default "Open dashboard" → BS.ROUTES.dashboard.decisions)
     routes     { id: href } — default BS.ROUTES.site
     nav        "notch" (default: the notch nav's opaque tabs + the 8px frame) |
                "glass" (the brief's floating glass pills; no frame)
     navigate   true (default): links load their page. false (kitchen sink):
                a click slides the white pill in place (240ms out-quint) and
                toasts, nothing loads.
     footer     true (default): append the footer to main
     space      true (default): fill every .hero__space with BS.mountSpace
                (data-intensity="faint" on the host halves it) and every
                [data-space] host likewise
     hero       { background: "nebula" (default) | "crt", crt: { …BS.CRT_DEFAULTS } }
                — or data-bg="crt" on the .hero__space (the attribute wins).
                "crt" mounts BS.mountCRT (crt.js, D37: S01 only); without
                crt.js or WebGL2 it falls back to the nebula (data-bg="nebula")

   It renders into body: the frame (.site-frame), the notch nav
   (.site-notch), the footer; plays the hero's masthead rise (.hero.is-rising,
   CSS: rise-16 450ms at 0 / 30 / 180 / 260ms, trust +60ms each); wires the
   install blocks' copy ([data-copy], ui.js); arms every .reveal (reveal.js).
   the notch nav's nav is static on scroll, so nothing listens to scroll.

   API: BS.site = { refs, setActive(id, { animate }), setNav("notch"|"glass"),
                    toast(o), spaces (the nebula mounts), crt (the CRT api or null) }
   ========================================================================== */
(function () {
  "use strict";
  var BS = (window.BS = window.BS || {});

  var NAV = BS.SITE_NAV || [
    { id: "how", label: "How it works" }, { id: "verify", label: "Verify" }, { id: "docs", label: "Docs" },
    { id: "explorer", label: "Explorer" }, { id: "changelog", label: "Changelog" }
  ];
  var DEFAULT_ROUTES = (BS.ROUTES && BS.ROUTES.site) || {
    home: "../S01/index.html", how: "../S02/index.html", verify: "../S03/index.html", docs: "../S04/index.html", explorer: "../S05/index.html", changelog: "../S06/index.html"
  };
  var FOOT = [
    { id: "home", label: "Home" }, { id: "how", label: "How it works" }, { id: "verify", label: "Verify" },
    { id: "docs", label: "Docs" }, { id: "explorer", label: "Explorer" }, { id: "changelog", label: "Changelog" }
  ];
  /* the wings: 16×16 concave corners (fill comes from site.css) */
  /* each: the canvas fill (extended 1px over the tab's hairline) + the arc alone
     as a 1px --line stroke, which joins the tab outline to the frame's line */
  var WING = {
    tr: '<svg class="notch__wing notch__wing--tr" viewBox="-1 0 17 16" aria-hidden="true"><path d="M-1 0H16A16 16 0 0 0 0 16H-1Z"/><path class="notch__arc" d="M16 0.5A15.5 15.5 0 0 0 -0.5 16"/></svg>',
    tl: '<svg class="notch__wing notch__wing--tl" viewBox="0 0 17 16" aria-hidden="true"><path d="M17 0H0A16 16 0 0 1 16 16H17Z"/><path class="notch__arc" d="M0 0.5A15.5 15.5 0 0 1 16.5 16"/></svg>',
    bl: '<svg class="notch__wing notch__wing--bl" viewBox="0 -1 16 17" aria-hidden="true"><path d="M0 -1H16V0A16 16 0 0 0 0 16Z"/><path class="notch__arc" d="M16 -0.5A16.5 16.5 0 0 0 0.5 16"/></svg>',
    br: '<svg class="notch__wing notch__wing--br" viewBox="0 -1 16 17" aria-hidden="true"><path d="M16 -1H0V0A16 16 0 0 1 16 16Z"/><path class="notch__arc" d="M0 -0.5A16.5 16.5 0 0 1 15.5 16"/></svg>'
  };

  function M() { return BS.motion; }
  function reduced() { return M() ? M().reduced() : false; }
  function scale(ms) { return M() ? M().scale(ms) : ms; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function ico(n, o) { return BS.icon ? BS.icon(n, o) : '<i data-lucide="' + n + '"></i>'; }
  function mark(size) { return BS.mark ? BS.mark("A", size) : ""; }
  function toast(o) { if (BS.toast) BS.toast(o); }

  var refs = null, opts = null, current = null, spaces = [];

  function itemHtml(n, ink) {
    var inner = "<span>" + esc(n.label) + "</span>";
    if (ink) return '<span class="notch__item" data-label="' + esc(n.label) + '" data-site-nav="' + n.id + '">' + inner + "</span>";
    return '<a class="notch__item" href="' + esc(opts.routes[n.id] || "#") + '" data-label="' + esc(n.label) + '" data-site-nav="' + n.id + '">' + inner + "</a>";
  }

  function navHtml() {
    var glass = opts.nav === "glass";
    var a = opts.action || { label: "Open dashboard", href: (BS.ROUTES && BS.ROUTES.dashboard && BS.ROUTES.dashboard.decisions) || "../D01/index.html" };
    var name = BS.BRAND || "Blindseal";
    var tab = function (cls) { return '<div class="notch notch--' + cls + (glass ? " glass-bar" : "") + '">'; };
    return '<div class="site-notch__row">' +
      tab("logo") + (glass ? "" : WING.tr + WING.bl) +
        '<a class="site-brand" href="' + esc(opts.routes.home) + '" data-site-home aria-label="' + esc(name) + ', home">' + mark(20) + "<span>" + esc(name) + "</span></a>" +
      "</div>" +
      tab("center") + (glass ? "" : WING.tl + WING.tr) +
        '<nav class="notch__items" aria-label="Site"><span class="notch__pill" aria-hidden="true"></span>' +
          NAV.map(function (n) { return itemHtml(n, false); }).join("") +
          '<div class="notch__ink" aria-hidden="true">' + NAV.map(function (n) { return itemHtml(n, true); }).join("") + "</div>" +
        "</nav>" +
      "</div>" +
      tab("actions") + (glass ? "" : WING.tl + WING.br) +
        '<a class="glass-btn primary notch__cta" href="' + esc(a.href) + '" data-site-cta>' + esc(a.label) + "</a>" +
      "</div>" +
    "</div>";
  }

  function footerHtml() {
    var one = (BS.COPY && BS.COPY.oneLiner) || "Protecting agentic finance one pwn at a time.";
    var ver = (BS.VERSION && BS.VERSION.proxy) || "0.4.0";
    return '<footer class="site-footer" aria-label="Site footer">' +
      '<div class="site-footer__brand"><a class="site-brand" href="' + esc(opts.routes.home) + '">' + mark(20) + "<span>" + esc(BS.BRAND || "Blindseal") + "</span></a>" +
        '<p class="site-footer__line">' + esc(one) + "</p></div>" +
      '<nav class="site-footer__routes" aria-label="Footer">' + FOOT.map(function (f) {
        return '<a href="' + esc(opts.routes[f.id] || "#") + '" data-site-foot="' + f.id + '"' + (f.id === opts.active ? ' aria-current="page"' : "") + ">" + esc(f.label) + "</a>";
      }).join("") + "</nav>" +
      '<p class="site-footer__ver">v' + esc(ver) + " · built for 127.0.0.1</p>" +
    "</footer>";
  }

  /* ── the sliding white pill (the shell's mechanics: translate + scaleX on a
     fixed base width, the ink layer clipped to the same rect, 240ms
     out-quint, armed one frame after first paint) ─────────────────────── */
  var pillBase = 0, lastKey = "", glideUntil = 0;
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
      refs.ink.style.clipPath = "inset(" + box[1] + "px " + (W - box[0] - box[2]) + "px " + (H - box[1] - box[3]) + "px " + box[0] + "px round " + (box[3] / 2) + "px)";
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
    measure(!!o.animate && !reduced() && refs.items.classList.contains("is-animated"));
  }

  function wire() {
    refs.notch.addEventListener("click", function (e) {
      var a = e.target.closest("[data-site-nav], [data-site-home], [data-site-cta]");
      if (!a || a.closest(".notch__ink")) return;
      if (opts.navigate) return;                       /* real links: let them load */
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
      e.preventDefault();
      if (a.hasAttribute("data-site-cta")) { toast({ title: "Open dashboard", body: "Opens the local dashboard (D01) at 127.0.0.1:7777.", tone: "info", id: "site-nav" }); return; }
      var id = a.getAttribute("data-site-nav") || "home";
      setActive(id, { animate: true });
      toast({ title: id === "home" ? "Home" : a.textContent, body: "In-place navigation: the pill slides, nothing loads (navigate: false).", tone: "info", id: "site-nav" });
    });
    if ("ResizeObserver" in window) new ResizeObserver(function () { measure(); }).observe(refs.items);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { measure(); });
  }

  var crt = null;
  /* the hero background: data-bg="crt" on the .hero__space (or BS.mountSite({ hero: { background: "crt", crt: {…} } }))
     mounts the CRT field (crt.js, D37); anything else, or no WebGL2, the nebula (D04) */
  function mountCrtHero(host) {
    var hero = opts.hero || {};
    var want = host.getAttribute("data-bg") || hero.background || "nebula";
    if (want !== "crt") return false;
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
      if (host.matches(".hero__space") && mountCrtHero(host)) return;
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

  function setNav(mode) {
    opts.nav = mode === "glass" ? "glass" : "notch";
    refs.notch.className = "site-notch" + (opts.nav === "glass" ? " site-notch--glass" : "");
    document.documentElement.classList.toggle("bs-site-noframe", opts.nav === "glass");
    refs.notch.innerHTML = navHtml();
    refs.items = refs.notch.querySelector(".notch__items");
    refs.pill = refs.notch.querySelector(".notch__pill");
    refs.ink = refs.notch.querySelector(".notch__ink");
    pillBase = 0; lastKey = "";
    if ("ResizeObserver" in window) new ResizeObserver(function () { measure(); }).observe(refs.items);
    setActive(current || opts.active);
  }

  function mountSite(o) {
    if (refs) return BS.site;
    opts = Object.assign({ active: "home", navigate: true, footer: true, space: true, nav: "notch" }, o || {});
    opts.routes = Object.assign({}, DEFAULT_ROUTES, opts.routes || {});
    var html = document.documentElement;
    html.classList.add("bs-site");
    html.classList.toggle("bs-site-noframe", opts.nav === "glass");
    var main = document.getElementById("main-content") || document.querySelector("main");
    if (!main) { main = document.createElement("main"); main.id = "main-content"; document.body.appendChild(main); }
    main.classList.add("site-main");

    var frame = document.createElement("div");
    frame.className = "site-frame"; frame.setAttribute("aria-hidden", "true");
    var notch = document.createElement("header");
    notch.className = "site-notch" + (opts.nav === "glass" ? " site-notch--glass" : "");
    notch.setAttribute("data-site-nav-root", "");
    var skip = document.createElement("a");
    skip.className = "skip-link"; skip.href = "#main-content"; skip.textContent = "Skip to content";
    document.body.insertBefore(notch, document.body.firstChild);
    document.body.insertBefore(frame, notch);
    document.body.insertBefore(skip, frame);
    refs = { notch: notch, frame: frame, main: main };
    notch.innerHTML = navHtml();
    refs.items = notch.querySelector(".notch__items");
    refs.pill = notch.querySelector(".notch__pill");
    refs.ink = notch.querySelector(".notch__ink");
    if (opts.footer) { main.insertAdjacentHTML("beforeend", footerHtml()); refs.footer = main.querySelector(".site-footer"); }
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
    NAV: NAV,
    setActive: function (id, o) { setActive(id, o); },
    setNav: setNav,
    toast: toast,
    mountSpaces: mountSpaces
  };
})();
