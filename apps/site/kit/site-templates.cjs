/* The site chrome markup — skip-link, frame, nav (the round-2 glass pill, or the round-1 notch) and the phone menu —
   as pure template functions, extracted verbatim from site.js (the mockups' _shared/site.js) so the
   SAME strings render on the server (app/site-chrome.tsx) and are known to the kit, which only ADOPTS
   them (site.js: no element is created or inserted into html/head/body). Works as CommonJS and, when
   concatenated into public/kit/kit.js, as window.BS.siteTemplates.

   ROUND 2 (DECISIONS D39 / D43 / D44 / D47 / D49):
     navHtml(ctx)  ctx.nav "pill" (DEFAULT) — one liquid-glass pill (the reference bar's geometry, measured): the
                   tri-lobe render + "Blindseal" at the left, the five route links with small Lucide icons in
                   the middle (the white sliding pill under the active one, as the notch had it), and ONLY two
                   icon buttons at the right: X and GitHub (new tab). No action button (D49), no dashboard (D47).
                   ctx.nav "notch" — the round-1 notch, unchanged except the mark (the flat tri-lobe now).
     footerHtml()  returns "" (D39: the footer is gone). Kept so callers do not throw; site.css hides an
                   empty .site-footer.
     mark(size)    the FLAT tri-lobe (icons.js mark()), currentColor — under 24 px and the notch.
     markRender(size, ctx)  <img> of the cut-out render (ctx.brandBase + mark-trilobe-64.png).

   ctx: { routes: {home,how,verify,docs,explorer,changelog}, brand, nav: "pill" | "notch",
          brandBase (the brand/ folder URL; default "/kit/brand/"), social: { x, github } (D43 defaults),
          action: {label, href, external} (notch only); oneLiner and npm are no longer read } */
