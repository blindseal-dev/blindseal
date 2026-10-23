/* ============================================================================
   _shared/ui.js — BS.ui: behaviour for the ui.css primitives (classic script)
   ----------------------------------------------------------------------------
   Port of the Blindseal kit/ui.js (the ui layer), plus
   Blindseal's renderers. Load after icons.js and motion.js (and fixtures.js,
   whose BS.fmt wins where both define a formatter).

     BS.ui.esc(str) · BS.ui.icon(name, o)
     BS.ui.toast({ title, body, tone, action, timeout, id }) / BS.toast(…)
         glass toast, newest at the bottom edge, older stack upward, ≤3 visible,
         rise-8 260ms in, 140ms out, 6s default, hover / focus / hidden-tab
         pause. tone: info | ok | warn | danger
     BS.ui.menu(trigger, items, { align: "start"|"end", head }) → { open, close, destroy }
         glass menu: 150ms in (opacity + 6px rise, out-cubic) / 140ms out
         (opacity only), ↑/↓/Home/End, Escape, outside click, flips above.
         items: { label, icon, meta, onSelect, current, disabled } or "-"
     BS.ui.seg(el, { value, onChange })     .seg (static wash) / .glass-seg (sliding
                                            pill: translate + scaleX, 240ms out-quint,
                                            never on first paint)
     BS.ui.tabs(el, { value, onChange })    .tabs > .tab and .tabs-text > .tab-text
     BS.ui.switch(el, { onChange })         role=switch aria-checked
     BS.ui.copy(root?)                      [data-copy="text"] buttons: "Copied" 1400ms
     BS.ui.tooltip(target, text, { mono })  show one now; BS.ui.tooltips(root?) wires
                                            [data-tip] — 400ms first, then instant
                                            (within 300ms of the last one)
     BS.ui.dialog({ title, body, actions:[{label, cls, onClick, close}], onClose }) → { el, close() }
     BS.ui.layers                           the layer stack: Escape closes the
                                            innermost thing, Tab is trapped
     BS.ui.empty(o) / BS.ui.skeleton(kind, n)  markup helpers

   Blindseal renderers (each returns an HTML string; behaviour is delegated
   on document, so anything inserted later works with no wiring):
     BS.ui.hash(value, { short = true, label, lg, cls }) → <button class="hash">
         0x-prefixed hex: first 6 + "…" + last 4 ("0x1234…abcd"); anything
         else is base58: first 4 + last 4 ("1111…1111").
         Click copies the FULL value and the text reads "Copied" for 1.4s (the
         width is held, nothing jumps). Hover / focus shows the full value in a
         mono tooltip (400ms first, instant after). white-space: nowrap; never
         a CSS ellipsis. Fires "bs:copy" { value }.
     BS.ui.verdict("pass"|"block"|"flag")  → <span class="verdict …">
     BS.ui.layerStrip(layerResults | "pass,pass,block,skip") → the L0–L3 strip, a
         tooltip per cell ("L2 · 0.81 · 42 ms")
     BS.ui.status(status, { progress })    → the attestation chip (generating
         shows its % and the 2px bar; consumed carries a check)
     BS.ui.setStatus(el, status, { progress })  update a rendered chip in place
     BS.ui.code(text, { lang, copy = true })  → .code block; lines starting
         "$ " get the faint prompt; copy copies without the prompts
     BS.ui.checkItem({ n, title, detail, state, reason, end }) → <li class="check">
     BS.ui.check(li, state, { reason, end }) set pending|running|pass|fail
     BS.ui.progress(el, 0..1)               set a .progress / .status__bar fill
     BS.ui.fmt  = BS.fmt (fixtures.js) when present, else these fallbacks:
         shortHash(hex) 6+4 · shortB58(s) 4+4 · int(n) · ms(n) · pct(x, d)
         · bytes(n) · slot(n) · amount(baseUnits, decimals = 9) · time(ts)
         · dateTime(ts) · timeAgo(ts) (honours window.BS_NOW)
   ========================================================================== */
