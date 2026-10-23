/* ============================================================================
   _shared/sheet.js — the sheet (the kit port; ui.sheet)
   Blindseal J00: the sheet.js, VERBATIM. Used for the
   attestation detail (DECISIONS D10).
   ----------------------------------------------------------------------------
   Frame: panel 70vw (max 70rem) from the right, opaque page colour, sticky
   56px GLASS header (.glass-head, DECISIONS Q6 "sheet headers"), body
   20/24/64, optional two columns (1.55fr / 1fr, gap 24). Used for the trade
   detail sheet in the Blindseal kit; in Blindseal the attestation detail (D05).
   Motion (verbatim numbers):
     arm      appended → layer pushed (Escape / Tab ownership, scroll lock on
              main#main-content) → DOUBLE rAF → .is-open (single rAF reduced)
     scrim    opacity 0 → 1, 180ms in-out, tint only
     panel    translateX(100%) → none, 340ms out-quint
     blocks   .sheet__block rise-14 400ms out-cubic at --d: main column
              .12s + i×.06s, side column .12s + (i+1)×.06s
     swap     opening while open: scrollTop 0, blocks rise again, no slide
     close    × / scrim / Escape → a frozen GHOST CLONE (aria-hidden, inert,
              every descendant animation:none) replaces the live sheet →
              reflow → .is-open removed → panel 200ms in-out, scrim 180ms →
              clone removed at 210ms. Focus returns to the opener.

   API:
     BS.openSheet(content, { title, eyebrow, id, extra, kind, trigger, param, onClose })
       → api { el, panel, body, setBody(content), setTitle(t), close(), isOpen() }
       content: a Node, an HTML string, or { main: [..], side: [..] } columns.
     BS.closeSheet() · BS.sheetOpen() · BS.sheetBlocks(scope)
   Events: "bs:sheet" { open, reason }.
   ========================================================================== */
