/* ============================================================================
   _shared/icons.js — Lucide (the only icon set), inlined + the two logo marks
   ----------------------------------------------------------------------------
   The glyphs below are lucide-react 0.575.0's own icon nodes (the version the
   the shell and the kits pinned), copied verbatim into a static map, so the
   kit loads nothing from the network. Stroke 1.5, round caps and joins.
   Three names are Lucide aliases resolved to their canonical nodes:
   circle-help = circle-question-mark, filter = funnel, file-json = file-braces.

   THE AVOID LIST (FRONTEND §2, DECISIONS D16): no shield, lock, padlock, eye,
   eye-off or mask glyph exists in this map, and none may be added. Asking for
   one warns once and renders nothing.

   Markup: write <i data-lucide="name"></i> anywhere (data-size="20" optional).
   This file swaps each placeholder for an inline <svg class="lucide
   lucide-name"> on DOM ready and, through a MutationObserver, for anything
   added later (rendered rows, toasts, sheets). Unknown names warn once.

   API: BS.icon(name, { size, cls, label }) → HTML string (inline SVG, 16 / 20)
        BS.icons(root?)                      → swap placeholders now
        BS.ICONS                             → the glyph map
        BS.icons.mark("A" | "B", size = 20, { label, cls }) → the logo mark (D12)
          A — a circle with a single closed slot: a 1.5px ring with one short
              horizontal bar inside, centred — drawn as a closed rounded slot
              (9.5 × 2.8, r 1.4), the seal's opening, closed. Pages use A.
          B — a wax seal reduced to geometry: a 12-scallop disc outline with a
              small inner ring.
          Pure strokes in currentColor at 20 / 28 / 40px; the stroke stays 1.5px
          at every size (the viewBox stroke is scaled by 24 / size).
        BS.mark(kind, size, o) — alias.

   Also sets the favicon (mark A, ink on canvas, drawn from the tokens) on any
   page whose <link rel="icon"> is the recipe's empty "data:,".
   ========================================================================== */
