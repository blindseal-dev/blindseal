/* ============================================================================
   _shared/space.js — BS.mountSpace(host, { intensity }): the nebula (D04)
   ----------------------------------------------------------------------------
   Fills `host` with .space (absolute, inset 0, overflow hidden, pointer-events
   none, z-index 0 — give the host's content position + z-index 1): the drifting
   nebula, a static feTurbulence grain, a seeded starfield and the bottom fade.
   No video, canvas, WebGL or image file: CSS gradients and two inline SVGs.

     BS.mountSpace(host, {
       intensity: "hero" | "faint",   // faint halves every alpha (default "hero")
       stars: 140,                    // point count
       seed: 7,                       // deterministic positions: stable screenshots
       fade: true                     // the bottom fade to var(--canvas)
     }) → { el, setIntensity(i), stop() }

   The nebula drift (wp-field-drift, 12s) is registered with
   BS.motion.mountPause, so it pauses off screen and in a hidden tab; under
   reduced motion it is static (space.css).
   ========================================================================== */
(function () {
  "use strict";
  var BS = (window.BS = window.BS || {});
  var SVGNS = "http://www.w3.org/2000/svg";
  var uid = 0;

  /* mulberry32: a tiny seeded PRNG, so every load draws the same sky */
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function stars(n, seed) {
    var r = rng(seed), W = 1440, H = 900, out = "", twinkle = 0;
    for (var i = 0; i < n; i++) {
      var x = (r() * W).toFixed(1), y = (r() * H).toFixed(1);
      var big = r() < 0.22;
      var a = (0.35 + r() * 0.55).toFixed(2);
      var tw = twinkle < 12 && r() < 0.14;
      if (tw) twinkle++;
      out += '<circle cx="' + x + '" cy="' + y + '" r="' + (big ? 1.1 : 0.6) + '" style="--a:' + a +
        (tw ? ";--tw:" + (-(twinkle * 0.2)).toFixed(1) + "s" : "") + '"' + (tw ? ' class="is-twinkle"' : "") + "/>";
    }
    return out;
  }

  function mountSpace(host, o) {
    o = o || {};
    if (!host) return null;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    var id = "bs-grain-" + (++uid);
    var el = document.createElement("div");
    el.className = "space";
    el.setAttribute("aria-hidden", "true");
    el.setAttribute("data-intensity", o.intensity === "faint" ? "faint" : "hero");
    if (o.fade === false) el.setAttribute("data-fade", "false");
    el.innerHTML =
      '<div class="space__nebula"></div>' +
      '<svg class="space__grain" xmlns="' + SVGNS + '" aria-hidden="true" focusable="false">' +
        '<filter id="' + id + '" x="0" y="0" width="100%" height="100%">' +
          '<feTurbulence type="fractalNoise" baseFrequency=".8" numOctaves="2" seed="' + (o.seed || 7) + '" stitchTiles="stitch"/>' +
          '<feColorMatrix type="saturate" values="0"/>' +
        "</filter>" +
        '<rect width="100%" height="100%" filter="url(#' + id + ')"/>' +
      "</svg>" +
      '<svg class="space__stars" xmlns="' + SVGNS + '" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">' +
        stars(o.stars || 140, o.seed || 7) +
      "</svg>" +
      '<div class="space__fade"></div>';
    host.insertBefore(el, host.firstChild);
    var stopPause = BS.motion && BS.motion.mountPause ? BS.motion.mountPause(el, { threshold: 0.01, scrollRoot: o.scrollRoot }) : function () {};
    return {
      el: el,
      setIntensity: function (i) { el.setAttribute("data-intensity", i === "faint" ? "faint" : "hero"); },
      stop: function () { stopPause(); el.remove(); }
    };
  }

  BS.mountSpace = mountSpace;
  BS.space = { mount: mountSpace, rng: rng };
})();
