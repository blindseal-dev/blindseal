/* ============================================================================
   _shared/reveal.js — BS.reveal: scroll reveals that fire ONCE (the kit port)
   Blindseal J00: the reveal.js, VERBATIM.
   ----------------------------------------------------------------------------
   The earlier kit's reveal.js re-namespaced FR → BS and slimmed: the helpers it
   used to own (reduced, raf2, wait, drawIn, pause, stagger) now live in
   motion.js (BS.motion, the kit lib port). This file keeps the reveal
   engine and the JS rise. Load it after motion.js.

   Numbers (verbatim): .reveal → rise-16 400ms out-cubic; IntersectionObserver
   rootMargin 0 0 −12% 0 on the SCROLL ROOT (main#main-content in the shell);
   a sweep fallback at 88% of the root's height; .section-head 2nd child
   +0.15s; .reveal.cascade cells rise-14 at .12s + i × 60ms; .stagger
   children +60ms per --i.

   The cover gate: while the shell's route cover is up (.bs-app[data-covered]),
   reveals and rises that fire are queued and released the moment the cover
   starts to lift ("bs:uncover"), so the above-the-fold entrance plays in view
   instead of finishing unseen under the cover. Durations are untouched.

   API: BS.reveal(scope?, {scrollRoot}) → stop()      (= BS.motion.mountReveals)
        BS.motion.rise(targets, {y: 8|10|14|16, dur, delay, stagger, from, now})
        BS.reveal.index(scope)  give .cascade / .stagger children their --i
   ========================================================================== */
(function () {
  "use strict";
  var BS = (window.BS = window.BS || {});
  var M = BS.motion;
  var noop = function () {};
  if (!M) { console.warn("[BS] reveal.js needs motion.js first"); return; }

  function toArray(t) { if (!t) return []; if (t.nodeType === 1) return [t]; return [].slice.call(t); }

  /* .cascade / .stagger children get --i from their position unless markup set it */
  function index(scope) {
    scope = scope || document;
    var groups = scope.querySelectorAll ? scope.querySelectorAll(".cascade, .stagger") : [];
    [].forEach.call(groups, function (g) {
      [].forEach.call(g.children, function (kid, i) {
        if (!kid.style.getPropertyValue("--i")) kid.style.setProperty("--i", String(i));
      });
    });
  }

  function reveal(scope, o) {
    o = o || {};
    scope = scope || document;
    index(scope);
    var sel = ".reveal:not(.is-inview):not([data-reveal-armed])";
    var nodes = [].slice.call(scope.querySelectorAll(sel));
    if (scope.nodeType === 1 && scope.matches(sel)) nodes.unshift(scope);
    if (!nodes.length) return noop;
    nodes.forEach(function (n) { n.setAttribute("data-reveal-armed", ""); });
    if (M.reduced() || !("IntersectionObserver" in window)) {
      nodes.forEach(function (n) { n.classList.add("is-inview"); });
      return noop;
    }
    var sr = M.scrollRoot(o.scrollRoot);
    var queue = [], waiting = false;
    var show = function (n) {
      if (n.classList.contains("is-inview")) return;
      if (M.covered()) {
        queue.push(n);
        if (!waiting) {
          waiting = true;
          M.whenUncovered().then(function () { waiting = false; queue.splice(0).forEach(function (q) { q.classList.add("is-inview"); }); });
        }
        return;
      }
      n.classList.add("is-inview");
    };
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { show(e.target); io.unobserve(e.target); } });
    }, { root: sr, rootMargin: "0px 0px -12% 0px" });
    nodes.forEach(function (n) { io.observe(n); });
    var pend = 0;
    var sweep = function () {
      pend = 0;
      nodes.forEach(function (n) {
        if (!n.classList.contains("is-inview") && M.seen(n, sr)) { show(n); io.unobserve(n); }
      });
    };
    var target = sr || window;
    var onScroll = function () { if (!pend) pend = requestAnimationFrame(sweep); };
    target.addEventListener("scroll", onScroll, { passive: true });
    return function () { io.disconnect(); target.removeEventListener("scroll", onScroll); if (pend) cancelAnimationFrame(pend); };
  }

  /* JS rise: distance by weight (8 inline · 10 copy · 14 cards · 16 sections) */
  function rise(targets, o) {
    o = o || {};
    var els = toArray(targets);
    if (!els.length) return;
    /* the ladder is 8 / 10 / 14 / 16 only: snap anything else to the nearest rung */
    var y = o.y ? [8, 10, 14, 16].reduce(function (a, b) { return Math.abs(b - o.y) < Math.abs(a - o.y) ? b : a; }) : 0;
    var go = function () {
      els.forEach(function (el, i) {
        el.style.setProperty("--i", String((o.from || 0) + i));
        if (o.y) el.style.setProperty("--rise", "rise-" + y);
        if (o.dur != null) el.style.setProperty("--rise-dur", o.dur + "s");
        if (o.delay != null) el.style.setProperty("--rise-delay", o.delay + "s");
        if (o.stagger != null) el.style.setProperty("--rise-stagger", o.stagger + "s");
        M.restart(el, "bs-rise");
      });
    };
    if (M.covered() && !o.now) {
      els.forEach(function (el) { el.style.opacity = "0"; });
      M.whenUncovered().then(function () { els.forEach(function (el) { el.style.opacity = ""; }); go(); });
    } else go();
  }

  reveal.index = index;
  BS.reveal = reveal;
  M.rise = rise;
})();
