/* ============================================================================
   _shared/motion.js — BS.motion: the house motion library, vanilla
   Blindseal J00: the motion.js, VERBATIM, re-namespaced
   (PF.motion → BS.motion, pf-js → bs-js, pf:motion → bs:motion, pf:uncover →
   bs:uncover, PF_NOW → BS_NOW, storage key pf-motion → bs-motion).
   ----------------------------------------------------------------------------
   A 1:1 port of (reference study)/lib-motion (reduced.ts, stagger.ts, observe.tsx,
   odometer.tsx, transition.ts, tokens.ts) with ONE structural change from the
   the kit: every observer binds to the SCROLL ROOT. The shell never scrolls
   the window, only main#main-content, so a viewport observer would see
   nothing. No animation library of any kind; WAAPI only in staggerFade().

   Load it in <head> (after constants.js): it marks html.bs-js (the reveal
   gate) and writes html[data-motion] before first paint.

   API (window.BS.motion):
     reduced()                → bool: OS setting OR the override ("reduce")
     mode() / setMode(m)      "system" | "reduce" | "full" | "slow" (session,
                              ?motion=… for QA); fires "bs:motion"
     scale(ms)                ms × 4 in slow-mo
     wait(ms)                 Promise (scaled; 0ms when reduced)
     raf2(fn)                 the load-bearing double rAF
     syncMotionAttr()         html[data-motion] = reduce | slow | (absent);
                              slow-mo = playbackRate .25 on every animation
     staggerFade(el, {duration, gap, start}) → cancel()   the ONE WAAPI call
     mountReveals(scope)      → stop()   (engine in reveal.js)
     mountDrawIn(el)          → stop()   .is-armed → 2×rAF → .is-drawn
     redraw(el)               replay a draw-in
     mountPause(el)           → stop()   .is-paused off screen / hidden tab
     restart(el, cls)         re-trigger a class animation
     enterRow(el)             row-in 320ms out-expo, flag held 400ms
     flash(el)                row-flash 2.4s on the accent 16%
     cardIn(container)        card-in on the children, 45ms × min(i,11)
     odometer(el, value, {mode: "roll"|"tick", format}) → { el, set(v), value() }
     createRouteTransition(host) → { show(), cover(), hide({quick, hold}), first, visible }
     whenUncovered()          Promise: resolves when no route cover is up
     scrollRoot()             the element observers bind to (or null = viewport)
     EASE, DUR, ROUTE, ODOMETER, ROW, STAGGER_FADE   the JS mirror of §14
   ========================================================================== */
