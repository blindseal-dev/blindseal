/* ============================================================================
   _shared/glass.js — the liquid glass's moving parts (classic script, no deps)
   ----------------------------------------------------------------------------
   Port of (the kit)/_shared/glass.js (topnav.js), ids fr- → bs-:
   1. Injects the SVG refraction filters once:
        #bs-lg-refract     feTurbulence fractalNoise 0.012 0.014, 2 octaves,
                           seed 7 → gaussian blur 3 → displacement 34
                           (bars, sheet header, menus, toasts)
        #bs-lg-refract-sm  the same at displacement 14 (24–40px controls;
                           34 tears a 40px button apart)
   2. Decorates every glass element with three sheen spans (top / streak /
      edges) + the .glass-glow rim as its first children; .glass-item gets the
      rim only. A MutationObserver decorates anything added later, before
      paint, so page scripts never call anything.
   3. Paints the cursor-proximity rim (the shell's maths, verbatim):
      t = max(0, 1 − distance/120), opacity = t²·0.5, mask = an 80px radial
      gradient at the cursor. rAF-throttled, passive listeners, fine pointers.
      The rim colour is var(--tn-glow-rim) = the accent.

   API: BS.glass.decorate(root?) · BS.glass.SELECTOR · BS.glass.paint(x, y)
   ========================================================================== */
(function () {
  "use strict";
  var BS = (window.BS = window.BS || {});

  var SELECTOR = ".glass, .glass-btn, .glass-pill, .glass-seg, .glass-bar, .glass-head, .glass-menu, .glass-toast, .glass-dock";
  var ITEM_SELECTOR = ".glass-item";
  var ALL = SELECTOR + ", " + ITEM_SELECTOR;
  var GLOW_RADIUS = 120;
  var GLOW_MASK = 80;

  function filter(id, scale) {
    return '<filter id="' + id + '" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">' +
      '<feTurbulence type="fractalNoise" baseFrequency="0.012 0.014" numOctaves="2" seed="7" result="noise"></feTurbulence>' +
      '<feGaussianBlur in="noise" stdDeviation="3" result="soft"></feGaussianBlur>' +
      '<feDisplacementMap in="SourceGraphic" in2="soft" scale="' + scale + '" xChannelSelector="R" yChannelSelector="G"></feDisplacementMap>' +
      "</filter>";
  }
  function ensureDefs() {
    if (document.getElementById("bs-glass-defs") || !document.body) return;
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.id = "bs-glass-defs";
    svg.setAttribute("class", "bs-glass-defs");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.innerHTML = "<defs>" + filter("bs-lg-refract", 34) + filter("bs-lg-refract-sm", 14) + "</defs>";
    document.body.insertBefore(svg, document.body.firstChild);
  }

  var glows = new Set();
  function decorateOne(el) {
    if (el.hasAttribute("data-glass")) return;
    el.setAttribute("data-glass", "");
    var frag = document.createDocumentFragment();
    (el.matches(ITEM_SELECTOR) ? [] : ["top", "streak", "edges"]).forEach(function (k) {
      var s = document.createElement("span");
      s.className = "glass-sheen glass-sheen--" + k;
      s.setAttribute("aria-hidden", "true");
      frag.appendChild(s);
    });
    var g = document.createElement("span");
    g.className = "glass-glow";
    g.setAttribute("aria-hidden", "true");
    frag.appendChild(g);
    el.insertBefore(frag, el.firstChild);
    glows.add(g);
  }
  function decorate(root) {
    root = root || document;
    if (root.nodeType === 1 && root.matches && root.matches(ALL)) decorateOne(root);
    if (root.querySelectorAll) [].forEach.call(root.querySelectorAll(ALL), decorateOne);
  }

  var fine = !window.matchMedia || matchMedia("(hover: hover) and (pointer: fine)").matches;
  var pending = 0;
  function paint(x, y) {
    var vh = window.innerHeight, vw = window.innerWidth;
    glows.forEach(function (o) {
      if (!o.isConnected) { glows.delete(o); return; }
      var r = o.parentElement.getBoundingClientRect();
      if (!r.width || r.bottom < -GLOW_RADIUS || r.top > vh + GLOW_RADIUS || r.right < -GLOW_RADIUS || r.left > vw + GLOW_RADIUS) {
        if (o.style.opacity !== "0") o.style.opacity = "0";
        return;
      }
      var dx = Math.max(0, r.left - x, x - r.right);
      var dy = Math.max(0, r.top - y, y - r.bottom);
      var t = Math.max(0, 1 - Math.hypot(dx, dy) / GLOW_RADIUS);
      o.style.opacity = String(t * t * 0.5);
      if (t > 0) {
        var mask = "radial-gradient(" + GLOW_MASK + "px circle at " + (x - r.left) + "px " + (y - r.top) + "px, black, transparent)";
        o.style.maskImage = mask;
        o.style.webkitMaskImage = mask;
      }
    });
  }
  function wireGlow() {
    if (!fine) return;
    document.addEventListener("mousemove", function (e) {
      if (pending) cancelAnimationFrame(pending);
      var x = e.clientX, y = e.clientY;
      pending = requestAnimationFrame(function () { pending = 0; paint(x, y); });
    }, { passive: true });
    document.addEventListener("mouseleave", function () { glows.forEach(function (o) { o.style.opacity = "0"; }); });
  }

  function boot() {
    ensureDefs();
    decorate(document);
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j++) if (added[j].nodeType === 1) decorate(added[j]);
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
    wireGlow();
  }

  BS.glass = { decorate: decorate, SELECTOR: SELECTOR, ITEM_SELECTOR: ITEM_SELECTOR, ensureDefs: ensureDefs, paint: paint };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
