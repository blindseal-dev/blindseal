/* ============================================================================
   S06 · Changelog — page.js
   ----------------------------------------------------------------------------
   Renders BS.data.changelog (newest first) as one flat panel per release and
   drives the version rail the way S02 drives its contents:
     1. anchors      the newest release of a version owns the bare id
                     (#v0.4.0); a later release with the same number takes
                     #v<version>-<component> (#v0.4.0-dashboard). Every entry
                     also answers to #v<version>-<component>.
     2. deep links   on load (and on hashchange) the entry is scrolled to
                     instantly, revealed, and the rail is lit for it.
     3. scroll-spy   one scroll handler (rAF): the active entry is the last
                     whose activation point the reader has passed. Entries
                     the page cannot scroll to the top (the last screenful)
                     get activation points spread evenly over the remaining
                     scroll, so every one of them can be lit and reached.
                     At the top of the page the latest release is lit.
     4. rail links   smooth-scroll (instant under reduced motion or from the
                     keyboard), update the hash, focus the entry's version;
                     the spy holds on the target until the scroll ends.
     5. "#" buttons  copy the entry's URL through the kit's [data-copy]
                     helper ("Copied", 1.4 s) and set the hash in place.
     6. reveals      once per entry: the entries in view on first paint
                     rise-14 at 260 + 60 ms × n; the rest rise-14 (no delay)
                     the first time they enter the viewport.
   The footer's version is rewritten from changelog[0] and links to it.
   ========================================================================== */