(function () {
  "use strict";
  var BS = (window.BS = window.BS || {});
  var root = document.documentElement;
  var noop = function () {};
  root.classList.add("bs-js");

  /* ── tokens (lib-motion/tokens.ts; change tokens.css §14 with them) ───── */
  var EASE = {
    inOut: "cubic-bezier(0.4, 0, 0.2, 1)",
    outCubic: "cubic-bezier(0.215, 0.61, 0.355, 1)",
    outExpo: "cubic-bezier(0.16, 1, 0.3, 1)",
    outQuint: "cubic-bezier(0.22, 1, 0.36, 1)",
    inQuick: "cubic-bezier(0.4, 0, 1, 1)",
    outQuad: "cubic-bezier(0.25, 0.46, 0.45, 0.94)"
  };
  var DUR = { fast: 150, base: 200, d120: 120, d140: 140, d150: 150, d160: 160, d180: 180, d200: 200, d220: 220, d240: 240,
    d260: 260, d320: 320, d340: 340, d360: 360, d400: 400, d420: 420, d450: 450, d480: 480, d550: 550, d600: 600,
    d700: 700, d750: 750, d900: 900, d1100: 1100, d1800: 1800, d2400: 2400 };
  /* route cover — brief numbers: first paint instant / hold 650 / out 420; page→page in 180 / hold 100 / out 240 */
  var ROUTE = { in: 180, holdFirst: 650, hold: 100, out: 420, outQuick: 240 };
  var ODOMETER = { tickOut: 160, tickIn: 220, cleanup: 400, roll: 360 };
  var ROW = { enter: 400, flash: 2500 };
  var STAGGER_FADE = { duration: 220, gap: 0.7, start: 220 };

  /* ── mode: system | reduce | full | slow ─────────────────────────────── */
  var MODE_KEY = "bs-motion";
  var mq = window.matchMedia ? matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  var mode = "system";
  try {
    var q = /[?&]motion=(reduce|full|slow|system)\b/.exec(location.search || "");
    mode = q ? q[1] : (sessionStorage.getItem(MODE_KEY) || "system");
  } catch (e) { mode = "system"; }
  if (!/^(system|reduce|full|slow)$/.test(mode)) mode = "system";

  function reduced() { return mode === "reduce" || (mode === "system" && !!mq.matches); }
  function scale(ms) { return ms * (mode === "slow" ? 4 : 1); }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, reduced() ? 0 : scale(ms)); }); }
  function raf2(fn) { return requestAnimationFrame(function () { requestAnimationFrame(fn); }); }

  var slowLoop = 0;
  function syncMotionAttr() {
    if (reduced()) root.dataset.motion = "reduce";
    else if (mode === "slow") root.dataset.motion = "slow";
    else delete root.dataset.motion;
    cancelAnimationFrame(slowLoop);
    var rate = mode === "slow" && !reduced() ? 0.25 : 1;
    var apply = function () {
      try { document.getAnimations().forEach(function (a) { if (a.playbackRate !== rate) a.playbackRate = rate; }); } catch (e) { /* noop */ }
    };
    apply();
    if (rate !== 1) {
      var loop = function () { apply(); slowLoop = requestAnimationFrame(loop); };
      slowLoop = requestAnimationFrame(loop);
    }
  }
  function setMode(m) {
    if (!/^(system|reduce|full|slow)$/.test(m)) return;
    mode = m;
    try { if (m === "system") sessionStorage.removeItem(MODE_KEY); else sessionStorage.setItem(MODE_KEY, m); } catch (e) {}
    syncMotionAttr();
    document.dispatchEvent(new CustomEvent("bs:motion", { detail: { mode: m, reduced: reduced() } }));
  }
  var booted = false;
  function boot() {   /* nothing runs at load; the site calls BS.motion.boot() first in its mount sequence */
    if (booted) return; booted = true;
    syncMotionAttr();
    if (mq.addEventListener) mq.addEventListener("change", function () { syncMotionAttr(); document.dispatchEvent(new CustomEvent("bs:motion", { detail: { mode: mode, reduced: reduced() } })); });
  }

  /* ── scroll root + route-cover gate ──────────────────────────────────── */
  function scrollRoot(explicit) {
    if (explicit !== undefined) return explicit;
    var m = document.getElementById("main-content");
    if (!m) return null;
    var oy = getComputedStyle(m).overflowY;
    return (oy === "auto" || oy === "scroll") ? m : null;
  }
  function covered() { return root.hasAttribute("data-covered"); }
  function whenUncovered() {
    if (!covered()) return Promise.resolve();
    return new Promise(function (r) { document.addEventListener("bs:uncover", function () { r(); }, { once: true }); });
  }
  /* the sweep fallback: anything above 88% of the root counts as seen */
  function seen(el, sr) {
    var top = 0, h = window.innerHeight;
    if (sr) { var r = sr.getBoundingClientRect(); top = r.top; h = r.height; }
    return el.getBoundingClientRect().top < top + h * 0.88;
  }

  /* ── staggerFade: the kit useStaggerFade, the ONE WAAPI call ─────────── */
  function staggerFade(el, o) {
    o = o || {};
    if (!el || reduced()) return noop;
    var duration = o.duration == null ? STAGGER_FADE.duration : o.duration;
    var gap = o.gap == null ? STAGGER_FADE.gap : o.gap;
    var start = o.start == null ? STAGGER_FADE.start : o.start;
    var anims = [].slice.call(el.children).map(function (kid, i) {
      return kid.animate([{ opacity: 0 }, { opacity: 1 }], { duration: duration, delay: start + gap * i, easing: EASE.outQuad, fill: "backwards" });
    });
    if (mode === "slow") anims.forEach(function (a) { a.playbackRate = 0.25; });
    return function () { anims.forEach(function (a) { a.cancel(); }); };
  }

  /* ── reveals: the engine lives in reveal.js (BS.reveal) ───────────────── */
  function mountReveals(scope, o) {
    if (BS.reveal) return BS.reveal(scope, o);
    /* reveal.js not loaded: show everything, never leave content hidden */
    [].forEach.call((scope || document).querySelectorAll(".reveal"), function (n) { n.classList.add("is-inview"); });
    return noop;
  }

  /* ── SVG draw-in (two-phase: .is-armed → double rAF → .is-drawn) ─────── */
  function mountDrawIn(el, o) {
    o = o || {};
    if (!el) return noop;
    el.classList.add("is-armed");
    if (reduced() || !("IntersectionObserver" in window)) { el.classList.add("is-drawn"); return noop; }
    var sr = scrollRoot(o.scrollRoot);
    var done = false;
    var draw = function () {
      if (done) return; done = true; stop();
      whenUncovered().then(function () { raf2(function () { el.classList.add("is-drawn"); }); });
    };
    var io = new IntersectionObserver(function (es) { if (es.some(function (e) { return e.isIntersecting; })) draw(); },
      { root: sr, rootMargin: o.rootMargin || "0px 0px -12% 0px" });
    var target = sr || window;
    var onScroll = function () { if (seen(el, sr)) draw(); };
    var stop = function () { io.disconnect(); target.removeEventListener("scroll", onScroll); };
    io.observe(el);
    target.addEventListener("scroll", onScroll, { passive: true });
    return stop;
  }
  function redraw(el) {
    if (!el || reduced()) return;
    el.classList.add("is-nofx"); el.classList.remove("is-drawn");
    requestAnimationFrame(function () { el.classList.remove("is-nofx"); raf2(function () { el.classList.add("is-drawn"); }); });
  }

  /* ── ambient loops pause off screen / in a hidden tab ─────────────────── */
  function mountPause(el, o) {
    o = o || {};
    if (!el) return noop;
    var onScreen = true;
    var apply = function () { el.classList.toggle("is-paused", !onScreen || document.hidden); };
    var io = ("IntersectionObserver" in window) ? new IntersectionObserver(function (es) {
      onScreen = es[es.length - 1].intersectionRatio >= (o.threshold || 0.25); apply();
    }, { root: scrollRoot(o.scrollRoot), threshold: [0, o.threshold || 0.25, 1] }) : null;
    if (io) io.observe(el);
    document.addEventListener("visibilitychange", apply);
    apply();
    return function () { if (io) io.disconnect(); document.removeEventListener("visibilitychange", apply); el.classList.remove("is-paused"); };
  }

  /* ── one-shot class animations ────────────────────────────────────────── */
  function restart(el, cls) { if (!el) return; el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }
  function enterRow(el) {
    if (!el || reduced()) return;
    restart(el, "is-entering-row");
    setTimeout(function () { el.classList.remove("is-entering-row"); }, scale(ROW.enter));
  }
  function flash(el) {
    if (!el || reduced()) return;
    restart(el, "is-flash");
    setTimeout(function () { el.classList.remove("is-flash"); }, scale(ROW.flash));
  }
  /* the card-in across a grid's children (sort / filter / first paint) */
  function cardIn(container, o) {
    o = o || {};
    if (!container) return;
    var kids = [].slice.call(o.selector ? container.querySelectorAll(o.selector) : container.children);
    kids.forEach(function (k, i) { k.style.setProperty("--i", String(i)); k.classList.remove("card-in"); });
    if (reduced()) return;
    void container.offsetWidth;
    kids.forEach(function (k) { k.classList.add("card-in"); });
  }

  /* ── odometers (lib-motion/odometer.tsx, verbatim logic) ──────────────── */
  var DIGIT = /\d/;
  function skeletonOf(v) { return String(v).replace(/[\d.,]/g, ""); }
  function decimalsOf(v) {
    var head = String(v).split(" ")[0], d = head.indexOf(".");
    if (d < 0) return 0;
    var digits = head.replace(/[^\d.]/g, "");
    return digits.length - digits.indexOf(".") - 1;
  }
  function padTo(v, places) {
    var str = String(v); if (!places) return str;
    var sp = str.indexOf(" ");
    var num = sp < 0 ? str : str.slice(0, sp), suffix = sp < 0 ? "" : str.slice(sp);
    if (!/\d/.test(num)) return str;
    var m = /^(.*?)(\d[\d,]*)(?:\.(\d*))?(.*)$/.exec(num); if (!m) return str;
    var frac = m[3] || ""; while (frac.length < places) frac += "0";
    return m[1] + m[2] + "." + frac + m[4] + suffix;
  }
  function srTwin(text) { var s = document.createElement("span"); s.className = "sr-only"; s.textContent = text; return s; }

  /* roll: the price ticker — ONLY changed digits roll DOWN, 0.36s out-quint */
  function createPriceTicker(host, initial) {
    var start = initial == null ? "" : String(initial);
    host.classList.add("price-ticker"); host.textContent = "";
    var sr = srTwin(start);
    var cells = document.createElement("span"); cells.className = "price-ticker__cells"; cells.setAttribute("aria-hidden", "true");
    host.appendChild(sr); host.appendChild(cells);
    var places = decimalsOf(start), prev = start;
    function set(value) {
      var raw = String(value == null ? "" : value);
      if (skeletonOf(raw) !== skeletonOf(prev)) places = decimalsOf(raw); else places = Math.max(places, decimalsOf(raw), decimalsOf(prev));
      var next = padTo(raw, places), last = padTo(prev, places);
      sr.textContent = next; cells.textContent = "";
      var roll = !reduced() && next.length === last.length;
      for (var i = 0; i < next.length; i++) {
        var ch = next[i], old = last[i];
        if (roll && DIGIT.test(ch) && old != null && DIGIT.test(old) && ch !== old) {
          var digit = document.createElement("span"); digit.className = "price-digit";
          var track = document.createElement("span"); track.className = "price-digit__track";
          var a = document.createElement("span"); a.textContent = ch;   /* NEW, above */
          var b = document.createElement("span"); b.textContent = old;  /* OLD, below */
          track.appendChild(a); track.appendChild(b); digit.appendChild(track); cells.appendChild(digit);
        } else { var s = document.createElement("span"); s.textContent = ch; cells.appendChild(s); }
      }
      prev = raw;
    }
    set(start);
    return { set: set, value: function () { return prev; } };
  }

  /* tick: the odometer — cells keyed from the RIGHT roll UP; out 160 in-quick, in 220 out-expo */
  function createTicking(host, initial) {
    var start = initial == null ? "" : String(initial);
    host.classList.add("ticking"); host.textContent = "";
    var sr = srTwin(start);
    var cells = document.createElement("span"); cells.className = "ticking__cells"; cells.setAttribute("aria-hidden", "true");
    host.appendChild(sr); host.appendChild(cells);
    var chars = [], prevT = start;
    var makeCell = function () { var c = document.createElement("span"); c.className = "ticking__cell"; var i = document.createElement("span"); i.className = "ticking__in"; c.appendChild(i); return c; };
    function set(value) {
      var raw = String(value == null ? "" : value);
      var next = raw.split("");
      sr.textContent = raw;
      while (chars.length < next.length) { cells.insertBefore(makeCell(), cells.firstChild); chars.unshift(null); }
      while (chars.length > next.length) { cells.removeChild(cells.firstElementChild); chars.shift(); }
      var still = reduced();
      [].forEach.call(cells.children, function (cell, idx) {
        var ch = next[idx]; if (chars[idx] === ch) return;
        var was = chars[idx]; chars[idx] = ch;
        var inEl = cell.querySelector(".ticking__in");
        if (was == null || was === "" || still) { inEl.textContent = ch; var o0 = cell.querySelector(".ticking__out"); if (o0) o0.remove(); return; }
        var o1 = cell.querySelector(".ticking__out"); if (o1) o1.remove();
        var out = document.createElement("span"); out.className = "ticking__out"; out.textContent = was; cell.appendChild(out);
        inEl.textContent = ch;
        restart(inEl, "ticking__in");
        setTimeout(function () { out.remove(); }, scale(ODOMETER.cleanup));
      });
      prevT = raw;
    }
    set(start);
    return { set: set, value: function () { return prevT; } };
  }

  /** Imperative odometer: nothing moves until set() receives a different value. */
  function odometer(el, value, o) {
    o = o || {};
    var format = o.format || function (v) { return String(v); };
    el.classList.add("odo");
    var t = o.mode === "tick" ? createTicking(el, format(value)) : createPriceTicker(el, format(value));
    var cur = value;
    return { el: el, set: function (v) { if (v === cur) return; cur = v; t.set(format(v)); }, value: function () { return cur; } };
  }

  /* ── the route loading surface (transition.ts, brief numbers) ─────────── */
  function createRouteTransition(host) {
    var first = true, timer = 0;
    var on = function () { host.classList.add("is-visible"); host.setAttribute("aria-hidden", "false"); };
    return {
      /* fade in (180ms); resolves once opaque, so the swap underneath is never seen */
      show: function () {
        clearTimeout(timer);
        host.classList.remove("is-quick");
        on();
        return new Promise(function (r) { setTimeout(r, reduced() ? 0 : scale(ROUTE.in)); });
      },
      /* up instantly (first paint, Back / Forward) */
      cover: function () {
        clearTimeout(timer);
        host.style.transition = "none";
        on();
        void host.offsetWidth;
        requestAnimationFrame(function () { host.style.transition = ""; });
      },
      /* hold (650 first paint / 100 after), then fade out (420, or 240 quick) */
      hide: function (o) {
        o = o || {};
        var hold = reduced() ? 0 : scale(o.hold != null ? o.hold : (first ? ROUTE.holdFirst : ROUTE.hold));
        first = false;
        clearTimeout(timer);
        return new Promise(function (r) {
          timer = setTimeout(function () {
            host.classList.toggle("is-quick", !!o.quick);
            host.classList.remove("is-visible"); host.setAttribute("aria-hidden", "true");
            r();
          }, hold);
        });
      },
      get first() { return first; },
      get visible() { return host.classList.contains("is-visible"); }
    };
  }

  BS.motion = { boot: boot, 
    reduced: reduced, mode: function () { return mode; }, setMode: setMode,
    scale: scale, wait: wait, raf2: raf2, syncMotionAttr: syncMotionAttr,
    staggerFade: staggerFade, mountReveals: mountReveals, mountDrawIn: mountDrawIn, redraw: redraw,
    mountPause: mountPause, restart: restart, enterRow: enterRow, flash: flash, cardIn: cardIn,
    odometer: odometer, createPriceTicker: createPriceTicker, createTicking: createTicking,
    createRouteTransition: createRouteTransition,
    whenUncovered: whenUncovered, covered: covered, scrollRoot: function (x) { return scrollRoot(x); }, seen: seen,
    EASE: EASE, DUR: DUR, ROUTE: ROUTE, ODOMETER: ODOMETER, ROW: ROW, STAGGER_FADE: STAGGER_FADE
  };
})();