(function () {
  "use strict";
  var BS = (window.BS = window.BS || {});

  function reduced() { return BS.motion ? BS.motion.reduced() : false; }
  function scale(ms) { return BS.motion ? BS.motion.scale(ms) : ms; }
  function raf2(fn) { requestAnimationFrame(function () { requestAnimationFrame(fn); }); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function ico(n) { return BS.icon ? BS.icon(n) : '<i data-lucide="' + n + '"></i>'; }

  function indexBlocks(scope) {
    var main = scope.querySelectorAll(".sheet__main > .sheet__block");
    var side = scope.querySelectorAll(".sheet__side > .sheet__block");
    [].forEach.call(main, function (b, i) { b.style.setProperty("--d", (0.12 + i * 0.06).toFixed(2) + "s"); });
    [].forEach.call(side, function (b, i) { b.style.setProperty("--d", (0.12 + (i + 1) * 0.06).toFixed(2) + "s"); });
    var loose = [].filter.call(scope.querySelectorAll(".sheet__block"), function (b) { return !b.parentElement.matches(".sheet__main, .sheet__side"); });
    loose.forEach(function (b, i) { b.style.setProperty("--d", (0.12 + i * 0.06).toFixed(2) + "s"); });
  }

  function asBlock(x) {
    if (x && x.nodeType === 1) {
      if (x.classList.contains("sheet__block")) return x;
      var s = document.createElement("section"); s.className = "sheet__block"; s.appendChild(x); return s;
    }
    var t = document.createElement("template");
    var html = String(x || "");
    t.innerHTML = /^\s*<section[^>]*sheet__block/.test(html) ? html : '<section class="sheet__block">' + html + "</section>";
    return t.content.firstElementChild;
  }
  function fill(body, content) {
    body.innerHTML = "";
    if (content && typeof content === "object" && !content.nodeType && (content.main || content.side)) {
      var cols = document.createElement("div"); cols.className = "sheet__cols";
      var m = document.createElement("div"); m.className = "sheet__main";
      var s = document.createElement("div"); s.className = "sheet__side";
      (content.main || []).forEach(function (x) { m.appendChild(asBlock(x)); });
      (content.side || []).forEach(function (x) { s.appendChild(asBlock(x)); });
      cols.appendChild(m); cols.appendChild(s); body.appendChild(cols);
    } else if (content && content.nodeType) {
      body.appendChild(content);
    } else {
      body.innerHTML = String(content || "");
    }
    indexBlocks(body);
  }

  /* scroll lock on the terminal's one scroller (scrollbar-gutter keeps it still) */
  var lockedEl = null, prevOverflow = "";
  function lock() {
    var m = document.getElementById("main-content");
    var el = m && /(auto|scroll)/.test(getComputedStyle(m).overflowY) ? m : document.documentElement;
    lockedEl = el; prevOverflow = el.style.overflow; el.style.overflow = "hidden";
  }
  function unlock() { if (lockedEl) { lockedEl.style.overflow = prevOverflow; lockedEl = null; } }

  function writeParam(param, on) {
    if (!param || !param.key) return;
    try {
      var u = new URL(location.href);
      if (on) u.searchParams.set(param.key, param.value); else u.searchParams.delete(param.key);
      history.replaceState(history.state, "", u.pathname + u.search + u.hash);
    } catch (e) { /* file:// may refuse; the deep link is a nicety in mockups */ }
  }

  var current = null;

  function setLead(lead, o) {
    lead.innerHTML =
      (o.eyebrow ? '<span class="sheet__eyebrow">' + esc(o.eyebrow) + "</span>" : "") +
      (o.id != null ? '<span class="sheet__id">' + esc(o.id) + "</span>" : "") +
      (o.title ? '<span class="sheet__name">' + esc(o.title) + "</span>" : "");
  }
  function setExtra(extra, x) {
    extra.innerHTML = "";
    if (!x) return;
    if (x.nodeType) extra.appendChild(x); else extra.innerHTML = String(x);
  }

  function openSheet(content, o) {
    o = o || {};
    if (current && current.isOpen()) {
      /* swap: the same frame shows another entity — top, blocks rise again */
      var c = current;
      c.panel.scrollTop = 0;
      if (c.param) writeParam(c.param, false);
      c.param = o.param || null;
      if (c.param) writeParam(c.param, true);
      c.onClose = o.onClose || null;
      setLead(c.lead, o); setExtra(c.extra, o.extra);
      c.panel.setAttribute("aria-label", (o.eyebrow ? o.eyebrow + ": " : "") + (o.title || "Details"));
      fill(c.body, content);
      return c.api;
    }

    var opener = o.trigger || document.activeElement;
    var root = document.createElement("div");
    root.className = "sheet sheet--" + (o.kind || "detail");
    root.innerHTML =
      '<div class="sheet__scrim" data-sheet-scrim></div>' +
      '<div class="sheet__panel" role="dialog" aria-modal="true" tabindex="-1">' +
        '<div class="glass-head sheet__bar"><div class="sheet__lead"></div><div class="sheet__extra"></div>' +
        '<button type="button" class="glass-item icon sheet__x" aria-label="Close">' + ico("x") + "</button></div>" +
        '<div class="sheet__body"></div>' +
      "</div>";
    var panel = root.querySelector(".sheet__panel");
    var lead = root.querySelector(".sheet__lead");
    var extra = root.querySelector(".sheet__extra");
    var body = root.querySelector(".sheet__body");
    panel.setAttribute("aria-label", (o.eyebrow ? o.eyebrow + ": " : "") + (o.title || "Details"));
    setLead(lead, o); setExtra(extra, o.extra);
    fill(body, content);
    document.body.appendChild(root); if (BS.glass && BS.glass.adopt) BS.glass.adopt(root);

    var closed = false;
    var state = { panel: panel, lead: lead, extra: extra, body: body, param: o.param || null, onClose: o.onClose || null };
    var rec = { node: panel, kind: "sheet", close: function (r) { close(r || "escape"); } };
    if (BS.ui && BS.ui.layers) BS.ui.layers.push(rec);
    lock();
    if (state.param) writeParam(state.param, true);
    if (reduced()) requestAnimationFrame(function () { root.classList.add("is-open"); });
    else raf2(function () { root.classList.add("is-open"); });
    try { panel.focus({ preventScroll: true }); } catch (e) {}

    function close(reason) {
      if (closed) return;
      closed = true;
      if (BS.ui && BS.ui.layers) BS.ui.layers.pop(rec);
      unlock();
      if (reduced() || !root.classList.contains("is-open")) {
        root.remove();
      } else {
        /* the ghost: a frozen copy plays the exit while the real one is gone */
        var ghost = root.cloneNode(true);
        ghost.setAttribute("aria-hidden", "true");
        ghost.inert = true;
        ghost.classList.add("is-ghost");
        [].forEach.call(ghost.querySelectorAll("*"), function (n) { n.style.animation = "none"; });
        var top = panel.scrollTop;
        root.replaceWith(ghost);
        var gp = ghost.querySelector(".sheet__panel");
        gp.scrollTop = top;
        void ghost.offsetWidth;
        ghost.classList.remove("is-open");
        setTimeout(function () { ghost.remove(); }, scale(210));
      }
      if (state.param) writeParam(state.param, false);
      if (reason !== "route" && BS.ui && BS.ui.layers) BS.ui.layers.returnFocus(opener);
      else if (reason !== "route") { try { (opener || document.body).focus({ preventScroll: true }); } catch (e) {} }
      if (current === state) current = null;
      if (typeof state.onClose === "function") state.onClose(reason || "x");
      document.dispatchEvent(new CustomEvent("bs:sheet", { detail: { open: false, reason: reason } }));
    }
    root.querySelector(".sheet__x").addEventListener("click", function () { close("x"); });
    root.querySelector("[data-sheet-scrim]").addEventListener("click", function () { close("scrim"); });

    state.isOpen = function () { return !closed; };
    state.api = {
      el: root, panel: panel, body: body,
      setBody: function (c) { fill(body, c); },
      setTitle: function (t) { o.title = t; setLead(lead, o); },
      close: function () { close("api"); },
      isOpen: function () { return !closed; }
    };
    current = state;
    document.dispatchEvent(new CustomEvent("bs:sheet", { detail: { open: true } }));
    return state.api;
  }

  BS.openSheet = openSheet;
  BS.closeSheet = function () { if (current) current.api.close(); };
  BS.sheetOpen = function () { return current ? current.api : null; };
  BS.sheetBlocks = indexBlocks;
})();