(function () {
  "use strict";
  var BS = window.BS;
  var M = BS.motion, D = BS.data, ui = BS.ui, fmt = BS.fmt || ui.fmt;

  BS.mountSite({ active: "changelog" });

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return [].slice.call((r || document).querySelectorAll(s)); }
  function esc(s) { return ui.esc(s); }
  function reduced() { return M.reduced(); }

  var LOG = (D.changelog || []).slice();
  var GROUPS = [["added", "Added"], ["changed", "Changed"], ["fixed", "Fixed"]];
  var REVEAL_BASE = 260, REVEAL_STEP = 60;

  /* ── ids + aliases ───────────────────────────────────────────────────── */
  var seen = {}, alias = {};
  LOG.forEach(function (e) {
    var bare = "v" + e.version;
    e.id = seen[bare] ? bare + "-" + e.component : bare;
    seen[bare] = true;
    alias[e.id] = e.id;
    if (!alias[bare + "-" + e.component]) alias[bare + "-" + e.component] = e.id;
  });
  var latest = LOG[0] || null;

  function dayLong(ymd) { return fmt.date(ymd + "T12:00:00Z"); }                 /* "Oct 20, 2026" */
  function dayShort(ymd) { return dayLong(ymd).replace(/,\s*\d{4}$/, ""); }      /* "Oct 20" */
  function urlFor(id) { return location.origin + location.pathname + "#" + id; }

  /* identifiers in the notes read as code: env assignments, routes, method +
     path, camelCase names, detector versions. Escaped first, then wrapped. */
  var CODE_RE = /\b(?:GET|POST|PUT|DELETE) \/[\w/.:-]+|\b[A-Z][A-Z0-9_]{2,}=\w+|(?:^|(?<=\s))\/[a-z][\w/-]*|\bdet-\d{4}\.\d+\.\d+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b/g;
  function note(text) {
    return esc(text).replace(CODE_RE, function (m) { return "<code>" + m + "</code>"; });
  }

  /* ── render ──────────────────────────────────────────────────────────── */
  var list = $("#cl-entries"), rail = $("#cl-rail-list");
  list.innerHTML = LOG.map(function (e, i) {
    var isLatest = i === 0;
    var groups = GROUPS.filter(function (g) { return (e[g[0]] || []).length; }).map(function (g) {
      return '<section class="cl-group" aria-label="' + g[1] + '"><h3 class="cl-group__k">' + g[1] + "</h3>" +
        '<ul class="cl-group__list">' + e[g[0]].map(function (t) { return "<li>" + note(t) + "</li>"; }).join("") + "</ul></section>";
    }).join("");
    return '<article class="cl-entry" id="' + esc(e.id) + '" data-i="' + i + '" data-component="' + esc(e.component) + '" aria-labelledby="' + esc(e.id) + '-h">' +
      '<header class="cl-entry__head">' +
        '<h2 class="cl-entry__v" id="' + esc(e.id) + '-h">v' + esc(e.version) + '<span class="sr-only">, ' + esc(e.component) + "</span></h2>" +
        '<time class="cl-entry__date" datetime="' + esc(e.date) + '">' + esc(dayLong(e.date)) + "</time>" +
        '<span class="cl-entry__chips"><span class="chip neutral">' + esc(e.component) + "</span>" +
          (isLatest ? '<span class="chip accent">latest</span>' : "") + "</span>" +
        '<button type="button" class="cl-anchor" data-copy="' + esc(urlFor(e.id)) + '" data-anchor="' + esc(e.id) + '">' +
          '<span aria-hidden="true">#</span><span class="sr-only">Copy link to v' + esc(e.version) + " " + esc(e.component) + "</span></button>" +
      "</header>" +
      '<div class="cl-entry__groups">' + groups + "</div>" +
    "</article>";
  }).join("");

  rail.innerHTML = LOG.map(function (e, i) {
    return '<li><a class="cl-rail__link" href="#' + esc(e.id) + '" data-rail="' + esc(e.id) + '">' +
      (i === 0 ? '<span class="cl-rail__dot" aria-hidden="true"></span>' : "") +
      '<span class="cl-rail__v">v' + esc(e.version) + " · " + esc(dayShort(e.date)) + "</span>" +
      '<span class="cl-rail__c">' + esc(e.component) + "</span>" +
      (i === 0 ? '<span class="sr-only">, latest</span>' : "") + "</a></li>";
  }).join("");

  var entries = $$(".cl-entry", list);
  var links = $$(".cl-rail__link", rail);
  var fill = $(".cl-rail__fill"), topBtn = $("[data-top]");

  /* ── footer version = the latest entry ───────────────────────────────── */
  var verEl = $(".site-footer__ver");
  if (verEl && latest) {
    var rest = verEl.textContent.replace(/^v\S+/, "");
    verEl.innerHTML = '<a href="#' + esc(latest.id) + '" data-go="' + esc(latest.id) + '">v' + esc(latest.version) + "</a>" + esc(rest);
  }

  /* ── masthead field + the ladder ─────────────────────────────────────── */
  var mast = $(".cl-mast"), body = $("#cl");
  if (BS.mountSpace) BS.mountSpace($(".cl-mast__space"), { intensity: "faint", fade: false });
  if (!reduced()) { mast.classList.add("is-rising"); body.classList.add("is-rising"); }

  /* ── geometry: targets + activation points ───────────────────────────── */
  var act = [], lead = [], maxY = 0;
  function padTop() { return parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 78; }
  function measure() {
    var se = document.scrollingElement || document.documentElement;
    maxY = Math.max(0, se.scrollHeight - window.innerHeight);
    var pad = padTop();
    /* layout tops (offsetTop chain), so a rising entry's 14 px transform never skews them */
    var t = entries.map(function (el) { var top = 0, n = el; while (n) { top += n.offsetTop; n = n.offsetParent; } return Math.round(top - pad); });
    act = t.slice();
    var j = -1;
    for (var i = 0; i < t.length; i++) { if (t[i] > maxY - 1) { j = i; break; } }
    if (j >= 0) {
      /* start the spread early enough that each step gets ≥ 100 px of scroll */
      var s = Math.max(0, j - 1);
      while (s > 0 && (maxY - Math.min(t[s], maxY)) / (t.length - 1 - s) < 100) s--;
      var from = Math.min(t[s], maxY), n = t.length - 1 - s;
      for (var k = s + 1; k < t.length; k++) act[k] = Math.round(from + (maxY - from) * (k - s) / n);
    }
    /* lead: an entry lights a little before it reaches the top (the reading
       line), but never by more than half the scroll since the previous one,
       so a jump to entry i always lights i, never i + 1 */
    lead = act.map(function (a, i) { return i ? Math.max(0, Math.min(160, Math.floor((a - act[i - 1]) / 2) - 1)) : 0; });
  }

  /* ── scroll-spy ──────────────────────────────────────────────────────── */
  var active = -1, hold = -1, holdTimer = 0;
  function setActive(i) {
    if (i === active) return;
    active = i;
    links.forEach(function (a, k) {
      var on = k === i;
      a.classList.toggle("is-active", on);
      if (on) a.setAttribute("aria-current", "location"); else a.removeAttribute("aria-current");
    });
  }
  function spyIndex() {
    var y = window.scrollY, idx = 0;
    for (var i = 0; i < act.length; i++) { if (y + lead[i] >= act[i] - 1) idx = i; }
    return idx;
  }
  var pend = 0;
  function onScroll() {
    pend = 0;
    var y = window.scrollY;
    var p = maxY > 0 ? Math.min(1, Math.max(0, y / maxY)) : 0;
    fill.style.transform = "scaleY(" + p.toFixed(4) + ")";
    topBtn.disabled = y < 8;
    if (hold >= 0) {
      setActive(hold);
      if (Math.abs(y - act[hold]) < 2) release();
      return;
    }
    setActive(spyIndex());
  }
  function schedule() { if (!pend) pend = requestAnimationFrame(onScroll); }
  function release() { hold = -1; clearTimeout(holdTimer); }
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("scrollend", function () { if (hold >= 0) { release(); schedule(); } });
  ["wheel", "touchstart", "keydown"].forEach(function (t) {
    window.addEventListener(t, function () { if (hold >= 0) { release(); schedule(); } }, { passive: true });
  });
  window.addEventListener("resize", function () { measure(); schedule(); });

  /* ── reveals: once per entry ─────────────────────────────────────────── */
  var io = null;
  function show(el, delay) {
    if (el.classList.contains("is-in")) return;
    if (!reduced()) { el.style.animationDelay = delay + "ms"; el.classList.add("rise-14"); }
    el.classList.add("is-in");
    if (io) io.unobserve(el);
  }
  function firstPaint() {
    if (reduced() || !("IntersectionObserver" in window)) { entries.forEach(function (el) { show(el, 0); }); return; }
    var n = 0, h = window.innerHeight;
    entries.forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.top < h * 0.88 && r.bottom > 0) show(el, REVEAL_BASE + REVEAL_STEP * n++);
    });
    io = new IntersectionObserver(function (list) {
      list.forEach(function (e) { if (e.isIntersecting) show(e.target, 0); });
    }, { rootMargin: "0px 0px -12% 0px" });
    entries.forEach(function (el) { if (!el.classList.contains("is-in")) io.observe(el); });
  }

  /* ── navigation ──────────────────────────────────────────────────────── */
  function indexOf(id) { for (var i = 0; i < LOG.length; i++) { if (LOG[i].id === id) return i; } return -1; }
  function resolveHash(h) {
    h = decodeURIComponent(String(h || "").replace(/^#/, ""));
    return alias[h] ? indexOf(alias[h]) : -1;
  }
  function go(i, o) {
    o = o || {};
    if (i < 0 || !entries[i]) return;
    measure();
    var smooth = !o.instant && !reduced();
    var target = act[i];
    if (smooth && Math.abs(window.scrollY - target) > 2) {
      hold = i; clearTimeout(holdTimer);
      holdTimer = setTimeout(function () { release(); schedule(); }, M.scale(1600));
    }
    window.scrollTo({ top: target, behavior: smooth ? "smooth" : "instant" });
    setActive(i);
    if (o.hash !== false) { try { history.replaceState(null, "", "#" + LOG[i].id); } catch (e) { /* file:// */ } }
    if (o.focus) { var h = $(".cl-entry__v", entries[i]); h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
    show(entries[i], 0);
    schedule();
  }
  links.forEach(function (a, i) {
    a.addEventListener("click", function (e) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
      e.preventDefault();
      go(i, { focus: true, instant: e.detail === 0 });     /* keyboard activation: no animation */
    });
  });
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[data-go]");
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
    e.preventDefault();
    go(indexOf(a.getAttribute("data-go")), { focus: true, instant: e.detail === 0 });
  });
  list.addEventListener("click", function (e) {
    var b = e.target.closest(".cl-anchor");
    if (!b) return;
    try { history.replaceState(null, "", "#" + b.getAttribute("data-anchor")); } catch (err) { /* file:// */ }
  });
  topBtn.addEventListener("click", function (e) {
    release();
    window.scrollTo({ top: 0, behavior: reduced() || e.detail === 0 ? "instant" : "smooth" });
    try { history.replaceState(null, "", location.pathname + location.search); } catch (err) { /* file:// */ }
    var t = $("#cl-title"); t.setAttribute("tabindex", "-1"); t.focus({ preventScroll: true });
  });
  window.addEventListener("hashchange", function () {
    var i = resolveHash(location.hash);
    if (i >= 0) go(i, { instant: true });                 /* canonicalises an alias (#v0.4.0-proxy → #v0.4.0) */
    else stripUnknown();
  });

  /* ── boot: deep link first (so the right entries rise), then the spy ── */
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  measure();
  /* an unknown fragment (#nope) leaves the address bar, as an alias is rewritten;
     a fragment naming a real element (the skip link's #main-content) stays */
  function stripUnknown() {
    var h = decodeURIComponent(location.hash.slice(1));
    if (!h || document.getElementById(h)) return;
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* file:// */ }
  }
  var deep = resolveHash(location.hash), userMoved = false;
  if (deep < 0) stripUnknown();
  if (deep >= 0) {
    window.scrollTo({ top: act[deep], behavior: "instant" });
    if (LOG[deep].id !== location.hash.slice(1)) { try { history.replaceState(null, "", "#" + LOG[deep].id); } catch (e) { /* file:// */ } }
  }
  firstPaint();
  onScroll();
  ["wheel", "touchstart", "keydown", "pointerdown"].forEach(function (t) {
    window.addEventListener(t, function () { userMoved = true; }, { passive: true, once: true });
  });
  /* fonts and the browser's own fragment jump can move things after boot:
     re-measure, and keep a deep link pinned until the reader moves */
  function settle() {
    measure();
    if (deep >= 0 && !userMoved) window.scrollTo({ top: act[deep], behavior: "instant" });
    schedule();
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(settle);
  window.addEventListener("load", settle);

  BS.page = {
    entries: LOG.map(function (e) { return { id: e.id, version: e.version, component: e.component, date: e.date }; }),
    latest: latest && latest.id,
    active: function () { return active >= 0 ? LOG[active].id : null; },
    go: function (id) { go(resolveHash(id)); },
    activation: function () { return act.slice(); }
  };
})();