(function () {
  "use strict";
  var BS = (window.BS = window.BS || {});

  var ICONS = {
    "list": [["path",{"d":"M3 5h.01"}],["path",{"d":"M3 12h.01"}],["path",{"d":"M3 19h.01"}],["path",{"d":"M8 5h13"}],["path",{"d":"M8 12h13"}],["path",{"d":"M8 19h13"}]],
    "link": [["path",{"d":"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"}],["path",{"d":"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"}]],
    "scroll-text": [["path",{"d":"M15 12h-5"}],["path",{"d":"M15 8h-5"}],["path",{"d":"M19 17V5a2 2 0 0 0-2-2H4"}],["path",{"d":"M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"}]],
    "stamp": [["path",{"d":"M14 13V8.5C14 7 15 7 15 5a3 3 0 0 0-6 0c0 2 1 2 1 3.5V13"}],["path",{"d":"M20 15.5a2.5 2.5 0 0 0-2.5-2.5h-11A2.5 2.5 0 0 0 4 15.5V17a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1z"}],["path",{"d":"M5 22h14"}]],
    "settings": [["path",{"d":"M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"}],["circle",{"cx":"12","cy":"12","r":"3"}]],
    "copy": [["rect",{"width":"14","height":"14","x":"8","y":"8","rx":"2","ry":"2"}],["path",{"d":"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"}]],
    "check": [["path",{"d":"M20 6 9 17l-5-5"}]],
    "x": [["path",{"d":"M18 6 6 18"}],["path",{"d":"m6 6 12 12"}]],
    "chevron-down": [["path",{"d":"m6 9 6 6 6-6"}]],
    "chevron-up": [["path",{"d":"m18 15-6-6-6 6"}]],
    "chevron-left": [["path",{"d":"m15 18-6-6 6-6"}]],
    "chevron-right": [["path",{"d":"m9 18 6-6-6-6"}]],
    "arrow-right": [["path",{"d":"M5 12h14"}],["path",{"d":"m12 5 7 7-7 7"}]],
    "arrow-up-right": [["path",{"d":"M7 7h10v10"}],["path",{"d":"M7 17 17 7"}]],
    "search": [["path",{"d":"m21 21-4.34-4.34"}],["circle",{"cx":"11","cy":"11","r":"8"}]],
    "menu": [["path",{"d":"M4 5h16"}],["path",{"d":"M4 12h16"}],["path",{"d":"M4 19h16"}]],
    "download": [["path",{"d":"M12 15V3"}],["path",{"d":"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"}],["path",{"d":"m7 10 5 5 5-5"}]],
    "upload": [["path",{"d":"M12 3v12"}],["path",{"d":"m17 8-5-5-5 5"}],["path",{"d":"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"}]],
    "refresh-cw": [["path",{"d":"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"}],["path",{"d":"M21 3v5h-5"}],["path",{"d":"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"}],["path",{"d":"M8 16H3v5"}]],
    "rotate-ccw": [["path",{"d":"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"}],["path",{"d":"M3 3v5h5"}]],
    "play": [["path",{"d":"M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"}]],
    "pause": [["rect",{"x":"14","y":"3","width":"5","height":"18","rx":"1"}],["rect",{"x":"5","y":"3","width":"5","height":"18","rx":"1"}]],
    "external-link": [["path",{"d":"M15 3h6v6"}],["path",{"d":"M10 14 21 3"}],["path",{"d":"M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"}]],
    "file-check": [["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"m9 15 2 2 4-4"}]],
    "radio": [["path",{"d":"M16.247 7.761a6 6 0 0 1 0 8.478"}],["path",{"d":"M19.075 4.933a10 10 0 0 1 0 14.134"}],["path",{"d":"M4.925 19.067a10 10 0 0 1 0-14.134"}],["path",{"d":"M7.753 16.239a6 6 0 0 1 0-8.478"}],["circle",{"cx":"12","cy":"12","r":"2"}]],
    "server": [["rect",{"width":"20","height":"8","x":"2","y":"2","rx":"2","ry":"2"}],["rect",{"width":"20","height":"8","x":"2","y":"14","rx":"2","ry":"2"}],["line",{"x1":"6","x2":"6.01","y1":"6","y2":"6"}],["line",{"x1":"6","x2":"6.01","y1":"18","y2":"18"}]],
    "cpu": [["path",{"d":"M12 20v2"}],["path",{"d":"M12 2v2"}],["path",{"d":"M17 20v2"}],["path",{"d":"M17 2v2"}],["path",{"d":"M2 12h2"}],["path",{"d":"M2 17h2"}],["path",{"d":"M2 7h2"}],["path",{"d":"M20 12h2"}],["path",{"d":"M20 17h2"}],["path",{"d":"M20 7h2"}],["path",{"d":"M7 20v2"}],["path",{"d":"M7 2v2"}],["rect",{"x":"4","y":"4","width":"16","height":"16","rx":"2"}],["rect",{"x":"8","y":"8","width":"8","height":"8","rx":"1"}]],
    "terminal": [["path",{"d":"M12 19h8"}],["path",{"d":"m4 17 6-6-6-6"}]],
    "box": [["path",{"d":"M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"}],["path",{"d":"m3.3 7 8.7 5 8.7-5"}],["path",{"d":"M12 22V12"}]],
    "layers": [["path",{"d":"M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"}],["path",{"d":"M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"}],["path",{"d":"M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"}]],
    "git-commit-horizontal": [["circle",{"cx":"12","cy":"12","r":"3"}],["line",{"x1":"3","x2":"9","y1":"12","y2":"12"}],["line",{"x1":"15","x2":"21","y1":"12","y2":"12"}]],
    "clock": [["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 6v6l4 2"}]],
    "sun": [["circle",{"cx":"12","cy":"12","r":"4"}],["path",{"d":"M12 2v2"}],["path",{"d":"M12 20v2"}],["path",{"d":"m4.93 4.93 1.41 1.41"}],["path",{"d":"m17.66 17.66 1.41 1.41"}],["path",{"d":"M2 12h2"}],["path",{"d":"M20 12h2"}],["path",{"d":"m6.34 17.66-1.41 1.41"}],["path",{"d":"m19.07 4.93-1.41 1.41"}]],
    "moon": [["path",{"d":"M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"}]],
    "circle-alert": [["circle",{"cx":"12","cy":"12","r":"10"}],["line",{"x1":"12","x2":"12","y1":"8","y2":"12"}],["line",{"x1":"12","x2":"12.01","y1":"16","y2":"16"}]],
    "circle-check": [["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"m9 12 2 2 4-4"}]],
    "minus": [["path",{"d":"M5 12h14"}]],
    "plus": [["path",{"d":"M5 12h14"}],["path",{"d":"M12 5v14"}]],
    "info": [["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 16v-4"}],["path",{"d":"M12 8h.01"}]],
    "triangle-alert": [["path",{"d":"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"}],["path",{"d":"M12 9v4"}],["path",{"d":"M12 17h.01"}]],
    "panel-left": [["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M9 3v18"}]],
    "circle-help": [["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"}],["path",{"d":"M12 17h.01"}]],
    "filter": [["path",{"d":"M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z"}]],
    "file-json": [["path",{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"}],["path",{"d":"M14 2v5a1 1 0 0 0 1 1h5"}],["path",{"d":"M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1"}],["path",{"d":"M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1"}]],
  };
  var FORBIDDEN = { shield: 1, "shield-check": 1, lock: 1, "lock-open": 1, padlock: 1, eye: 1, "eye-off": 1, mask: 1, "venetian-mask": 1 };

  var warned = {};
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function inner(name) {
    if (FORBIDDEN[name]) return null;
    var n = ICONS[name];
    if (!n) return null;
    return n.map(function (c) {
      var at = Object.keys(c[1]).map(function (k) { return k + '="' + esc(c[1][k]) + '"'; }).join(" ");
      return "<" + c[0] + " " + at + "/>";
    }).join("");
  }

  /** HTML string for an icon. */
  function icon(name, o) {
    o = o || {};
    var body = inner(name);
    if (body == null) {
      if (!warned[name]) { warned[name] = 1; console.warn("[BS] unknown or forbidden icon: " + name); }
      body = "";
    }
    var size = o.size ? ' style="width:' + o.size + "px;height:" + o.size + 'px"' : "";
    var cls = o.cls ? " " + esc(o.cls) : "";
    var a11y = o.label ? ' role="img" aria-label="' + esc(o.label) + '"' : ' aria-hidden="true" focusable="false"';
    return '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-' + esc(name) + cls + '" data-lucide="' + esc(name) + '"' + a11y + size + ">" + body + "</svg>";
  }

  /* ── the logo marks (D12) ─────────────────────────────────────────────── */
  function scallopPath() {
    /* 12 points on a circle (R 9.3), joined by shallow outward arcs (r 3.4): the wax
       seal's scalloped rim, reduced to one stroke */
    var R = 9.3, r = 3.4, d = "";
    for (var i = 0; i <= 12; i++) {
      var a = (i * 30 - 90) * Math.PI / 180;
      var x = (12 + R * Math.cos(a)).toFixed(3), y = (12 + R * Math.sin(a)).toFixed(3);
      d += i === 0 ? "M" + x + " " + y : "A" + r + " " + r + " 0 0 1 " + x + " " + y;
    }
    return d + "Z";
  }
  var SCALLOP = scallopPath();
  function mark(kind, size, o) {
    o = o || {};
    size = Number(size) || 20;
    var sw = (1.5 * 24 / size).toFixed(3);
    var body = kind === "B"
      ? '<path d="' + SCALLOP + '"/><circle cx="12" cy="12" r="3.4"/>'
      : '<circle cx="12" cy="12" r="10.25"/><rect x="7.25" y="10.6" width="9.5" height="2.8" rx="1.4"/>';
    var a11y = o.label ? ' role="img" aria-label="' + esc(o.label) + '"' : ' aria-hidden="true" focusable="false"';
    return '<svg xmlns="http://www.w3.org/2000/svg" class="bs-mark bs-mark--' + (kind === "B" ? "B" : "A") + (o.cls ? " " + esc(o.cls) : "") +
      '" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + sw +
      '" stroke-linecap="round" stroke-linejoin="round"' + a11y + ">" + body + "</svg>";
  }

  /** Swap one <i data-lucide> placeholder for the inline SVG. */
  function swap(el) {
    var name = el.getAttribute("data-lucide");
    var tpl = document.createElement("template");
    tpl.innerHTML = icon(name, { size: el.getAttribute("data-size"), cls: el.className || "", label: el.getAttribute("aria-label") });
    var svg = tpl.content.firstElementChild;
    var st = el.getAttribute("style");
    if (st) svg.setAttribute("style", (svg.getAttribute("style") || "") + ";" + st);
    if (el.parentNode) el.parentNode.replaceChild(svg, el);
  }

  function icons(root) {
    root = root || document;
    if (root.nodeType === 1 && root.matches("i[data-lucide]")) { swap(root); return; }
    [].forEach.call(root.querySelectorAll ? root.querySelectorAll("i[data-lucide]") : [], swap);
  }

  /* the favicon: mark A in ink on the canvas, coloured from the tokens */
  function favicon() {
    var link = document.querySelector('link[rel~="icon"]');
    if (link && link.getAttribute("href") !== "data:,") return;
    var cs = getComputedStyle(document.documentElement);
    var bg = cs.getPropertyValue("--canvas").trim(), ink = cs.getPropertyValue("--ink").trim();
    if (!bg || !ink) return;
    var svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='16' fill='" + bg + "'/>" +
      "<circle cx='32' cy='32' r='19' fill='none' stroke='" + ink + "' stroke-width='4'/><rect x='22' y='29' width='20' height='6' rx='3' fill='none' stroke='" + ink + "' stroke-width='3.5'/></svg>";
    if (!link) { link = document.createElement("link"); link.rel = "icon"; (document.head || document.documentElement).appendChild(link); }
    link.href = "data:image/svg+xml," + encodeURIComponent(svg);
  }

  icons.mark = mark;
  BS.ICONS = ICONS;
  BS.icon = icon;
  BS.icons = icons;
  BS.mark = mark;

  function boot() {
    favicon();
    icons(document);
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var nd = added[j];
          if (nd.nodeType !== 1) continue;
          if (nd.tagName === "I" && nd.hasAttribute("data-lucide")) swap(nd);
          else if (nd.querySelector && nd.querySelector("i[data-lucide]")) icons(nd);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