(function () {
  "use strict";
  var BS = (window.BS = window.BS || {});
  var ui = (BS.ui = BS.ui || {});

  function M() { return BS.motion; }
  function reduced() { return M() ? M().reduced() : false; }
  function scale(ms) { return M() ? M().scale(ms) : ms; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function ico(name, o) { return BS.icon ? BS.icon(name, o) : '<i data-lucide="' + esc(name) + '"></i>'; }
  ui.esc = esc;
  ui.icon = ico;

  /* ── formatters (fixtures.js's BS.fmt wins where both define one) ──────── */
  var nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
  function nowMs() { return typeof window.BS_NOW === "number" ? window.BS_NOW : Date.now(); }
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  var fmt = {
    shortHash: function (h) { h = String(h == null ? "" : h); return h.length > 12 ? h.slice(0, 6) + "…" + h.slice(-4) : h; },
    shortB58: function (s) { s = String(s == null ? "" : s); return s.length > 10 ? s.slice(0, 4) + "…" + s.slice(-4) : s; },
    int: function (v) { return nf0.format(Math.round(Number(v) || 0)); },
    ms: function (v) { v = Number(v) || 0; return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + " s" : Math.round(v) + " ms"; },
    pct: function (v, d) { return ((Number(v) || 0) * (Math.abs(v) <= 1 ? 100 : 1)).toFixed(d == null ? 0 : d) + "%"; },
    bytes: function (n) { n = Number(n) || 0; return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? (n / 1024).toFixed(1) + " KB" : n + " B"; },
    slot: function (n) { return nf0.format(Number(n) || 0); },
    amount: function (base, decimals) {
      decimals = decimals == null ? 9 : decimals;
      var s = String(base || "0").replace(/^0+(?=\d)/, ""); while (s.length <= decimals) s = "0" + s;
      var i = s.slice(0, s.length - decimals), f = s.slice(s.length - decimals).replace(/0+$/, "");
      return nf0.format(Number(i)) + (f ? "." + f : "");
    },
    time: function (t) { var d = new Date(t); return pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + ":" + pad(d.getUTCSeconds()); },
    dateTime: function (t) { var d = new Date(t); return MON[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + " UTC"; },
    timeAgo: function (t) {
      var s = (nowMs() - new Date(t).getTime()) / 1000;
      if (s < 60) return Math.max(0, Math.floor(s)) + "s ago";
      if (s < 3600) return Math.floor(s / 60) + "m ago";
      if (s < 86400) return Math.floor(s / 3600) + "h ago";
      return Math.floor(s / 86400) + "d ago";
    }
  };
  if (BS.fmt) { for (var fk in BS.fmt) if (Object.prototype.hasOwnProperty.call(BS.fmt, fk)) fmt[fk] = BS.fmt[fk]; }
  BS.fmt = ui.fmt = fmt;

  /* ── the layer stack ──────────────────────────────────────────────────── */
  var layers = [];
  var openMenu = null;
  function focusables(root) {
    return [].slice.call(root.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter(function (n) { return n.offsetParent !== null || n === document.activeElement; });
  }
  ui.layers = {
    push: function (rec) { layers.push(rec); },
    pop: function (rec) { var i = layers.indexOf(rec); if (i >= 0) layers.splice(i, 1); },
    count: function () { return layers.length; },
    top: function () { return layers[layers.length - 1] || null; },
    returnFocus: function (opener) {
      var t = opener && opener.isConnected && opener.offsetParent !== null ? opener : document.getElementById("main-content");
      if (t && typeof t.focus === "function") { try { t.focus({ preventScroll: true }); } catch (e) {} }
    }
  };
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (openMenu) { e.preventDefault(); e.stopPropagation(); openMenu.close(true); return; }
      var top = layers[layers.length - 1];
      if (top) { e.preventDefault(); e.stopPropagation(); top.close("escape"); }
      return;
    }
    if (e.key !== "Tab") return;
    if (openMenu) { openMenu.close(false); return; }
    var t = layers[layers.length - 1];
    if (!t) return;
    var f = focusables(t.node); if (!f.length) { e.preventDefault(); return; }
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === t.node)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (!t.node.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  }, true);

  /* ── toast ────────────────────────────────────────────────────────────── */
  var TONE_ICON = { info: "info", ok: "circle-check", warn: "triangle-alert", danger: "circle-alert" };
  function toastRoot() {
    var r = document.getElementById("bs-toasts");
    if (!r) { r = document.createElement("div"); r.id = "bs-toasts"; r.className = "toasts"; r.setAttribute("aria-live", "polite"); document.body.appendChild(r); if (BS.glass && BS.glass.adopt) BS.glass.adopt(r); }
    return r;
  }
  function dismiss(t) {
    if (!t || t.classList.contains("is-leaving")) return;
    if (t._timer) clearTimeout(t._timer.id);
    if (reduced()) { t.remove(); return; }
    t.classList.add("is-leaving");
    setTimeout(function () { t.remove(); }, scale(160));
  }
  ui.toast = function (o) {
    o = o || {};
    var root = toastRoot();
    if (o.id) { var dup = root.querySelector('[data-toast-id="' + CSS.escape(o.id) + '"]'); if (dup) dismiss(dup); }
    var tone = o.tone || "info";
    var t = document.createElement("div");
    t.className = "glass-toast toast";
    t.dataset.tone = tone;
    if (o.id) t.dataset.toastId = o.id;
    t.setAttribute("role", tone === "warn" || tone === "danger" ? "alert" : "status");
    t.innerHTML = '<span class="toast__icon">' + ico(TONE_ICON[tone] || "info") + "</span>" +
      '<div class="toast__copy"><p class="toast__title">' + esc(o.title || "") + "</p>" +
      (o.body ? '<p class="toast__body">' + (o.html ? o.body : esc(o.body)) + "</p>" : "") +
      (o.action ? '<button type="button" class="btn secondary sm toast__action">' + esc(o.action.label) + "</button>" : "") + "</div>" +
      '<button type="button" class="toast__x" aria-label="Dismiss">' + ico("x") + "</button>";
    root.insertBefore(t, root.firstChild);
    t.querySelector(".toast__x").addEventListener("click", function () { dismiss(t); });
    if (o.action) t.querySelector(".toast__action").addEventListener("click", function () { try { if (o.action.onClick) o.action.onClick(); } finally { dismiss(t); } });
    var live = [].slice.call(root.querySelectorAll(".toast:not(.is-leaving)"));
    for (var i = 3; i < live.length; i++) dismiss(live[i]);
    var ms = o.timeout == null ? 6000 : o.timeout;
    if (ms > 0) {
      var rec = { left: scale(ms), at: Date.now(), id: 0 };
      t._timer = rec;
      var arm = function () { clearTimeout(rec.id); rec.at = Date.now(); rec.id = setTimeout(function () { dismiss(t); }, rec.left); };
      var hold = function () { clearTimeout(rec.id); rec.left -= Date.now() - rec.at; };
      t.addEventListener("mouseenter", hold); t.addEventListener("mouseleave", arm);
      t.addEventListener("focusin", hold); t.addEventListener("focusout", arm);
      document.addEventListener("visibilitychange", function () { if (!t.isConnected) return; if (document.hidden) hold(); else arm(); });
      arm();
    }
    return { el: t, dismiss: function () { dismiss(t); } };
  };
  BS.toast = ui.toast;

  /* ── menu ─────────────────────────────────────────────────────────────── */
  ui.menu = function (trigger, items, o) {
    o = o || {};
    var el = document.createElement("div");
    el.className = "glass-menu menu" + (o.align === "end" ? " is-end" : "");
    el.setAttribute("role", "menu");
    el.dataset.open = "false";
    var html = "";
    if (o.head) html += '<div class="menu__head">' + (o.head.lead || "") + "<div><b>" + esc(o.head.title) + "</b>" + (o.head.sub ? "<span>" + esc(o.head.sub) + "</span>" : "") + "</div></div>";
    items.forEach(function (it, i) {
      if (it === "-" || it.sep) { html += '<div class="menu__sep" role="separator"></div>'; return; }
      html += '<button type="button" class="menu__row" role="menuitem" data-i="' + i + '"' + (it.current ? ' aria-current="page"' : "") + (it.disabled ? " disabled" : "") + ">" +
        (it.icon ? ico(it.icon) : "") + "<span>" + esc(it.label) + "</span>" + (it.meta ? '<span class="menu__meta">' + esc(it.meta) + "</span>" : "") + "</button>";
    });
    el.innerHTML = html;
    document.body.appendChild(el); if (BS.glass && BS.glass.adopt) BS.glass.adopt(el);   /* a sibling layer: never inside a glass element (backdrop root) */
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");
    var api;
    function rows() { return [].slice.call(el.querySelectorAll(".menu__row:not([disabled])")); }
    function place() {
      var r = trigger.getBoundingClientRect(), mw = el.offsetWidth, mh = el.offsetHeight, gap = 6;
      var left = o.align === "end" ? r.right - mw : r.left;
      left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
      var above = r.bottom + gap + mh > window.innerHeight - 8 && r.top - gap - mh > 8;
      el.classList.toggle("is-above", above);
      el.style.left = Math.round(left) + "px";
      el.style.top = Math.round(above ? r.top - gap - mh : r.bottom + gap) + "px";
    }
    function onDoc(e) { if (!el.contains(e.target) && !trigger.contains(e.target)) close(false); }
    function open() {
      if (openMenu && openMenu !== api) openMenu.close(false);
      place();
      el.dataset.open = "true";
      trigger.setAttribute("aria-expanded", "true");
      openMenu = api;
      document.addEventListener("pointerdown", onDoc, true);
      var first = el.querySelector(".menu__row[aria-current]") || rows()[0];
      if (first) requestAnimationFrame(function () { first.focus({ preventScroll: true }); });
    }
    function close(refocus) {
      if (el.dataset.open !== "true") return;
      el.dataset.open = "false";
      trigger.setAttribute("aria-expanded", "false");
      if (openMenu === api) openMenu = null;
      document.removeEventListener("pointerdown", onDoc, true);
      if (refocus) trigger.focus({ preventScroll: true });
    }
    trigger.addEventListener("click", function () { if (el.dataset.open === "true") close(true); else open(); });
    el.addEventListener("click", function (e) {
      var b = e.target.closest(".menu__row"); if (!b) return;
      var it = items[Number(b.dataset.i)];
      close(true);
      if (it && typeof it.onSelect === "function") it.onSelect(it);
    });
    el.addEventListener("keydown", function (e) {
      var list = rows(), i = list.indexOf(document.activeElement), j = null;
      if (e.key === "ArrowDown") j = (i + 1) % list.length;
      else if (e.key === "ArrowUp") j = (i - 1 + list.length) % list.length;
      else if (e.key === "Home") j = 0; else if (e.key === "End") j = list.length - 1;
      if (j == null) return;
      e.preventDefault(); list[j].focus();
    });
    window.addEventListener("resize", function () { if (el.dataset.open === "true") place(); });
    api = { el: el, open: open, close: close, destroy: function () { close(false); el.remove(); } };
    return api;
  };

  /* ── seg: .seg (static wash) and .glass-seg (sliding wash pill) ───────── */
  ui.seg = function (el, o) {
    o = o || {};
    var glass = el.classList.contains("glass-seg");
    var ITEM = glass ? ".glass-seg__item" : ".seg__item";
    var btns = [].slice.call(el.querySelectorAll(ITEM));
    var pill = null;
    if (glass) {
      pill = el.querySelector(".glass-seg__pill");
      if (!pill) { pill = document.createElement("span"); pill.className = "glass-seg__pill"; pill.setAttribute("aria-hidden", "true"); el.appendChild(pill); }
    }
    var tabs = el.getAttribute("role") === "tablist";
    if (!el.hasAttribute("role")) el.setAttribute("role", "group");
    var current = null, glideUntil = 0, last = "", destroyed = false;
    function mark(v) {
      btns.forEach(function (b) {
        var on = b.dataset.value === v;
        b.classList.toggle("is-active", on);
        if (tabs) { b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; }
        else b.setAttribute("aria-pressed", String(on));
      });
      current = v;
    }
    var BASE = 100;
    function measure(animate) {
      if (!pill) return;
      var b = el.querySelector(ITEM + ".is-active");
      if (!b || !b.offsetWidth) return;
      var box = [b.offsetLeft, b.offsetTop, b.offsetWidth, b.offsetHeight], key = box.join(",");
      var apply = function () {
        pill.style.width = BASE + "px"; pill.style.height = box[3] + "px";
        pill.style.transform = "translate(" + box[0] + "px," + box[1] + "px) scaleX(" + (box[2] / BASE) + ")";
        last = key; el.classList.add("has-pill");
      };
      if (animate === true || Date.now() < glideUntil) { if (animate === true) glideUntil = Date.now() + scale(260); apply(); return; }
      if (last === key && el.classList.contains("has-pill")) return;
      el.classList.add("is-nofx"); apply(); void getComputedStyle(pill).transform;
      requestAnimationFrame(function () { if (destroyed) return; el.classList.remove("is-nofx"); el.classList.add("is-animated"); });
    }
    function set(v, s) {
      s = s || {};
      v = String(v);
      if (v === current) return;
      if (!btns.some(function (b) { return b.dataset.value === v; })) return;
      mark(v); measure(!s.silent && !reduced() && el.classList.contains("is-animated"));
      if (!s.silent && typeof o.onChange === "function") o.onChange(v);
    }
    var onClick = function (e) { var b = e.currentTarget; if (!b.disabled) set(b.dataset.value); };
    var onKey = function (e) {
      if (!tabs) return;
      var i = btns.indexOf(document.activeElement); if (i < 0) return;
      var j = null;
      if (e.key === "ArrowRight") j = (i + 1) % btns.length;
      else if (e.key === "ArrowLeft") j = (i - 1 + btns.length) % btns.length;
      else if (e.key === "Home") j = 0; else if (e.key === "End") j = btns.length - 1;
      if (j == null) return;
      e.preventDefault(); btns[j].focus(); set(btns[j].dataset.value);
    };
    btns.forEach(function (b) { b.addEventListener("click", onClick); });
    el.addEventListener("keydown", onKey);
    var ro = pill && ("ResizeObserver" in window) ? new ResizeObserver(function () { measure(); }) : null;
    if (ro) ro.observe(el);
    mark(o.value != null ? String(o.value) : (el.querySelector(ITEM + ".is-active") || btns[0] || { dataset: {} }).dataset.value);
    measure();
    if (pill && document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (!destroyed) measure(); });
    return {
      value: function () { return current; }, set: set, remeasure: function () { measure(); },
      destroy: function () { destroyed = true; if (ro) ro.disconnect(); btns.forEach(function (b) { b.removeEventListener("click", onClick); }); el.removeEventListener("keydown", onKey); }
    };
  };

  /* ── tabs: .tabs > .tab and .tabs-text > .tab-text (role=tablist) ─────── */
  ui.tabs = function (el, o) {
    o = o || {};
    var items = [].slice.call(el.querySelectorAll(".tab, .tab-text"));
    el.setAttribute("role", "tablist");
    var current = null;
    function set(v, silent) {
      v = String(v);
      items.forEach(function (b) {
        var on = b.dataset.value === v;
        b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1;
        b.classList.toggle("is-active", on);
      });
      var changed = current !== v; current = v;
      if (changed && !silent && typeof o.onChange === "function") o.onChange(v);
    }
    items.forEach(function (b) { b.addEventListener("click", function () { if (!b.disabled) set(b.dataset.value); }); });
    el.addEventListener("keydown", function (e) {
      var i = items.indexOf(document.activeElement); if (i < 0) return;
      var j = null;
      if (e.key === "ArrowRight") j = (i + 1) % items.length; else if (e.key === "ArrowLeft") j = (i - 1 + items.length) % items.length;
      if (j == null) return;
      e.preventDefault(); items[j].focus(); set(items[j].dataset.value);
    });
    set(o.value != null ? o.value : (el.querySelector(".is-active") || items[0]).dataset.value, true);
    return { value: function () { return current; }, set: set };
  };

  /* ── switch ───────────────────────────────────────────────────────────── */
  ui.switch = function (el, o) {
    o = o || {};
    el.setAttribute("role", "switch");
    if (!el.hasAttribute("aria-checked")) el.setAttribute("aria-checked", "false");
    el.addEventListener("click", function () {
      var on = el.getAttribute("aria-checked") !== "true";
      el.setAttribute("aria-checked", String(on));
      if (typeof o.onChange === "function") o.onChange(on);
    });
  };

  /* ── clipboard (a refusal still confirms: the mockup has no secrets) ─── */
  function writeClip(text, done) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
      else done();
    } catch (e) { done(); }
  }
  ui.writeClipboard = writeClip;

  /* ── copy buttons: [data-copy] → "Copied" for 1400ms, colour only ─────── */
  ui.copy = function (root) {
    root = root || document;
    [].forEach.call(root.querySelectorAll("[data-copy]:not([data-copy-wired])"), function (b) {
      b.setAttribute("data-copy-wired", "");
      b.addEventListener("click", function () {
        var label = b.querySelector("span:not(.sr-only)");
        if (b._t) clearTimeout(b._t);
        if (b._orig == null) b._orig = { label: label ? label.textContent : "", html: b.innerHTML };
        writeClip(b.getAttribute("data-copy"), function () {
          b.classList.add("is-done");
          if (label) label.textContent = "Copied";
          var svg = b.querySelector("svg.lucide-copy");
          if (svg) svg.outerHTML = ico("check");
          b.setAttribute("aria-label", "Copied");
          b._t = setTimeout(function () { b.classList.remove("is-done"); b.innerHTML = b._orig.html; b.removeAttribute("aria-label"); b._orig = null; }, 1400);
          document.dispatchEvent(new CustomEvent("bs:copy", { detail: { value: b.getAttribute("data-copy") } }));
        });
      });
    });
  };

  /* ── tooltips: first waits 400ms; within 300ms of the last, instant (Emil) ── */
  var tipEl = null, tipTimer = 0, tipWarmUntil = 0, tipOwner = null;
  function tip() {
    if (!tipEl) {
      tipEl = document.createElement("div"); tipEl.className = "tooltip"; tipEl.setAttribute("role", "tooltip"); tipEl.id = "bs-tooltip";
      document.body.appendChild(tipEl); if (BS.glass && BS.glass.adopt) BS.glass.adopt(tipEl);
    }
    return tipEl;
  }
  function showTip(t, html, mono) {
    clearTimeout(tipTimer);
    var go = function () {
      var el = tip();
      el.classList.toggle("is-mono", !!mono);
      el.innerHTML = html;
      el.style.left = "0px"; el.style.top = "0px";   /* measure at the origin, so the old position never squeezes the width */
      var r = t.getBoundingClientRect();
      var w = el.offsetWidth, h = el.offsetHeight;
      var left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8));
      var top = r.top - h - 8; if (top < 8) top = r.bottom + 8;
      el.style.left = Math.round(left) + "px"; el.style.top = Math.round(top) + "px";
      el.classList.toggle("is-instant", Date.now() < tipWarmUntil);
      el.classList.add("is-on");
      t.setAttribute("aria-describedby", "bs-tooltip");
      tipOwner = t;
    };
    if (Date.now() < tipWarmUntil) go(); else tipTimer = setTimeout(go, 400);
  }
  function hideTip(t) {
    clearTimeout(tipTimer);
    if (!tipEl) return;
    if (tipEl.classList.contains("is-on")) tipWarmUntil = Date.now() + 300;
    tipEl.classList.remove("is-on");
    if (t) t.removeAttribute("aria-describedby");
    tipOwner = null;
  }
  ui.tooltip = function (target, text, o) { showTip(target, esc(text), o && o.mono); return function () { hideTip(target); }; };
  ui.tooltips = function () { /* [data-tip] is delegated below; kept for API parity */ };

  /* ── delegation: [data-tip] tooltips, .hash copy + full-value tooltip ── */
  function tipTarget(n) { return n && n.closest ? n.closest("[data-tip], .hash[data-hash]") : null; }
  function tipHtml(t) {
    if (t.matches(".hash[data-hash]")) {
      var l = t.getAttribute("data-label");
      return (l ? '<span style="margin-right:10px;font-family:var(--font-sans);font-weight:var(--fw-medium);color:var(--muted)">' + esc(l) + "</span>" : "") + esc(t.getAttribute("data-hash"));   /* one line: label, then the full value */
    }
    return esc(t.getAttribute("data-tip"));
  }
  document.addEventListener("pointerover", function (e) {
    var t = tipTarget(e.target); if (!t || t === tipOwner) return;
    if (t.contains(e.relatedTarget)) return;
    showTip(t, tipHtml(t), t.classList.contains("hash"));
  });
  document.addEventListener("pointerout", function (e) {
    var t = tipTarget(e.target); if (!t || t.contains(e.relatedTarget)) return;
    hideTip(t);
  });
  document.addEventListener("focusin", function (e) { var t = tipTarget(e.target); if (t && e.target === t) showTip(t, tipHtml(t), t.classList.contains("hash")); });
  document.addEventListener("focusout", function (e) { var t = tipTarget(e.target); if (t && e.target === t) hideTip(t); });
  window.addEventListener("scroll", function () { if (tipOwner) hideTip(tipOwner); }, { passive: true, capture: true });

  /* ── hash ─────────────────────────────────────────────────────────────── */
  function isHex(s) { return /^0x/i.test(s); }   /* the 0x prefix decides: all-digit base58 ids (11111111111111111111111111111111) are base58, 4 + 4 */
  function shorten(v) {
    v = String(v == null ? "" : v);
    if (isHex(v)) return fmt.shortHash(v);
    return fmt.shortB58(v);
  }
  ui.shortHash = shorten;
  ui.hash = function (value, o) {
    o = o || {};
    var full = String(value == null ? "" : value);
    var shown = o.short === false ? full : shorten(full);
    return '<button type="button" class="hash' + (o.lg ? " lg" : "") + (o.cls ? " " + esc(o.cls) : "") + '" data-hash="' + esc(full) + '"' +
      (o.label ? ' data-label="' + esc(o.label) + '"' : "") +
      ' aria-label="' + esc((o.label ? o.label + " " : "") + full + ". Copy") + '"><span class="hash__v">' + esc(shown) + "</span></button>";
  };
  function copyHash(b) {
    var v = b.getAttribute("data-hash");
    var vEl = b.querySelector(".hash__v");
    if (!vEl) return;
    if (b._t) clearTimeout(b._t);
    if (b._orig == null) { b._orig = vEl.textContent; b.style.minWidth = b.offsetWidth + "px"; }
    writeClip(v, function () {
      vEl.textContent = "Copied";
      b.classList.add("is-copied");
      b._t = setTimeout(function () { vEl.textContent = b._orig; b._orig = null; b.classList.remove("is-copied"); b.style.minWidth = ""; }, 1400);
      document.dispatchEvent(new CustomEvent("bs:copy", { detail: { value: v } }));
    });
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest(".hash[data-hash]");
    if (!b || b.disabled) return;
    e.preventDefault(); e.stopPropagation();
    hideTip(b);
    copyHash(b);
  });

  /* ── verdict, layer strip, attestation status ─────────────────────────── */
  ui.verdict = function (v) {
    v = v === "block" || v === "flag" ? v : "pass";
    return '<span class="verdict ' + v + '">' + v + "</span>";
  };
  ui.layerStrip = function (list, o) {
    o = o || {};
    if (typeof list === "string") list = list.split(",").map(function (v, i) { return { layer: "L" + i, verdict: v.trim(), ran: v.trim() !== "skip" }; });
    var cells = (list || []).slice(0, 4).map(function (r, i) {
      var name = r.layer || "L" + i;
      var v = r.ran === false ? "skip" : (r.verdict || "skip");
      var tipText = v === "skip" ? name + " · skipped" :
        name + " · " + (r.score != null ? Number(r.score).toFixed(2) + " · " : (r.ruleIds && r.ruleIds.length ? r.ruleIds.join(", ") + " · " : v + " · ")) + (r.latencyMs != null ? Math.round(r.latencyMs) + " ms" : "");
      return '<span class="layers__cell" data-v="' + esc(v) + '" data-tip="' + esc(tipText.replace(/ · $/, "")) + '"></span>';
    }).join("");
    var sum = (list || []).map(function (r, i) { return (r.layer || "L" + i) + " " + (r.ran === false ? "skip" : r.verdict); }).join(", ");
    return '<span class="layers' + (o.lg ? " lg" : "") + '" role="img" aria-label="Layers: ' + esc(sum) + '">' + cells + "</span>";
  };
  function statusInner(s, o) {
    o = o || {};
    var p = Math.max(0, Math.min(100, Number(o.progress) || 0));
    if (s === "generating") return "generating" + '<span class="status__pct">' + Math.round(p) + "%</span>" + '<span class="status__bar"><i style="--p:' + (p / 100) + '"></i></span>';
    if (s === "consumed") return ico("check") + "consumed";
    return esc(s);
  }
  ui.status = function (s, o) {
    s = String(s || "generated");
    return '<span class="status" data-s="' + esc(s) + '">' + statusInner(s, o) + "</span>";
  };
  ui.setStatus = function (el, s, o) {
    if (!el) return;
    o = o || {};
    var bar = el.querySelector(".status__bar > i");
    if (s === "generating" && el.getAttribute("data-s") === "generating" && bar) {
      var p = Math.max(0, Math.min(100, Number(o.progress) || 0));
      bar.style.setProperty("--p", String(p / 100));
      el.querySelector(".status__pct").textContent = Math.round(p) + "%";
      return;
    }
    el.setAttribute("data-s", s);
    el.innerHTML = statusInner(s, o);
  };
  ui.progress = function (el, p) {
    if (!el) return;
    var i = el.matches("i") ? el : el.querySelector("i");
    if (i) i.style.setProperty("--p", String(Math.max(0, Math.min(1, Number(p) || 0))));
  };

  /* ── code block ───────────────────────────────────────────────────────── */
  ui.code = function (text, o) {
    o = o || {};
    var lines = String(text || "").split("\n");
    var plain = lines.map(function (l) { return l.replace(/^\$ /, ""); }).join("\n");
    var body = lines.map(function (l) {
      if (/^\$ /.test(l)) return '<span class="code__prompt">$ </span>' + esc(l.slice(2));
      if (/^#/.test(l)) return '<span class="code__c">' + esc(l) + "</span>";
      return esc(l);
    }).join("\n");
    return '<div class="code">' + (o.lang ? '<span class="code__lang">' + esc(o.lang) + "</span>" : "") +
      "<pre><code>" + body + "</code></pre>" +
      (o.copy === false ? "" : '<button type="button" class="copy code__copy" data-copy="' + esc(plain) + '" aria-label="Copy">' + ico("copy") + "</button>") + "</div>";
  };

  /* ── checklist item ───────────────────────────────────────────────────── */
  ui.checkItem = function (o) {
    o = o || {};
    var st = o.state || "pending";
    return '<li class="check" data-state="' + esc(st) + '"><span class="check__mark">' +
      (o.n != null ? '<span class="check__n">' + esc(o.n) + "</span>" : "") + ico(st === "fail" ? "x" : "check") + "</span>" +
      '<div class="check__main"><p class="check__title">' + esc(o.title || "") + "</p>" +
      (o.detail ? '<p class="check__detail">' + (o.html ? o.detail : esc(o.detail)) + "</p>" : "") +
      '<span class="check__sweep" aria-hidden="true"><span></span></span>' +
      '<p class="check__reason">' + ico("circle-alert") + "<span>" + esc(o.reason || "") + "</span></p></div>" +
      '<span class="check__end">' + esc(o.end || "") + "</span></li>";
  };
  ui.check = function (li, state, o) {
    if (!li) return;
    o = o || {};
    li.setAttribute("data-state", state);
    var mark = li.querySelector(".check__mark svg");
    if (mark) mark.outerHTML = ico(state === "fail" ? "x" : "check");
    if (o.reason != null) { var rs = li.querySelector(".check__reason span") || li.querySelector(".check__reason"); rs.textContent = o.reason; }
    if (o.end != null) li.querySelector(".check__end").textContent = o.end;
    if (o.detail != null) { var d = li.querySelector(".check__detail"); if (d) d.innerHTML = o.html ? o.detail : esc(o.detail); }
  };

  /* ── dialog: dialog-in 180ms in-out, scrim 180; out 140 in-quick ──────── */
  ui.dialog = function (o) {
    o = o || {};
    var opener = document.activeElement;
    var el = document.createElement("div");
    el.className = "dialog";
    el.innerHTML = '<div class="dialog__scrim"></div><div class="dialog__panel" role="dialog" aria-modal="true" tabindex="-1">' +
      '<div class="dialog__head"><p class="dialog__title"></p><button type="button" class="icon-btn" data-x aria-label="Close">' + ico("x") + "</button></div>" +
      '<div class="dialog__body"></div><div class="dialog__foot"></div></div>';
    var panel = el.querySelector(".dialog__panel");
    el.querySelector(".dialog__title").textContent = o.title || "";
    panel.setAttribute("aria-label", o.title || "Dialog");
    var body = el.querySelector(".dialog__body");
    if (o.body && o.body.nodeType) body.appendChild(o.body); else body.innerHTML = o.body || "";
    var foot = el.querySelector(".dialog__foot");
    (o.actions || []).forEach(function (a) {
      var b = document.createElement("button"); b.type = "button"; b.className = a.cls || "btn secondary"; b.textContent = a.label;
      b.addEventListener("click", function () { if (a.onClick) a.onClick(api); if (a.close !== false) close("action"); });
      foot.appendChild(b);
    });
    if (!foot.children.length) foot.remove();
    document.body.appendChild(el); if (BS.glass && BS.glass.adopt) BS.glass.adopt(el);
    var closed = false;
    var rec = { node: panel, kind: "dialog", close: function (r) { close(r); } };
    ui.layers.push(rec);
    try { panel.focus({ preventScroll: true }); } catch (e) {}
    function close(reason) {
      if (closed) return; closed = true;
      ui.layers.pop(rec);
      if (reduced()) el.remove();
      else { el.classList.add("is-leaving"); setTimeout(function () { el.remove(); }, scale(150)); }
      ui.layers.returnFocus(opener);
      if (typeof o.onClose === "function") o.onClose(reason);
    }
    el.querySelector("[data-x]").addEventListener("click", function () { close("x"); });
    el.querySelector(".dialog__scrim").addEventListener("click", function () { close("scrim"); });
    var api = { el: el, panel: panel, body: body, close: function () { close("api"); } };
    return api;
  };

  /* ── state markup helpers ─────────────────────────────────────────────── */
  ui.empty = function (o) {
    o = o || {};
    return '<div class="empty' + (o.bare ? " empty--bare" : "") + '" role="status">' +
      (o.icon ? '<span class="empty__icon">' + ico(o.icon) + "</span>" : "") +
      (o.title ? '<p class="empty__title">' + esc(o.title) + "</p>" : "") +
      (o.body ? '<p class="empty__body">' + esc(o.body) + "</p>" : "") +
      (o.actions ? '<div class="empty__actions">' + o.actions + "</div>" : "") + "</div>";
  };
  ui.skeleton = function (kind, n) {
    n = n || 3;
    var out = "", i;
    for (i = 0; i < n; i++) out += '<div class="skeleton-row"><span class="skeleton s-dot"></span><div><span class="skeleton s-row"></span><span class="skeleton s-row2"></span></div><span class="skeleton s-sub"></span></div>';
    return '<div class="skeleton-rows" aria-hidden="true">' + out + "</div>";
  };

  /* nothing runs at load; the site calls ui.copy() in its mount sequence */
  /* copy buttons added later (rendered blocks, sheets) get wired on click */
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-copy]:not([data-copy-wired])");
    if (!b) return;
    ui.copy(b.parentNode || document);   /* the listener is added before the event reaches b, so this click copies */
  }, true);
})();