(function (root, factory) {
  var m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else (root.BS = root.BS || {}).siteTemplates = m;
})(typeof window !== "undefined" ? window : globalThis, function () {
  var NAV = [
    { id: "how", label: "How it works", icon: "layers" }, { id: "verify", label: "Verify", icon: "file-check" },
    { id: "docs", label: "Docs", icon: "book-open" }, { id: "explorer", label: "Explorer", icon: "radio" },
    { id: "changelog", label: "Changelog", icon: "git-commit-horizontal" }
  ];
  var FOOT = [
    { id: "home", label: "Home" }, { id: "how", label: "How it works" }, { id: "verify", label: "Verify" },
    { id: "docs", label: "Docs" }, { id: "explorer", label: "Explorer" }, { id: "changelog", label: "Changelog" }
  ];
  /* D43 */
  var SOCIAL = { x: "https://x.com/blindsealtech", github: "https://github.com/blindseal-dev/blindseal" };
  var BRAND_BASE = "/kit/brand/";
  /* the wings: 16×16 concave corners (fill comes from site.css) — each: the canvas fill (extended 1px over
     the tab's hairline) + the arc alone as a 1px --line stroke, which joins the tab outline to the frame's line */
  var WING = {
    tr: '<svg class="notch__wing notch__wing--tr" viewBox="-1 0 17 16" aria-hidden="true"><path d="M-1 0H16A16 16 0 0 0 0 16H-1Z"/><path class="notch__arc" d="M16 0.5A15.5 15.5 0 0 0 -0.5 16"/></svg>',
    tl: '<svg class="notch__wing notch__wing--tl" viewBox="0 0 17 16" aria-hidden="true"><path d="M17 0H0A16 16 0 0 1 16 16H17Z"/><path class="notch__arc" d="M0 0.5A15.5 15.5 0 0 1 16.5 16"/></svg>',
    bl: '<svg class="notch__wing notch__wing--bl" viewBox="0 -1 16 17" aria-hidden="true"><path d="M0 -1H16V0A16 16 0 0 0 0 16Z"/><path class="notch__arc" d="M16 -0.5A16.5 16.5 0 0 0 0.5 16"/></svg>',
    br: '<svg class="notch__wing notch__wing--br" viewBox="0 -1 16 17" aria-hidden="true"><path d="M16 -1H0V0A16 16 0 0 1 16 16Z"/><path class="notch__arc" d="M0 -0.5A16.5 16.5 0 0 1 15.5 16"/></svg>'
  };
  /* the glyphs the nav needs, inlined so the template stays a pure function (lucide 0.575 nodes, as icons.js;
     x-logo and github are the filled brand marks) */
  var GLYPH = {
    "layers": '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>',
    "file-check": '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="m9 15 2 2 4-4"/>',
    "book-open": '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
    "radio": '<path d="M16.247 7.761a6 6 0 0 1 0 8.478"/><path d="M19.075 4.933a10 10 0 0 1 0 14.134"/><path d="M4.925 19.067a10 10 0 0 1 0-14.134"/><path d="M7.753 16.239a6 6 0 0 1 0-8.478"/><circle cx="12" cy="12" r="2"/>',
    "git-commit-horizontal": '<circle cx="12" cy="12" r="3"/><line x1="3" x2="9" y1="12" y2="12"/><line x1="15" x2="21" y1="12" y2="12"/>',
    "x-logo": '<path fill="currentColor" stroke="none" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>',
    "github": '<path fill="currentColor" stroke="none" d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>'
  };
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function glyph(name, cls) {
    return '<svg xmlns="http://www.w3.org/2000/svg" class="lucide lucide-' + name + (cls ? " " + cls : "") + '" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + GLYPH[name] + "</svg>";
  }
  /* icons.js mark(size): the FLAT tri-lobe (D44), traced from the render; evenodd = the centre opening */
  var TRILOBE = "M16.6 .7C15.4 2.5 14.2 5.4 14.2 8.9C14.5 7.4 15 6.1 16 6C19.2 7 22.6 10.6 23.2 15.4C23.6 18.4 22.8 21.4 21.5 23.3" +
    "C20.6 21.4 19 19.4 17.25 18.6C16 21.2 13 23.2 9.8 23.1C5.6 23 2.4 18.8 .7 14.1C2.2 14.3 3.8 14.6 5.35 14.4" +
    "C3.9 11 3.8 7.6 6.2 5.2C9 2.6 13 1.1 16.6 .7Z" +
    "M11.55 12.7C11.7 14.3 12 15.8 12.65 16.8C13.9 16.2 15.4 15.3 16.25 14.2C14.8 13.4 13.2 12.9 11.55 12.7Z";
  function mark(size) {
    size = Number(size) || 20;
    return '<svg xmlns="http://www.w3.org/2000/svg" class="bs-mark bs-mark--trilobe" width="' + size + '" height="' + size +
      '" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path fill-rule="evenodd" d="' + TRILOBE + '"/></svg>';
  }
  /* icons.js markRender(size): the cut-out render; 64 px covers 2× screens up to 32 */
  function markRender(size, ctx) {
    size = Number(size) || 30;
    var base = (ctx && ctx.brandBase) || BRAND_BASE;
    var file = size <= 16 ? "mark-trilobe-32.png" : size <= 32 ? "mark-trilobe-64.png" : "mark-trilobe.png";
    return '<img class="bs-mark-render" src="' + esc(base + file) + '" width="' + size + '" height="' + size + '" alt="" aria-hidden="true" decoding="async" draggable="false">';
  }
  function social(ctx) { var s = (ctx && ctx.social) || {}; return { x: s.x || SOCIAL.x, github: s.github || SOCIAL.github }; }

  /* ── round 1: the notch (ctx.nav === "notch") ─────────────────────────── */
  function notchItemHtml(ctx, n, ink) {
    var inner = "<span>" + esc(n.label) + "</span>";
    if (ink) return '<span class="notch__item" data-label="' + esc(n.label) + '" data-site-nav="' + n.id + '">' + inner + "</span>";
    return '<a class="notch__item" href="' + esc(ctx.routes[n.id] || "#") + '" data-label="' + esc(n.label) + '" data-site-nav="' + n.id + '">' + inner + "</a>";
  }
  function notchHtml(ctx) {
    var a = ctx.action || { label: "GitHub", href: social(ctx).github, external: true }, name = ctx.brand || "Blindseal";
    var tab = function (cls) { return '<div class="notch notch--' + cls + '">'; };
    return '<div class="site-notch__row">' +
      tab("logo") + WING.tr + WING.bl +
        '<a class="site-brand" href="' + esc(ctx.routes.home) + '" data-site-home aria-label="' + esc(name) + ', home">' + mark(20) + "<span>" + esc(name) + "</span></a>" +
      "</div>" +
      tab("center") + WING.tl + WING.tr +
        '<nav class="notch__items" aria-label="Site"><span class="notch__pill" aria-hidden="true"></span>' +
          NAV.map(function (n) { return notchItemHtml(ctx, n, false); }).join("") +
          '<div class="notch__ink" aria-hidden="true">' + NAV.map(function (n) { return notchItemHtml(ctx, n, true); }).join("") + "</div>" +
        "</nav>" +
      "</div>" +
      tab("actions") + WING.tl + WING.br +
        '<a class="glass-btn primary notch__cta" href="' + esc(a.href) + '" data-site-cta' + (a.external ? ' target="_blank" rel="noopener"' : "") + '>' + esc(a.label) + "</a>" +
        /* phone width only (< 720 px, app/narrow.css): the menu button; display:none on desktop */
        '<button type="button" class="notch__menu" data-site-menu-btn aria-expanded="false" aria-controls="site-menu" aria-label="Menu"><span class="notch__menu-bars" aria-hidden="true"></span></button>' +
      "</div>" +
    "</div>" +
    menuHtml(ctx);
  }

  /* ── round 2: the glass pill (default) ─────────────────────────────────
     .nav-pill.glass-bar (the only glass) > brand · nav.notch__items (the white pill + ink layer: the notch's
     mechanics, so site.js's measure() is shared) · .nav-pill__actions (two .glass-item icon buttons: glass
     inside glass frosts nothing, MASTER §5). Each link: the icon + a label whose ::after reserves the strong
     weight's width, so the active label never shifts its row. */
  function pillItemHtml(ctx, n, ink) {
    var inner = glyph(n.icon, "nav-pill__ico") + '<span class="nav-pill__label" data-label="' + esc(n.label) + '"><span>' + esc(n.label) + "</span></span>";
    if (ink) return '<span class="notch__item nav-pill__item" data-site-nav="' + n.id + '">' + inner + "</span>";
    return '<a class="notch__item nav-pill__item" href="' + esc(ctx.routes[n.id] || "#") + '" data-site-nav="' + n.id + '">' + inner + "</a>";
  }
  function pillHtml(ctx) {
    var name = ctx.brand || "Blindseal", s = social(ctx);
    return '<div class="nav-pill glass-bar" data-nav="pill">' +
      '<a class="site-brand nav-pill__brand" href="' + esc(ctx.routes.home) + '" data-site-home aria-label="' + esc(name) + ', home">' +
        markRender(30, ctx) + "<span>" + esc(name) + "</span></a>" +
      '<nav class="notch__items nav-pill__links" aria-label="Site"><span class="notch__pill" aria-hidden="true"></span>' +
        NAV.map(function (n) { return pillItemHtml(ctx, n, false); }).join("") +
        '<div class="notch__ink" aria-hidden="true">' + NAV.map(function (n) { return pillItemHtml(ctx, n, true); }).join("") + "</div>" +
      "</nav>" +
      '<div class="nav-pill__actions">' +
        '<a class="glass-item nav-pill__icon nav-pill__icon--x" href="' + esc(s.x) + '" target="_blank" rel="noopener" data-site-social="x" aria-label="Blindseal on X (opens in a new tab)">' + glyph("x-logo") + "</a>" +
        '<a class="glass-item nav-pill__icon nav-pill__icon--github" href="' + esc(s.github) + '" target="_blank" rel="noopener" data-site-social="github" aria-label="Blindseal on GitHub (opens in a new tab)">' + glyph("github") + "</a>" +
        /* phone width only (< 720 px): the menu button; display:none on desktop */
        '<button type="button" class="notch__menu" data-site-menu-btn aria-expanded="false" aria-controls="site-menu" aria-label="Menu"><span class="notch__menu-bars" aria-hidden="true"></span></button>' +
      "</div>" +
    "</div>" +
    menuHtml(ctx);
  }
  /* ctx.nav: "pill" (default, round 2) | "notch" (round 1) — a pure function of ctx either way */
  function navHtml(ctx) { ctx = ctx || {}; return ctx.nav === "notch" ? notchHtml(ctx) : pillHtml(ctx); }

  /* the phone menu: a disclosure (the button carries aria-expanded / aria-controls; no aria-modal, so the button
     stays reachable to a screen reader) — a full-screen sheet under the header row, listing the five routes and,
     on the pill, X and GitHub (the notch: its action). Server-rendered with the rest of the chrome, [hidden] until
     the menu button opens it (wired by app/site-menu.tsx, a client component — never created by the kit).
     display:none on desktop. */
  var EXT = '<svg class="site-menu__ext" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M7 17 17 7M8 7h9v9"/></svg>';
  function menuHtml(ctx) {
    var tail;
    if (ctx.nav === "notch") {
      var a = ctx.action || { label: "GitHub", href: social(ctx).github, external: true };
      tail = '<li><a class="site-menu__item site-menu__item--ext" href="' + esc(a.href) + '"' + (a.external ? ' target="_blank" rel="noopener"' : "") + ">" + esc(a.label) + EXT + "</a></li>";
    } else {
      var s = social(ctx), ext = function (label, href) {
        return '<li><a class="site-menu__item site-menu__item--ext" href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(label) + '<span class="sr-only"> (opens in a new tab)</span>' + EXT + "</a></li>";
      };
      tail = ext("X", s.x) + ext("GitHub", s.github);
    }
    return '<div class="site-menu" id="site-menu" data-site-menu hidden>' +
      '<nav class="site-menu__nav" aria-label="Site menu"><ul class="site-menu__list">' +
        NAV.map(function (n) {
          return '<li><a class="site-menu__item" href="' + esc(ctx.routes[n.id] || "#") + '" data-site-menu-link="' + n.id + '">' + esc(n.label) + "</a></li>";
        }).join("") +
        tail +
      "</ul></nav></div>";
  }
  /* D39: no footer — the page ends on its last section. Kept as a function (it returns "") so a layout that
     still calls it does not throw; site.css hides the empty .site-footer wrapper, so no empty landmark is
     exposed. The port drops <SiteFooter /> from app/layout.tsx. */
  function footerHtml() { return ""; }
  return { NAV: NAV, FOOT: FOOT, WING: WING, SOCIAL: SOCIAL, BRAND_BASE: BRAND_BASE, GLYPH: GLYPH, TRILOBE: TRILOBE,
    navHtml: navHtml, pillHtml: pillHtml, notchHtml: notchHtml, menuHtml: menuHtml, footerHtml: footerHtml, mark: mark, markRender: markRender, glyph: glyph };
});
