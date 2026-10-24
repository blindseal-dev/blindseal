/* The site chrome markup — skip-link, frame, notch (wings, row, items, pill, ink, CTA) and footer —
   as pure template functions, extracted verbatim from site.js (the mockups' _shared/site.js) so the
   SAME strings render on the server (app/site-chrome.tsx) and are known to the kit, which only ADOPTS
   them (site.js: no element is created or inserted into html/head/body). Works as CommonJS and, when
   concatenated into public/kit/kit.js, as window.BS.siteTemplates. */
(function (root, factory) {
  var m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else (root.BS = root.BS || {}).siteTemplates = m;
})(typeof window !== "undefined" ? window : globalThis, function () {
  var NAV = [
    { id: "how", label: "How it works" }, { id: "verify", label: "Verify" }, { id: "docs", label: "Docs" },
    { id: "explorer", label: "Explorer" }, { id: "changelog", label: "Changelog" }
  ];
  var FOOT = [
    { id: "home", label: "Home" }, { id: "how", label: "How it works" }, { id: "verify", label: "Verify" },
    { id: "docs", label: "Docs" }, { id: "explorer", label: "Explorer" }, { id: "changelog", label: "Changelog" }
  ];
  /* the wings: 16×16 concave corners (fill comes from site.css) — each: the canvas fill (extended 1px over
     the tab's hairline) + the arc alone as a 1px --line stroke, which joins the tab outline to the frame's line */
  var WING = {
    tr: '<svg class="notch__wing notch__wing--tr" viewBox="-1 0 17 16" aria-hidden="true"><path d="M-1 0H16A16 16 0 0 0 0 16H-1Z"/><path class="notch__arc" d="M16 0.5A15.5 15.5 0 0 0 -0.5 16"/></svg>',
    tl: '<svg class="notch__wing notch__wing--tl" viewBox="0 0 17 16" aria-hidden="true"><path d="M17 0H0A16 16 0 0 1 16 16H17Z"/><path class="notch__arc" d="M0 0.5A15.5 15.5 0 0 1 16.5 16"/></svg>',
    bl: '<svg class="notch__wing notch__wing--bl" viewBox="0 -1 16 17" aria-hidden="true"><path d="M0 -1H16V0A16 16 0 0 0 0 16Z"/><path class="notch__arc" d="M16 -0.5A16.5 16.5 0 0 0 0.5 16"/></svg>',
    br: '<svg class="notch__wing notch__wing--br" viewBox="0 -1 16 17" aria-hidden="true"><path d="M16 -1H0V0A16 16 0 0 1 16 16Z"/><path class="notch__arc" d="M0 -0.5A16.5 16.5 0 0 1 15.5 16"/></svg>'
  };
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  /* icons.js mark("A", size): the brand mark */
  function mark(size) {
    size = Number(size) || 20;
    var sw = (1.5 * 24 / size).toFixed(3);
    return '<svg xmlns="http://www.w3.org/2000/svg" class="bs-mark bs-mark--A" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + sw +
      '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10.25"/><rect x="7.25" y="10.6" width="9.5" height="2.8" rx="1.4"/></svg>';
  }
  function itemHtml(ctx, n, ink) {
    var inner = "<span>" + esc(n.label) + "</span>";
    if (ink) return '<span class="notch__item" data-label="' + esc(n.label) + '" data-site-nav="' + n.id + '">' + inner + "</span>";
    return '<a class="notch__item" href="' + esc(ctx.routes[n.id] || "#") + '" data-label="' + esc(n.label) + '" data-site-nav="' + n.id + '">' + inner + "</a>";
  }
  /* ctx: { routes: {home,how,verify,docs,explorer,changelog}, brand, action: {label, href}, oneLiner, version } */
  function navHtml(ctx) {
    var a = ctx.action, name = ctx.brand || "Blindseal";
    var tab = function (cls) { return '<div class="notch notch--' + cls + '">'; };
    return '<div class="site-notch__row">' +
      tab("logo") + WING.tr + WING.bl +
        '<a class="site-brand" href="' + esc(ctx.routes.home) + '" data-site-home aria-label="' + esc(name) + ', home">' + mark(20) + "<span>" + esc(name) + "</span></a>" +
      "</div>" +
      tab("center") + WING.tl + WING.tr +
        '<nav class="notch__items" aria-label="Site"><span class="notch__pill" aria-hidden="true"></span>' +
          NAV.map(function (n) { return itemHtml(ctx, n, false); }).join("") +
          '<div class="notch__ink" aria-hidden="true">' + NAV.map(function (n) { return itemHtml(ctx, n, true); }).join("") + "</div>" +
        "</nav>" +
      "</div>" +
      tab("actions") + WING.tl + WING.br +
        '<a class="glass-btn primary notch__cta" href="' + esc(a.href) + '" data-site-cta' + (a.external ? ' target="_blank" rel="noopener"' : "") + '>' + esc(a.label) + "</a>" +
      "</div>" +
    "</div>";
  }
  function footerHtml(ctx) {
    return '<div class="site-footer__brand"><a class="site-brand" href="' + esc(ctx.routes.home) + '">' + mark(20) + "<span>" + esc(ctx.brand || "Blindseal") + "</span></a>" +
        '<p class="site-footer__line">' + esc(ctx.oneLiner) + "</p></div>" +
      '<nav class="site-footer__routes" aria-label="Footer">' + FOOT.map(function (f) {
        return '<a href="' + esc(ctx.routes[f.id] || "#") + '" data-site-foot="' + f.id + '">' + esc(f.label) + "</a>";
      }).join("") + "</nav>";
  }
  return { NAV: NAV, FOOT: FOOT, WING: WING, navHtml: navHtml, footerHtml: footerHtml, mark: mark };
});
