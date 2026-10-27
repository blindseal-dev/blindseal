/* ============================================================================
   _shared/diagrams.js — BS.diagrams: the kit's draw-in figures (J0D)
   ----------------------------------------------------------------------------
   Plain IIFE, no dependencies. Needs diagrams.css. Uses BS.motion when it is
   loaded (mountDrawIn / redraw: the kit engine), otherwise its own
   IntersectionObserver with the same contract (rootMargin "0px 0px -12% 0px",
   once, double rAF, .is-armed → .is-drawn). Same classes either way.

   API (window.BS.diagrams):
     list                         ["flow4", "architecture", "lifecycle", "chain", "layers"]
     render(name, host, opts)     builds the SVG into host (a <figure class="fig">,
                                  an element or a selector), arms it, returns host.
                                  Called again on a host that has already drawn,
                                  it UPDATES in place: what stays transitions
                                  (fills, strokes, progress), what is new draws in,
                                  what is gone fades out. Nothing redraws.
     replay(host)                 draws the figure again from nothing.
     mount(scope)                 renders every [data-diagram="name"] in scope,
                                  options from data-opts='{"active":"prove"}'.
                                  Mounted by the site after hydration.
     check(scope)                 → { paths, missing }  every path[data-draw] has
                                  pathLength="1" (the demo logs it).

   Options common to all: caption (string | false; default sentence below the
   figure, only added when the host has no figcaption), label (aria-label).

     flow4         active: 0-3 | "screen" | "attest" | "prove" | "verify"
     architecture  focus: "agent" | "proxy" | "tools" | "prover" | "audit" | "verifier"
     lifecycle     status: "decision" | "requested" | "generating" | "generated" |
                           "submitted" | "consumed" | "expired" | "rejected" | "failed"
     chain         window: [from, to]  (audit indexes) · brokenAt: n (audit index)
                   start: first index (default 1) · entries: [{index, hash}] (fixtures,
                   first 10 used; replaces start) · count: 10
     layers        highlight: "L0".."L3" (or an array) · verdict: "pass" | "block" |
                   "flag" | "skip" · results: [{layer, verdict}] (a Decision's
                   layers; colours every band, overrides highlight)

   Markup contract (shared with the kit's motion.css):
     path[data-draw][pathLength="1"] style="--i:n"   stroke draw, n × 80ms
     [data-draw-tip]    arrowheads   [data-draw-fill]  node fills
     [data-draw-fade]   [data-draw-label] (4px rise)    --labels-delay = steps × 80ms
   Colours: only tokens via diagrams.css classes. No literal colour here.
   ========================================================================== */
(function () {
  "use strict";
  var BS = (window.BS = window.BS || {});
  if (BS.diagrams) return;

  var NS = "http://www.w3.org/2000/svg";
  var STAGGER = 80;        /* ms per draw step (the kit ProtocolPage.tsx:122) */
  var LEAVE = 160;         /* ms exit fade before removal */
  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  var uidN = 0;

  /* ── motion plumbing ──────────────────────────────────────────────────── */
  function kit() { return (BS.motion && BS.motion.mountDrawIn) ? BS.motion : null; }
  function anyKit() {
    var m = BS.motion || (window.PF && window.PF.motion);
    return m && typeof m.syncMotionAttr === "function" ? m : null;
  }
  /* no kit at all: honour ?motion=reduce|slow|full ourselves (same grammar as the kit) */
  (function ownMotionAttr() {
    if (anyKit() || root.hasAttribute("data-motion")) return;
    var q = /[?&]motion=(reduce|slow|full)\b/.exec(location.search || "");
    if (q && q[1] !== "full") root.setAttribute("data-motion", q[1]);
  })();
  function reduced() {
    var m = BS.motion || (window.PF && window.PF.motion);
    if (m && typeof m.reduced === "function") return !!m.reduced();
    var a = root.getAttribute("data-motion");
    if (a === "reduce") return true;
    if (a === "slow" || a === "full") return false;
    return !!mq.matches;
  }
  function raf2(fn) { return requestAnimationFrame(function () { requestAnimationFrame(fn); }); }
  function scrollRoot() {
    var m = document.getElementById("main-content");
    if (!m) return null;
    var oy = getComputedStyle(m).overflowY;
    return (oy === "auto" || oy === "scroll") ? m : null;
  }
  function ownDrawIn(el) {
    el.classList.add("is-armed");
    if (reduced() || !("IntersectionObserver" in window)) { el.classList.add("is-drawn"); return function () {}; }
    var sr = scrollRoot();
    var done = false;
    var io = new IntersectionObserver(function (es) {
      if (es.some(function (e) { return e.isIntersecting; })) draw();
    }, { root: sr, rootMargin: "0px 0px -12% 0px" });
    function stop() { io.disconnect(); }
    function draw() {
      if (done) return;
      done = true; stop();
      raf2(function () { el.classList.add("is-drawn"); });
    }
    io.observe(el);
    return stop;
  }
  function arm(host) {
    host.setAttribute("data-dg-rate", anyKit() ? "kit" : "css");
    var k = kit();
    if (k) { host.setAttribute("data-dg-engine", "kit"); return k.mountDrawIn(host) || function () {}; }
    host.setAttribute("data-dg-engine", "own");
    return ownDrawIn(host);
  }

  /* ── tiny SVG builder ─────────────────────────────────────────────────── */
  function Builder(uid, w, h, aria) {
    this.uid = uid; this.n = 0; this.steps = 0;
    this.svg = document.createElementNS(NS, "svg");
    this.svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    this.svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    this.svg.setAttribute("role", "img");
    this.svg.setAttribute("aria-label", aria || "");
    this.svg.setAttribute("focusable", "false");
    this.cur = this.svg;
  }
  Builder.prototype.add = function (tag, a, txt) {
    var e = document.createElementNS(NS, tag);
    a = a || {};
    e.setAttribute("data-k", a.k || ("a" + (this.n++)));
    var style = "";
    for (var key in a) {
      if (!Object.prototype.hasOwnProperty.call(a, key)) continue;
      var v = a[key];
      if (key === "k" || v == null || v === false) continue;
      if (key === "cls") e.setAttribute("class", v);
      else if (key === "i") { style += "--i:" + v + ";"; if (v + 1 > this.steps) this.steps = v + 1; }
      else if (key === "li") style += "--li:" + v + ";";
      else if (key === "to") style += "--to:" + v + ";";
      else e.setAttribute(key, v === true ? "" : String(v));
    }
    if (style) e.setAttribute("style", style);
    if (txt != null) e.textContent = txt;
    this.cur.appendChild(e);
    return e;
  };
  Builder.prototype.g = function (a, fn) {
    var e = this.add("g", a), p = this.cur;
    this.cur = e; fn(); this.cur = p;
    return e;
  };
  /* a drawn stroke: path + pathLength=1 + data-draw + --i */
  Builder.prototype.draw = function (d, cls, i, a) {
    a = a || {};
    a.d = d; a.pathLength = 1; a.cls = cls; a.i = i;
    a["data-draw"] = a.fast ? "fast" : ""; delete a.fast;
    return this.add("path", a);
  };
  Builder.prototype.tip = function (d, cls, i, a) {
    a = a || {}; a.d = d; a.cls = cls; a.i = i; a["data-draw-tip"] = "";
    return this.add("path", a);
  };
  Builder.prototype.fill = function (d, cls, i, a) {
    a = a || {}; a.d = d; a.cls = "dg-fill " + (cls || ""); a.i = i; a["data-draw-fill"] = "";
    return this.add("path", a);
  };
  Builder.prototype.text = function (x, y, s, cls, li, anchor, a) {
    a = a || {};
    a.x = x; a.y = y; a.cls = cls; a.li = li || 0; a["text-anchor"] = anchor || "middle";
    a["data-draw-label"] = "";
    return this.add("text", a, s);
  };

  /* a copyable hash label: <g role="button" tabindex="0" data-dg-hash="full"> holding a
     fixed-width hit / focus-ring rect (the label can swap to "Copied" without anything moving,
     text-anchor is middle), a <title> with the full value for hover, and the short text */
  Builder.prototype.hash = function (x, y, full, w, cls, li, key, label, hh) {
    var self = this, txt = null;
    hh = hh || 16;   /* the hit / focus-ring height (the phone variant: 44) */
    this.interactive = true;
    this.g({ k: key + "g", cls: "dg-hashbtn", role: "button", tabindex: "0", "data-dg-hash": full,
             "aria-label": (label ? label + " " : "") + full + ". Copy" }, function () {
      self.add("title", { k: key + "t" }, (label ? label + " " : "") + full);
      self.add("rect", { k: key + "r", cls: "dg-hashhit", x: f(x - w / 2), y: f(y - hh / 2), width: f(w), height: hh, rx: 3 });
      txt = self.text(x, y, shortHash(full), cls, li, "middle", { k: key });
    });
    return txt;
  };

  /* ── geometry ─────────────────────────────────────────────────────────── */
  function f(n) { return Math.round(n * 100) / 100; }
  function rr(x, y, w, h, r) {
    r = r == null ? 6 : r;
    return "M" + f(x + r) + " " + f(y) + "H" + f(x + w - r) + "A" + r + " " + r + " 0 0 1 " + f(x + w) + " " + f(y + r) +
      "V" + f(y + h - r) + "A" + r + " " + r + " 0 0 1 " + f(x + w - r) + " " + f(y + h) +
      "H" + f(x + r) + "A" + r + " " + r + " 0 0 1 " + f(x) + " " + f(y + h - r) +
      "V" + f(y + r) + "A" + r + " " + r + " 0 0 1 " + f(x + r) + " " + f(y) + "Z";
  }
  function ring(cx, cy, r) {
    return "M" + f(cx) + " " + f(cy - r) + "A" + r + " " + r + " 0 1 1 " + f(cx) + " " + f(cy + r) +
      "A" + r + " " + r + " 0 1 1 " + f(cx) + " " + f(cy - r) + "Z";
  }
  /* open chevrons (the kit about ARROWS: "l8 6-8 6"), tip at (x, y) */
  function chevR(x, y) { return "M" + f(x - 7) + " " + f(y - 5) + "L" + f(x) + " " + f(y) + "L" + f(x - 7) + " " + f(y + 5); }
  function chevL(x, y) { return "M" + f(x + 7) + " " + f(y - 5) + "L" + f(x) + " " + f(y) + "L" + f(x + 7) + " " + f(y + 5); }
  function chevD(x, y) { return "M" + f(x - 5) + " " + f(y - 7) + "L" + f(x) + " " + f(y) + "L" + f(x + 5) + " " + f(y - 7); }
  /* a dashed vertical rule as real subpaths, so it still draws in with dashoffset;
     skip: [[y1, y2], …] gaps where a path crosses it */
  function dashV(x, y1, y2, on, off, skip) {
    var d = "", y = y1;
    skip = skip || [];
    while (y < y2) {
      var e = Math.min(y + on, y2), hit = false;
      for (var s = 0; s < skip.length; s++) if (e > skip[s][0] && y < skip[s][1]) hit = true;
      if (!hit) d += "M" + f(x) + " " + f(y) + "V" + f(e);
      y += on + off;
    }
    return d;
  }
  function dashH(x1, x2, y, on, off) {
    var d = "", x = x1;
    while (x < x2) { d += "M" + f(x) + " " + f(y) + "H" + f(Math.min(x + on, x2)); x += on + off; }
    return d;
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  /* the redaction hatch, one <defs> per figure, id unique per host */
  function hatch(b, id) {
    var defs = document.createElementNS(NS, "defs"), p = document.createElementNS(NS, "pattern"), l = document.createElementNS(NS, "path");
    defs.setAttribute("data-k", "defs");
    p.setAttribute("data-k", "pat"); p.setAttribute("id", id);
    p.setAttribute("width", "5"); p.setAttribute("height", "5");
    p.setAttribute("patternUnits", "userSpaceOnUse"); p.setAttribute("patternTransform", "rotate(45)");
    l.setAttribute("data-k", "patl"); l.setAttribute("d", "M0 0V5"); l.setAttribute("class", "dg-hatch-line");
    p.appendChild(l); defs.appendChild(p); b.svg.insertBefore(defs, b.svg.firstChild);
  }
  /* deterministic placeholder hashes (64 hex) when no fixture entries are given */
  function hex64(seed) {
    var s = (Math.imul(seed + 1, 2654435761) >>> 0) || 1, out = "";
    for (var i = 0; i < 8; i++) {
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      out += ("00000000" + s.toString(16)).slice(-8);
    }
    return out;
  }
  /* the kit's rule (fixtures BS.fmt, ui.js): the 0x prefix decides. 0x-hex → first 6 + "…" +
     last 4 ("0x1234…abcd"); anything else is base58 → 4 + "…" + 4 */
  function shortHash(h) {
    h = String(h == null ? "" : h);
    if (/^0x/i.test(h)) return h.length <= 12 ? h : h.slice(0, 6) + "…" + h.slice(-4);
    return h.length <= 9 ? h : h.slice(0, 4) + "…" + h.slice(-4);
  }

  /* ── 1 · flow4: screen → attest → prove → verify ─────────────────────── */
  var FLOW = [
    { k: "screen", t: "Screen", s: "every tool call, four layers" },
    { k: "attest", t: "Attest", s: "a one-time stamp bound to the action" },
    { k: "prove", t: "Prove", s: "generated locally, Groth16" },
    { k: "verify", t: "Verify", s: "one Solana instruction" }
  ];
  function flow4(o, uid) {
    var act = o.active;
    if (typeof act === "string") act = FLOW.map(function (n) { return n.k; }).indexOf(act);
    if (typeof act !== "number" || act < 0 || act > 3) act = -1;
    var aria = "Four steps: screen, attest, prove, verify. Screening, attestation and proving stay on the machine; " +
      "the proof is verified publicly with one Solana instruction." + (act >= 0 ? " Highlighted: " + FLOW[act].k + "." : "");
    var b = new Builder(uid, 1020, 216, o.label || aria);
    var W = 186, H = 64, Y = 52, G = 68, X0 = 36, CY = Y + H / 2, RULE = 764;
    /* the hidden | public rule sits under everything; gapped where the accent path crosses */
    b.draw(dashV(RULE, 14, 202, 4, 4, [[CY - 10, CY + 10]]), "dg-rule", 7, { k: "rule", fast: true });
    FLOW.forEach(function (n, k) {
      var x = X0 + k * (W + G), cx = x + W / 2, i = k * 2, on = k === act ? " is-active" : "";
      b.fill(rr(x, Y, W, H, 6), on, i, { k: "nf" + k });
      b.draw(rr(x, Y, W, H, 6), "dg-node" + on, i, { k: "n" + k });
      b.text(cx, 34, pad2(k + 1), "dg-num", k, "middle", { k: "ni" + k });
      b.text(cx, CY, n.t, "dg-title" + on, k, "middle", { k: "nt" + k });
      b.text(cx, Y + H + 24, n.s, "dg-sub", k, "middle", { k: "ns" + k });
      if (k < 3) {
        var x2 = x + W + G, cls = k === 2 ? "dg-accent" : "dg-conn";
        b.draw("M" + (x + W) + " " + CY + "H" + (x2 - 4), cls, i + 1, { k: "c" + k });
        b.tip(chevR(x2 - 4, CY), cls, i + 1, { k: "ct" + k });
      }
    });
    var xEnd3 = X0 + 2 * (W + G) + W, x4 = X0 + 3 * (W + G);
    b.draw("M" + X0 + " 160V166H" + xEnd3 + "V160", "dg-conn", 8, { k: "br0" });
    b.draw("M" + x4 + " 160V166H" + (x4 + W) + "V160", "dg-conn", 9, { k: "br1" });   /* one accent path per figure (D07) */
    b.text((X0 + xEnd3) / 2, 188, "stays on the machine", "dg-label", 4, "middle", { k: "brl0" });
    b.text(x4 + W / 2, 188, "public", "dg-label is-accent", 5, "middle", { k: "brl1" });
    return { b: b, caption: "Nothing sensitive leaves the machine. Only the proof crosses the rule, and one Solana instruction verifies it." };
  }

  /* ── 2 · architecture: agent → proxy (L0–L3) → tools; prover, audit log, verifier ── */
  var LAYERS = [
    { id: "L0", name: "Decode", sees: "raw payload", kind: "not in proof yet" },
    { id: "L1", name: "Patterns", sees: "raw payload", kind: "proven" },
    { id: "L2", name: "Similarity", sees: "redacted payload", kind: "attested" },
    { id: "L3", name: "Judge", sees: "redacted payload", kind: "attested" }
  ];
  function architecture(o, uid) {
    var focus = o.focus || "";
    var on = function (k) { return focus === k ? " is-active" : ""; };
    var aria = "Architecture. The agent calls its tools through the proxy on the same machine; the proxy screens every call " +
      "with four layers (L0 decode, L1 patterns, L2 similarity, L3 judge), redacting secrets and PII before L2. The proof covers L1 today; L0 runs in the proxy and is not in the proof yet. " +
      "Every decision is written to a hash-chained audit log. The prover makes a zero-knowledge attestation; " +
      "only the proof and its public inputs cross to the public side, where the Solana verifier checks it in one instruction.";
    var b = new Builder(uid, 1066, 500, o.label || aria);
    var hid = "dg" + uid + "-hatch";
    hatch(b, hid);
    var RULE = 846;
    /* step plan (--i): 0 agent · 1 agent→proxy · 2 proxy · 3-4 L0 L1 · 5 gate · 6-7 L2 L3 ·
       8 fan · 9 tools · 10 down-links · 11 log + prover · 12 rule · 13 accent · 14 verifier · 15 inputs */
    b.draw(dashV(RULE, 44, 488, 4, 4, [[430, 450]]), "dg-rule", 12, { k: "rule", fast: false });
    b.text(RULE - 14, 30, "stays on the machine", "dg-label", 12, "end", { k: "rl0" });
    b.text(RULE + 14, 30, "public", "dg-label is-accent", 12, "start", { k: "rl1" });

    /* agent */
    b.fill(rr(24, 92, 132, 64, 6), on("agent"), 0, { k: "agf" });
    b.draw(rr(24, 92, 132, 64, 6), "dg-node" + on("agent"), 0, { k: "ag" });
    b.text(90, 112, "Agent", "dg-title" + on("agent"), 0, "middle", { k: "agt" });
    b.text(90, 136, "MCP client", "dg-sub", 0, "middle", { k: "ags" });
    b.draw("M156 124H208", "dg-conn", 1, { k: "c-ag" });
    b.tip(chevR(208, 124), "dg-conn", 1, { k: "c-agt" });

    /* the proxy */
    b.fill(rr(212, 56, 340, 292, 8), on("proxy"), 2, { k: "pxf" });
    b.draw(rr(212, 56, 340, 292, 8), "dg-node" + on("proxy"), 2, { k: "px" });
    b.text(232, 80, "The proxy", "dg-title" + on("proxy"), 2, "start", { k: "pxt" });
    b.text(532, 80, "127.0.0.1", "dg-idx", 2, "end", { k: "pxs" });
    var bandY = [100, 152, 228, 280];
    LAYERS.forEach(function (L, k) {
      var y = bandY[k], i = k < 2 ? 3 + k : 4 + k;
      b.draw(rr(232, y, 300, 44, 4), "dg-node", i, { k: "band" + k });
      b.text(248, y + 22, L.id, "dg-idx", i, "start", { k: "bid" + k });
      b.text(280, y + 22, L.name, "dg-title", i, "start", { k: "bn" + k });
      b.text(516, y + 22, L.kind, "dg-label", i, "end", { k: "bk" + k });
    });
    /* the redaction gate between L1 and L2: a short hatched bar */
    b.add("path", { k: "gatef", d: "M232 207H292V217H232Z", fill: "url(#" + hid + ")", cls: "dg-fill--hatch", i: 5, "data-draw-fill": "" });
    b.draw("M232 207H292V217H232Z", "dg-conn", 5, { k: "gate", fast: true });
    b.text(304, 212, "secrets and PII redacted", "dg-label", 5, "start", { k: "gatel" });

    /* tools: fan out after L3 */
    var TOOLS = ["MCP server", "RPC", "Filesystem"], TY = [186, 246, 306];
    b.text(720, 160, "tools", "dg-label", 8, "middle", { k: "tl" });
    TOOLS.forEach(function (t, k) {
      var y = TY[k];
      var d = k === 2 ? "M552 306H636" : "M552 306H596V" + y + "H636";
      b.draw(d, "dg-conn", 8, { k: "fan" + k });
      b.tip(chevR(636, y), "dg-conn", 8, { k: "fant" + k });
      b.fill(rr(640, y - 20, 160, 40, 6), on("tools"), 9, { k: "tf" + k });
      b.draw(rr(640, y - 20, 160, 40, 6), "dg-node" + on("tools"), 9, { k: "tn" + k });
      b.text(720, y, t, "dg-sub" + on("tools"), 9, "middle", { k: "tt" + k });
    });

    /* audit log: four linked blocks, fed from the proxy */
    b.text(212, 404, "audit log", "dg-label" + on("audit"), 10, "start", { k: "all" });
    b.draw("M365 348V418", "dg-conn", 10, { k: "c-al" });
    b.tip(chevD(365, 418), "dg-conn", 10, { k: "c-alt" });
    for (var a = 0; a < 4; a++) {
      var ax = 212 + a * 46;
      b.fill(rr(ax, 424, 30, 28, 4), on("audit"), 11, { k: "abf" + a });
      b.draw(rr(ax, 424, 30, 28, 4), "dg-node" + on("audit"), 11, { k: "ab" + a });
      if (a < 3) b.draw("M" + (ax + 30) + " 438H" + (ax + 46), "dg-conn", 11, { k: "abl" + a, fast: true });
    }
    b.text(212, 470, "hash-chained, local", "dg-idx", 11, "start", { k: "als" });

    /* prover */
    b.draw("M482 348V404", "dg-conn", 10, { k: "c-pr" });
    b.tip(chevD(482, 404), "dg-conn", 10, { k: "c-prt" });
    b.fill(rr(412, 408, 200, 64, 6), on("prover"), 11, { k: "prf" });
    b.draw(rr(412, 408, 200, 64, 6), "dg-node" + on("prover"), 11, { k: "pr" });
    b.text(512, 428, "Prover", "dg-title" + on("prover"), 11, "middle", { k: "prt" });
    b.text(512, 452, "zero-knowledge attestation", "dg-sub", 11, "middle", { k: "prs" });

    /* the one accent path: prover → verifier, across the rule */
    b.draw("M612 440H876", "dg-accent", 13, { k: "acc" });
    b.tip(chevR(876, 440), "dg-accent", 13, { k: "acct" });
    b.text(729, 424, "proof · public inputs", "dg-label", 13, "middle", { k: "accl" });

    /* Solana verifier */
    b.fill(rr(880, 408, 162, 64, 6), on("verifier"), 14, { k: "vff" });
    b.draw(rr(880, 408, 162, 64, 6), "dg-node" + on("verifier"), 14, { k: "vf" });
    b.text(961, 428, "Solana verifier", "dg-title" + on("verifier"), 14, "middle", { k: "vft" });
    b.text(961, 452, "one instruction", "dg-sub", 14, "middle", { k: "vfs" });

    /* what the verifier sees: the public inputs (FRONTEND §1.3 step 3) */
    var PUB = ["action hash", "policy root", "detector version", "expiry slot", "nullifier"];
    b.draw("M872 252V372", "dg-conn", 15, { k: "pubr", fast: true });
    b.text(884, 236, "public inputs", "dg-label", 15, "start", { k: "publ" });
    PUB.forEach(function (p, k) { b.text(884, 262 + k * 24, p, "dg-idx", 15, "start", { k: "pub" + k }); });
    /* leader: the inputs travel with the proof into the verifier */
    b.draw("M872 372V388H961V403", "dg-conn", 15, { k: "publead" });
    b.tip(chevD(961, 403), "dg-conn", 15, { k: "publeadt" });
    return { b: b, caption: "Left of the rule stays on the machine. The verifier sees a proof and five public inputs, never the call." };
  }

  /* ── 3 · lifecycle: decision → … → consumed ───────────────────────────── */
  var LIFE = ["decision", "requested", "generating", "generated", "submitted", "consumed"];
  var LIFE_END = { expired: 3, rejected: 4, failed: 2 };
  var LIFE_NOTE = { expired: "expired before use", rejected: "rejected by the verifier", failed: "proof generation failed" };
  function lifecycle(o, uid) {
    var st = String(o.status || "consumed");
    var reach = LIFE.indexOf(st);
    if (reach < 0) reach = LIFE_END.hasOwnProperty(st) ? LIFE_END[st] : 5;
    /* rejected / failed stop ON a node: it is reached by the track, not filled, and carries a muted ✕ */
    var stop = (st === "rejected" || st === "failed") ? reach : -1;
    var expired = st === "expired";
    var note = LIFE_NOTE[st] || "";
    var aria = "Attestation lifecycle: decision, requested, generating, generated, submitted, consumed. " +
      "Valid until its expiry slot; consuming it spends the nullifier, so it is single-use. Current status: " + st + ".";
    var b = new Builder(uid, 1020, 220, o.label || aria);
    var X0 = 90, STEP = 168, Y = 92, R = 7, GAP = 13;
    var xs = LIFE.map(function (_, k) { return X0 + k * STEP; });
    /* the track runs between the nodes, never under them */
    var track = "";
    for (var k = 0; k < 5; k++) track += "M" + (xs[k] + GAP) + " " + Y + "H" + (xs[k + 1] - GAP);
    b.draw(track, "dg-conn", 0, { k: "track" });
    /* progress: one accent path per REACHED segment (Chromium restarts the dash on every
       M subpath, so a partial --to on the five-piece track drew all five). Each segment is
       keyed, so a status change on a drawn figure draws new segments in and fades dropped
       ones; a rejected / failed node keeps the segment leading into it and nothing past it. */
    for (var pk = 0; pk < reach; pk++) {
      b.draw("M" + (xs[pk] + GAP) + " " + Y + "H" + (xs[pk + 1] - GAP), "dg-accent", 2 + pk, { k: "pg" + pk });
    }
    LIFE.forEach(function (name, k) {
      var x = xs[k], done = k <= reach && k !== stop, hit = done ? " is-reached" : "", i = 1 + k;
      if (k < 5) {
        b.fill(ring(x, Y, R), "dg-fill--clear" + hit, i, { k: "lf" + k });
        b.draw(ring(x, Y, R), "dg-node dg-conn" + (done ? " is-active" : ""), i, { k: "ln" + k });
      }
      b.text(x, 60, name, "dg-label" + (k === reach ? " is-active" : ""), k, "middle", { k: "ll" + k });
      b.text(x, 38, pad2(k + 1), "dg-num", k, "middle", { k: "lx" + k });
    });
    /* consumed = the closed-slot mark: a ring with one short bar (the seal's slot, closed) */
    var xc = xs[5], spent = reach >= 5 ? " is-active" : "";
    b.draw(ring(xc, Y, 10), "dg-node dg-conn" + spent, 6, { k: "nul" });
    /* the slot closes only when the nullifier is spent; before that the ring is open */
    b.draw("M" + (xc - 5) + " " + Y + "H" + (xc + 5), spent ? "dg-conn dg-accent" : "dg-conn is-off", 7, { k: "slot", fast: true });
    b.text(xc, 118, "nullifier", "dg-idx", 6, "middle", { k: "nulx" });
    /* expiry: a ticked ruler under the last three nodes, ending on the expiry slot */
    var R0 = xs[3] - 10, R1 = 978, RY = 150;
    b.draw("M" + R0 + " " + RY + "H" + R1, "dg-tick", 8, { k: "rul" });
    var ticks = "";
    for (var t = 0, x = R0; x < R1 - 2; x += 12, t++) ticks += "M" + x + " " + RY + "V" + (RY - (t % 5 === 0 ? 7 : 4));
    b.draw(ticks, "dg-tick", 9, { k: "ticks", fast: true });
    /* the expiry tick stays out of the accent (one accent path per figure); ink once it has passed */
    b.draw("M" + R1 + " " + (RY - 14) + "V" + (RY + 6), expired ? "dg-inkline" : "dg-conn", 10, { k: "exp", fast: true });
    b.text(R1, 170, expired ? "expiry slot · expired" : "expiry slot", "dg-label" + (expired ? " is-ink" : ""), 7, "end", { k: "expl" });
    /* end states: their keys carry the state, so a change draws the new mark in */
    if (stop >= 0) {
      var sx = xs[stop];
      b.draw("M" + (sx - 3.5) + " " + (Y - 3.5) + "L" + (sx + 3.5) + " " + (Y + 3.5) + "M" + (sx + 3.5) + " " + (Y - 3.5) + "L" + (sx - 3.5) + " " + (Y + 3.5),
        "dg-conn", 6, { k: "stop:" + st, fast: true });
    }
    b.text(R0, 170, "valid from generation", "dg-idx", 7, "start", { k: "expv" });
    b.text(X0 - 36, 200, "status · " + (note || st), "dg-idx", 8, "start", { k: "stat" });
    b.text(R1, 200, "single-use", "dg-label is-accent", 8, "end", { k: "single" });
    return { b: b, caption: "One attestation, one action, one use. Consuming it spends the nullifier; after the expiry slot it is worthless." };
  }

  /* ── 4 · chain: the audit log with a disclosure window ────────────────── */
  function chain(o, uid) {
    var count = Math.max(2, Math.min(10, o.count || 10));
    var entries = [];
    if (o.entries && o.entries.length) {
      entries = o.entries.slice(0, count).map(function (e) { return { index: e.index, hash: e.hash }; });
      count = entries.length;
    } else {
      var start = o.start == null ? 1 : o.start;
      for (var n = 0; n < count; n++) entries.push({ index: start + n, hash: "0x" + hex64(start + n) });
    }
    var first = entries[0].index, last = entries[count - 1].index;
    var pos = function (idx) { for (var j = 0; j < count; j++) if (entries[j].index === idx) return j; return -1; };
    var win = o.window && o.window.length === 2 ? [Math.max(first, Math.min(o.window[0], o.window[1])), Math.min(last, Math.max(o.window[0], o.window[1]))] : null;
    if (win && win[0] > win[1]) win = null;
    var brk = o.brokenAt != null ? pos(o.brokenAt) : -1;
    if (brk === 0) brk = -1; /* the first block has no incoming link on screen */
    var aria = "Audit chain of " + count + " entries, #" + first + " to #" + last + ", each linked to the hash of the one before." +
      (win ? " Disclosed range #" + win[0] + " to #" + win[1] + ", content-free." : "") +
      (brk > 0 ? " Chain broken at #" + entries[brk].index + "." : "");
    var b = new Builder(uid, 1020, 200, o.label || aria);
    var W = 76, H = 52, G = 22, Y = 78, CY = Y + H / 2, X0 = (1020 - (count * W + (count - 1) * G)) / 2;
    var xOf = function (j) { return X0 + j * (W + G); };
    entries.forEach(function (e, j) {
      var x = xOf(j), inWin = win && e.index >= win[0] && e.index <= win[1], i = j;
      var after = brk > 0 && j >= brk;
      b.fill(rr(x, Y, W, H, 6), inWin ? "is-active" : "", i, { k: "bf" + j });
      b.draw(rr(x, Y, W, H, 6), "dg-node" + (inWin ? " is-active" : ""), i, { k: "b" + j });
      b.text(x + W / 2, Y + 19, "#" + e.index, "dg-mono" + (after ? " is-dim" : ""), j, "middle", { k: "bi" + j });
      b.hash(x + W / 2, Y + 37, String(e.hash), W - 6, "dg-hash" + (after ? " is-dim" : ""), j, "bh" + j, "#" + e.index);
      if (j < count - 1) {
        var x2 = xOf(j + 1), off = brk === j + 1 ? " is-off" : "";
        /* prev → hash: the next block points back at this one's hash */
        b.draw("M" + (x2 - 1) + " " + CY + "H" + (x + W + 4), "dg-conn" + off, i + 1, { k: "l" + j, fast: true });
        b.tip(chevL(x + W + 4, CY), "dg-conn" + off, i + 1, { k: "lt" + j });
      }
    });
    b.text(xOf(count - 1) + W / 2, Y + H + 18, "head", "dg-idx", count - 1, "middle", { k: "head" });
    b.text(xOf(0) + W / 2, Y + H + 18, "prev ← hash", "dg-idx", 0, "middle", { k: "prevl" });
    /* overlays: their keys carry their values, so a change enters and the old one leaves */
    if (win) {
      var a0 = xOf(pos(win[0])), a1 = xOf(pos(win[1])) + W;
      b.g({ k: "win:" + win[0] + "-" + win[1] }, function () {
        b.draw("M" + a0 + " " + (Y - 8) + "V" + (Y - 16) + "H" + a1 + "V" + (Y - 8), "dg-accent", count, { k: "wb" });
        b.text((a0 + a1) / 2, Y - 32, "disclosed range · content-free", "dg-label is-accent", count, "middle", { k: "wl" });
      });
    }
    if (brk > 0) {
      var xa = xOf(brk - 1) + W, xb = xOf(brk), mx = (xa + xb) / 2;
      b.g({ k: "brk:" + entries[brk].index }, function () {
        b.draw(dashH(xa + 3, xb - 2, CY, 3, 3), "dg-conn is-broken", count + 1, { k: "bd", fast: true });
        b.draw("M" + (mx - 4) + " " + (CY - 18) + "L" + (mx + 4) + " " + (CY - 10) + "M" + (mx + 4) + " " + (CY - 18) + "L" + (mx - 4) + " " + (CY - 10),
          "dg-conn is-broken", count + 1, { k: "bx", fast: true });
        b.text(mx, Y + H + 40, "chain broken at #" + entries[brk].index, "dg-label is-active", count, "middle", { k: "bl" });
      });
    }
    return { b: b, caption: "Each entry commits to the hash of the one before it. A disclosure proves a range without its content." };
  }

  /* ── 5 · layers: the four-layer stack ─────────────────────────────────── */
  function layers(o, uid) {
    var paint = {};
    var VERDICTS = { pass: 1, block: 1, flag: 1, skip: 1 };
    if (o.results && o.results.length) {
      o.results.forEach(function (r) { if (r && VERDICTS[r.verdict]) paint[r.layer] = r.verdict; });
    } else if (o.highlight) {
      var hl = Array.isArray(o.highlight) ? o.highlight : [o.highlight];
      var v = VERDICTS[o.verdict] ? o.verdict : "block";
      hl.forEach(function (id) { paint[String(id).toUpperCase()] = v; });
    }
    var aria = "Four screening layers. L0 decode and L1 patterns see the raw payload and are deterministic; the proof covers L1 today, and L0 runs in the proxy but is not in the proof yet. " +
      "Secrets and PII are redacted before L2 similarity and L3 judge, which see the redacted payload and are model-based, so they are attested." +
      Object.keys(paint).map(function (k) { return " " + k + ": " + paint[k] + "."; }).join("");
    var b = new Builder(uid, 560, 300, o.label || aria);
    var hid = "dg" + uid + "-hatch";
    hatch(b, hid);
    var Y = [28, 86, 170, 228], X = 16, W = 376, H = 50;
    LAYERS.forEach(function (L, k) {
      var y = Y[k], i = k < 2 ? k : k + 1, v = paint[L.id], cls = v ? " is-" + v : "";
      var nodeCls = v === "block" ? " is-active" : v === "flag" ? " is-flag" : v === "skip" ? " is-skip" : "";
      b.fill(rr(X, y, W, H, 6), cls, i, { k: "lf" + k });
      b.draw(rr(X, y, W, H, 6), "dg-node" + nodeCls, i, { k: "l" + k });
      b.text(X + 16, y + H / 2, L.id, "dg-idx", i, "start", { k: "li" + k });
      b.text(X + 48, y + H / 2, L.name, "dg-title", i, "start", { k: "ln" + k });
      b.text(X + W - 16, y + H / 2, v ? v + " · " + L.sees : L.sees, "dg-sub", i, "end", { k: "ls" + k });
    });
    /* the redaction gate */
    b.add("path", { k: "gatef", d: "M16 145H76V155H16Z", fill: "url(#" + hid + ")", cls: "dg-fill--hatch", i: 2, "data-draw-fill": "" });
    b.draw("M16 145H76V155H16Z", "dg-conn", 2, { k: "gate", fast: true });
    b.text(88, 150, "secrets and PII redacted", "dg-label", 2, "start", { k: "gatel" });
    /* the two kinds of evidence */
    b.draw("M404 28H412V136H404", "dg-conn", 5, { k: "brk0" });
    b.draw("M404 170H412V278H404", "dg-conn", 6, { k: "brk1" });
    b.text(424, 74, "deterministic", "dg-label", 5, "start", { k: "k0a" });
    b.text(424, 92, "L1 proven · L0 next", "dg-label is-active", 5, "start", { k: "k0b" });
    b.text(424, 216, "model-based", "dg-label", 6, "start", { k: "k1a" });
    b.text(424, 234, "attested", "dg-label is-active", 6, "start", { k: "k1b" });
    return { b: b, caption: "L0 and L1 are deterministic; the proof covers L1 today and L0 next. L2 and L3 are model-based, run locally (TEE mode planned), and are attested." };
  }

  var FIGS = { flow4: flow4, architecture: architecture, lifecycle: lifecycle, chain: chain, layers: layers };

  /* ══ phone-width variants (DECISIONS 2026-10-27) ═════════════════════════
     The five figures are 560–1066 units wide; scaled into a phone column their
     11-unit labels render at 4–7 px. Below 720 px render() builds these
     vertical variants instead: 300 units wide (the svg carries .dg-v, capped at
     360 px by app/narrow.css, so a unit is ≥ 1.09 px in a 328 px column) with
     the type at 12–15 units. Same data, same captions, same draw-in; the
     desktop builders above are untouched. */
  var VW = 300;
  function chevU(x, y) { return "M" + f(x - 5) + " " + f(y + 7) + "L" + f(x) + " " + f(y) + "L" + f(x + 5) + " " + f(y + 7); }
  function wrapWords(s, max) {
    var out = [], cur = "";
    String(s).split(" ").forEach(function (w) { if (cur && (cur + " " + w).length > max) { out.push(cur); cur = w; } else cur = cur ? cur + " " + w : w; });
    if (cur) out.push(cur);
    return out;
  }

  /* 1v · flow4: four steps stacked, the hidden | public rule across, before verify */
  function flow4V(o, uid) {
    var act = o.active;
    if (typeof act === "string") act = FLOW.map(function (n) { return n.k; }).indexOf(act);
    if (typeof act !== "number" || act < 0 || act > 3) act = -1;
    var aria = "Four steps: screen, attest, prove, verify. Screening, attestation and proving stay on the machine; " +
      "the proof is verified publicly with one Solana instruction." + (act >= 0 ? " Highlighted: " + FLOW[act].k + "." : "");
    var X = 32, W = VW - X, CX = 60, RULE = 292, Ys = [8, 104, 200, 324];
    var subs = FLOW.map(function (n) { return wrapWords(n.s, 36); });
    var Hs = subs.map(function (l) { return 46 + l.length * 15; });
    var b = new Builder(uid, VW, Ys[3] + Hs[3] + 8, o.label || aria);
    b.draw(dashH(0, CX - 10, RULE, 4, 4) + dashH(CX + 10, VW, RULE, 4, 4), "dg-rule", 7, { k: "rule", fast: true });
    b.text(VW, RULE - 14, "stays on the machine", "dg-label", 4, "end", { k: "rl0" });
    b.text(VW, RULE + 14, "public", "dg-label is-accent", 5, "end", { k: "rl1" });
    FLOW.forEach(function (n, k) {
      var y = Ys[k], H = Hs[k], i = k * 2, on = k === act ? " is-active" : "";
      b.fill(rr(X, y, W, H, 6), on, i, { k: "nf" + k });
      b.draw(rr(X, y, W, H, 6), "dg-node" + on, i, { k: "n" + k });
      b.text(0, y + 22, pad2(k + 1), "dg-num", k, "start", { k: "ni" + k });
      b.text(X + 16, y + 22, n.t, "dg-title" + on, k, "start", { k: "nt" + k });
      subs[k].forEach(function (line, j) { b.text(X + 16, y + 42 + j * 15, line, "dg-sub", k, "start", { k: "ns" + k + "-" + j }); });
      if (k < 3) {
        var y2 = Ys[k + 1], cls = k === 2 ? "dg-accent" : "dg-conn";
        b.draw("M" + CX + " " + (y + H) + "V" + (y2 - 4), cls, i + 1, { k: "c" + k });
        b.tip(chevD(CX, y2 - 4), cls, i + 1, { k: "ct" + k });
      }
    });
    return { b: b, caption: flow4(o, uid).caption };
  }

  /* 2v · architecture: agent → proxy (L0–L3) → tools; prover and audit log under it; the rule; the verifier */
  function architectureV(o, uid) {
    var focus = o.focus || "";
    var on = function (k) { return focus === k ? " is-active" : ""; };
    var full = architecture(o, uid);
    var b = new Builder(uid, VW, 720, full.b.svg.getAttribute("aria-label"));
    var hid = "dg" + uid + "-hatch";
    hatch(b, hid);
    /* agent */
    b.fill(rr(0, 8, VW, 48, 6), on("agent"), 0, { k: "agf" });
    b.draw(rr(0, 8, VW, 48, 6), "dg-node" + on("agent"), 0, { k: "ag" });
    b.text(16, 32, "Agent", "dg-title" + on("agent"), 0, "start", { k: "agt" });
    b.text(VW - 16, 32, "MCP client", "dg-sub", 0, "end", { k: "ags" });
    b.draw("M150 56V80", "dg-conn", 1, { k: "c-ag" });
    b.tip(chevD(150, 80), "dg-conn", 1, { k: "c-agt" });
    /* the proxy and its four layers */
    b.fill(rr(0, 84, VW, 252, 8), on("proxy"), 2, { k: "pxf" });
    b.draw(rr(0, 84, VW, 252, 8), "dg-node" + on("proxy"), 2, { k: "px" });
    b.text(16, 106, "The proxy", "dg-title" + on("proxy"), 2, "start", { k: "pxt" });
    b.text(VW - 16, 106, "127.0.0.1", "dg-idx", 2, "end", { k: "pxs" });
    var bandY = [124, 170, 236, 282];
    LAYERS.forEach(function (L, k) {
      var y = bandY[k], i = k < 2 ? 3 + k : 4 + k;
      b.draw(rr(16, y, 268, 40, 4), "dg-node", i, { k: "band" + k });
      b.text(30, y + 20, L.id, "dg-idx", i, "start", { k: "bid" + k });
      b.text(62, y + 20, L.name, "dg-title", i, "start", { k: "bn" + k });
      b.text(270, y + 20, L.kind, "dg-label", i, "end", { k: "bk" + k });
    });
    b.add("path", { k: "gatef", d: "M16 216H76V226H16Z", fill: "url(#" + hid + ")", cls: "dg-fill--hatch", i: 5, "data-draw-fill": "" });
    b.draw("M16 216H76V226H16Z", "dg-conn", 5, { k: "gate", fast: true });
    b.text(88, 221, "secrets and PII redacted", "dg-label", 5, "start", { k: "gatel" });
    /* tools: three drops from the proxy */
    ["MCP server", "RPC", "Filesystem"].forEach(function (t, k) {
      var x0 = k * 104, cx = x0 + 46;
      b.draw("M" + cx + " 336V370", "dg-conn", 8, { k: "fan" + k });
      b.tip(chevD(cx, 370), "dg-conn", 8, { k: "fant" + k });
      b.fill(rr(x0, 374, 92, 44, 6), on("tools"), 9, { k: "tf" + k });
      b.draw(rr(x0, 374, 92, 44, 6), "dg-node" + on("tools"), 9, { k: "tn" + k });
      b.text(cx, 396, t, "dg-sub" + on("tools"), 9, "middle", { k: "tt" + k });
    });
    /* prover (left) and the audit log (right), fed from the proxy through the gaps between the tools */
    b.draw("M98 336V448", "dg-conn", 10, { k: "c-pr" });
    b.tip(chevD(98, 448), "dg-conn", 10, { k: "c-prt" });
    b.fill(rr(0, 452, 140, 64, 6), on("prover"), 11, { k: "prf" });
    b.draw(rr(0, 452, 140, 64, 6), "dg-node" + on("prover"), 11, { k: "pr" });
    b.text(70, 472, "Prover", "dg-title" + on("prover"), 11, "middle", { k: "prt" });
    b.text(70, 492, "zero-knowledge", "dg-sub", 11, "middle", { k: "prs" });
    b.text(70, 506, "attestation", "dg-sub", 11, "middle", { k: "prs2" });
    b.draw("M202 336V448", "dg-conn", 10, { k: "c-al" });
    b.tip(chevD(202, 448), "dg-conn", 10, { k: "c-alt" });
    for (var a = 0; a < 4; a++) {
      var ax = 153 + a * 36;
      b.fill(rr(ax, 452, 26, 26, 4), on("audit"), 11, { k: "abf" + a });
      b.draw(rr(ax, 452, 26, 26, 4), "dg-node" + on("audit"), 11, { k: "ab" + a });
      if (a < 3) b.draw("M" + (ax + 26) + " 465H" + (ax + 36), "dg-conn", 11, { k: "abl" + a, fast: true });
    }
    b.text(153, 494, "audit log", "dg-label" + on("audit"), 10, "start", { k: "all" });
    b.text(153, 510, "hash-chained, local", "dg-idx", 11, "start", { k: "als" });
    /* the rule, then the one accent path across it */
    b.draw(dashH(0, 60, 554, 4, 4) + dashH(80, VW, 554, 4, 4), "dg-rule", 12, { k: "rule" });
    b.text(VW, 540, "stays on the machine", "dg-label", 12, "end", { k: "rl0" });
    b.text(VW, 568, "public", "dg-label is-accent", 12, "end", { k: "rl1" });
    b.draw("M70 516V600", "dg-accent", 13, { k: "acc" });
    b.tip(chevD(70, 600), "dg-accent", 13, { k: "acct" });
    b.text(82, 588, "proof · public inputs", "dg-label", 13, "start", { k: "accl" });
    /* Solana verifier + what it sees */
    b.fill(rr(0, 604, 150, 64, 6), on("verifier"), 14, { k: "vff" });
    b.draw(rr(0, 604, 150, 64, 6), "dg-node" + on("verifier"), 14, { k: "vf" });
    b.text(75, 626, "Solana verifier", "dg-title" + on("verifier"), 14, "middle", { k: "vft" });
    b.text(75, 648, "one instruction", "dg-sub", 14, "middle", { k: "vfs" });
    b.text(170, 612, "public inputs", "dg-label", 15, "start", { k: "publ" });
    ["action hash", "policy root", "detector version", "expiry slot", "nullifier"].forEach(function (p, k) { b.text(170, 634 + k * 18, p, "dg-idx", 15, "start", { k: "pub" + k }); });
    b.draw("M162 624V712", "dg-conn", 15, { k: "pubr", fast: true });
    b.draw("M162 636H156", "dg-conn", 15, { k: "publead" });
    b.tip(chevL(155, 636), "dg-conn", 15, { k: "publeadt" });
    return { b: b, caption: full.caption };
  }

  /* 3v · lifecycle: the six states down a track; the expiry ruler beside the last three */
  function lifecycleV(o, uid) {
    var full = lifecycle(o, uid);
    var st = String(o.status || "consumed");
    var reach = LIFE.indexOf(st);
    if (reach < 0) reach = LIFE_END.hasOwnProperty(st) ? LIFE_END[st] : 5;
    var stop = (st === "rejected" || st === "failed") ? reach : -1;
    var expired = st === "expired";
    var note = LIFE_NOTE[st] || "";
    var b = new Builder(uid, VW, 396, full.b.svg.getAttribute("aria-label"));
    var X = 36, R = 7, GAP = 13;
    var ys = LIFE.map(function (_, k) { return 40 + k * 52; });
    var track = "";
    for (var k = 0; k < 5; k++) track += "M" + X + " " + (ys[k] + GAP) + "V" + (ys[k + 1] - GAP);
    b.draw(track, "dg-conn", 0, { k: "track" });
    for (var pk = 0; pk < reach; pk++) b.draw("M" + X + " " + (ys[pk] + GAP) + "V" + (ys[pk + 1] - GAP), "dg-accent", 2 + pk, { k: "pg" + pk });
    LIFE.forEach(function (name, k) {
      var y = ys[k], done = k <= reach && k !== stop, hit = done ? " is-reached" : "", i = 1 + k;
      if (k < 5) {
        b.fill(ring(X, y, R), "dg-fill--clear" + hit, i, { k: "lf" + k });
        b.draw(ring(X, y, R), "dg-node dg-conn" + (done ? " is-active" : ""), i, { k: "ln" + k });
      }
      b.text(60, y, name, "dg-label" + (k === reach ? " is-active" : ""), k, "start", { k: "ll" + k });
      b.text(0, y, pad2(k + 1), "dg-num", k, "start", { k: "lx" + k });
    });
    var yc = ys[5], spent = reach >= 5 ? " is-active" : "";
    b.draw(ring(X, yc, 10), "dg-node dg-conn" + spent, 6, { k: "nul" });
    b.draw("M" + (X - 5) + " " + yc + "H" + (X + 5), spent ? "dg-conn dg-accent" : "dg-conn is-off", 7, { k: "slot", fast: true });
    b.text(60, yc + 18, "nullifier", "dg-idx", 6, "start", { k: "nulx" });
    var RX = 284, R0 = ys[3] - 8, R1 = ys[5] + 36;
    b.draw("M" + RX + " " + R0 + "V" + R1, "dg-tick", 8, { k: "rul" });
    var ticks = "";
    for (var t = 0, y = R0; y < R1 - 2; y += 12, t++) ticks += "M" + RX + " " + y + "H" + (RX - (t % 5 === 0 ? 7 : 4));
    b.draw(ticks, "dg-tick", 9, { k: "ticks", fast: true });
    b.draw("M" + (RX - 14) + " " + R1 + "H" + (RX + 6), expired ? "dg-inkline" : "dg-conn", 10, { k: "exp", fast: true });
    b.text(VW, R1 + 18, expired ? "expiry slot · expired" : "expiry slot", "dg-label" + (expired ? " is-ink" : ""), 7, "end", { k: "expl" });
    if (stop >= 0) {
      var sy = ys[stop];
      b.draw("M" + (X - 3.5) + " " + (sy - 3.5) + "L" + (X + 3.5) + " " + (sy + 3.5) + "M" + (X + 3.5) + " " + (sy - 3.5) + "L" + (X - 3.5) + " " + (sy + 3.5),
        "dg-conn", 6, { k: "stop:" + st, fast: true });
    }
    b.text(VW, R0 - 18, "valid from generation", "dg-idx", 7, "end", { k: "expv" });
    b.text(0, R1 + 48, "status · " + (note || st), "dg-idx", 8, "start", { k: "stat" });
    b.text(VW, R1 + 48, "single-use", "dg-label is-accent", 8, "end", { k: "single" });
    return { b: b, caption: full.caption };
  }

  /* 4v · chain: one entry per row, oldest first; each row points back up at the one before */
  function chainV(o, uid) {
    var full = chain(o, uid);
    var count = Math.max(2, Math.min(10, o.count || 10));
    var entries = [];
    if (o.entries && o.entries.length) {
      entries = o.entries.slice(0, count).map(function (e) { return { index: e.index, hash: e.hash }; });
      count = entries.length;
    } else {
      var start = o.start == null ? 1 : o.start;
      for (var n = 0; n < count; n++) entries.push({ index: start + n, hash: "0x" + hex64(start + n) });
    }
    var first = entries[0].index, last = entries[count - 1].index;
    var pos = function (idx) { for (var j = 0; j < count; j++) if (entries[j].index === idx) return j; return -1; };
    var win = o.window && o.window.length === 2 ? [Math.max(first, Math.min(o.window[0], o.window[1])), Math.min(last, Math.max(o.window[0], o.window[1]))] : null;
    if (win && win[0] > win[1]) win = null;
    var brk = o.brokenAt != null ? pos(o.brokenAt) : -1;
    if (brk === 0) brk = -1;
    var X = 20, W = VW - X, H = 48, STEP = 64, Y0 = 40, CXL = 36;
    var yOf = function (j) { return Y0 + j * STEP; };
    var bottom = yOf(count - 1) + H;
    var b = new Builder(uid, VW, bottom + 32, full.b.svg.getAttribute("aria-label"));
    entries.forEach(function (e, j) {
      var y = yOf(j), inWin = win && e.index >= win[0] && e.index <= win[1], i = j;
      var after = brk > 0 && j >= brk;
      b.fill(rr(X, y, W, H, 6), inWin ? "is-active" : "", i, { k: "bf" + j });
      b.draw(rr(X, y, W, H, 6), "dg-node" + (inWin ? " is-active" : ""), i, { k: "b" + j });
      b.text(CXL, y + H / 2, "#" + e.index, "dg-mono" + (after ? " is-dim" : ""), j, "start", { k: "bi" + j });
      b.hash(180, y + H / 2, String(e.hash), 140, "dg-hash" + (after ? " is-dim" : ""), j, "bh" + j, "#" + e.index, 44);
      if (j < count - 1) {
        var off = brk === j + 1 ? " is-off" : "";
        b.draw("M" + CXL + " " + (yOf(j + 1) - 1) + "V" + (y + H + 4), "dg-conn" + off, i + 1, { k: "l" + j, fast: true });
        b.tip(chevU(CXL, y + H + 4), "dg-conn" + off, i + 1, { k: "lt" + j });
      }
    });
    b.text(VW - 8, yOf(count - 1) + H / 2, "head", "dg-idx", count - 1, "end", { k: "head" });
    b.text(X, bottom + 18, "prev ← hash", "dg-idx", 0, "start", { k: "prevl" });
    if (win) {
      var a0 = yOf(pos(win[0])), a1 = yOf(pos(win[1])) + H;
      b.g({ k: "win:" + win[0] + "-" + win[1] }, function () {
        b.draw("M" + (X - 6) + " " + a0 + "H" + (X - 12) + "V" + a1 + "H" + (X - 6), "dg-accent", count, { k: "wb" });
        b.text(X, 18, "disclosed range · content-free", "dg-label is-accent", count, "start", { k: "wl" });
      });
    }
    if (brk > 0) {
      var ya = yOf(brk - 1) + H, yb = yOf(brk), my = (ya + yb) / 2;
      b.g({ k: "brk:" + entries[brk].index }, function () {
        var d = "", yy = ya + 3;
        while (yy < yb - 2) { d += "M" + CXL + " " + f(yy) + "V" + f(Math.min(yy + 3, yb - 2)); yy += 6; }
        b.draw(d, "dg-conn is-broken", count + 1, { k: "bd", fast: true });
        b.draw("M" + (CXL + 10) + " " + (my - 4) + "L" + (CXL + 18) + " " + (my + 4) + "M" + (CXL + 18) + " " + (my - 4) + "L" + (CXL + 10) + " " + (my + 4),
          "dg-conn is-broken", count + 1, { k: "bx", fast: true });
        b.text(VW, bottom + 18, "chain broken at #" + entries[brk].index, "dg-label is-active", count, "end", { k: "bl" });
      });
    }
    return { b: b, caption: full.caption };
  }

  /* 5v · layers: the four bands full width; the two kinds of evidence as label rows above each pair */
  function layersV(o, uid) {
    var full = layers(o, uid);
    var paint = {};
    var VERDICTS = { pass: 1, block: 1, flag: 1, skip: 1 };
    if (o.results && o.results.length) {
      o.results.forEach(function (r) { if (r && VERDICTS[r.verdict]) paint[r.layer] = r.verdict; });
    } else if (o.highlight) {
      var hl = Array.isArray(o.highlight) ? o.highlight : [o.highlight];
      var v0 = VERDICTS[o.verdict] ? o.verdict : "block";
      hl.forEach(function (id) { paint[String(id).toUpperCase()] = v0; });
    }
    var b = new Builder(uid, VW, 306, full.b.svg.getAttribute("aria-label"));
    var hid = "dg" + uid + "-hatch";
    hatch(b, hid);
    var Y = [24, 82, 190, 248], H = 50;
    b.text(0, 10, "deterministic", "dg-label", 5, "start", { k: "k0a" });
    b.text(VW, 10, "L1 proven · L0 next", "dg-label is-active", 5, "end", { k: "k0b" });
    b.text(0, 176, "model-based", "dg-label", 6, "start", { k: "k1a" });
    b.text(VW, 176, "attested", "dg-label is-active", 6, "end", { k: "k1b" });
    LAYERS.forEach(function (L, k) {
      var y = Y[k], i = k < 2 ? k : k + 1, v = paint[L.id], cls = v ? " is-" + v : "";
      var nodeCls = v === "block" ? " is-active" : v === "flag" ? " is-flag" : v === "skip" ? " is-skip" : "";
      b.fill(rr(0, y, VW, H, 6), cls, i, { k: "lf" + k });
      b.draw(rr(0, y, VW, H, 6), "dg-node" + nodeCls, i, { k: "l" + k });
      b.text(16, y + H / 2, L.id, "dg-idx", i, "start", { k: "li" + k });
      b.text(48, y + H / 2, L.name, "dg-title", i, "start", { k: "ln" + k });
      b.text(VW - 16, y + H / 2, v ? v + " · " + L.sees : L.sees, "dg-sub", i, "end", { k: "ls" + k });
    });
    b.add("path", { k: "gatef", d: "M0 142H60V152H0Z", fill: "url(#" + hid + ")", cls: "dg-fill--hatch", i: 2, "data-draw-fill": "" });
    b.draw("M0 142H60V152H0Z", "dg-conn", 2, { k: "gate", fast: true });
    b.text(72, 147, "secrets and PII redacted", "dg-label", 2, "start", { k: "gatel" });
    return { b: b, caption: full.caption };
  }

  var FIGS_V = { flow4: flow4V, architecture: architectureV, lifecycle: lifecycleV, chain: chainV, layers: layersV };
  var NARROW_Q = "(max-width: 719.98px)", narrowMq = null, narrowHosts = [];
  function narrow() { return !!(window.matchMedia && window.matchMedia(NARROW_Q).matches); }
  /* crossing 720 px (rotation, a resized window) re-renders each figure in the other variant */
  function watchNarrow(host) {
    if (narrowHosts.indexOf(host) < 0) narrowHosts.push(host);
    if (narrowMq || !window.matchMedia) return;
    narrowMq = window.matchMedia(NARROW_Q);
    var onChange = function () {
      narrowHosts = narrowHosts.filter(function (h) { return h.isConnected; });
      narrowHosts.forEach(function (h) { if (h.__dg) render(h.__dg.name, h, h.__dg.opts); });
    };
    if (narrowMq.addEventListener) narrowMq.addEventListener("change", onChange); else if (narrowMq.addListener) narrowMq.addListener(onChange);
  }

  /* ── update in place: keyed attribute patch ───────────────────────────── */
  function syncAttrs(o, n) {
    var i, a;
    for (i = o.attributes.length - 1; i >= 0; i--) {
      a = o.attributes[i].name;
      if (!n.hasAttribute(a)) o.removeAttribute(a);
    }
    for (i = 0; i < n.attributes.length; i++) {
      a = n.attributes[i];
      if (o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value);
    }
  }
  function keyOf(e) { return e.getAttribute && e.getAttribute("data-k"); }
  function patch(oldSvg, newSvg) {
    var old = {}, keep = {}, entering = [], ei = 0;
    [].forEach.call(oldSvg.querySelectorAll("[data-k]"), function (e) { old[keyOf(e)] = e; });
    syncAttrs(oldSvg, newSvg);
    var all = [].slice.call(newSvg.querySelectorAll("[data-k]"));
    all.forEach(function (n) {
      if (n.__dgMoved) return;
      var k = keyOf(n), o = old[k];
      if (o && o.tagName === n.tagName && !keep[k]) {
        keep[k] = 1;
        syncAttrs(o, n);
        if (!n.firstElementChild && o.textContent !== n.textContent) o.textContent = n.textContent;
        return;
      }
      var np = n.parentNode, op = np === newSvg ? oldSvg : old[keyOf(np)];
      if (!op) return;
      var ref = null, s = n.nextElementSibling;
      while (s && !ref) { if (old[keyOf(s)] && old[keyOf(s)].parentNode === op) ref = old[keyOf(s)]; s = s.nextElementSibling; }
      [].forEach.call(n.querySelectorAll("[data-k]"), function (c) { c.__dgMoved = true; keep[keyOf(c)] = 1; });
      keep[k] = 1;
      n.classList.add("dg-enter");
      n.style.setProperty("--ei", String(ei++));
      op.insertBefore(n, ref);
      entering.push(n);
    });
    Object.keys(old).forEach(function (k) {
      var o = old[k];
      if (keep[k] || !o.parentNode) return;
      var p = o.parentNode;
      if (p !== oldSvg && !keep[keyOf(p)]) return; /* its ancestor leaves with it */
      o.classList.add("dg-leave");
      o.removeAttribute("data-k");
      setTimeout(function () { if (o.parentNode) o.parentNode.removeChild(o); }, LEAVE * (root.getAttribute("data-motion") === "slow" ? 4 : 1) + 40);
    });
    if (entering.length) raf2(function () { entering.forEach(function (n) { n.classList.remove("dg-enter"); }); });
  }

  /* ── public API ───────────────────────────────────────────────────────── */
  function resolve(host) { return typeof host === "string" ? document.querySelector(host) : host; }

  function render(name, host, opts) {
    ensureStyle();
    host = resolve(host);
    var vert = narrow() && FIGS_V[name] ? FIGS_V[name] : null;
    var fn = vert || FIGS[name];
    if (!host) { console.warn("[BS.diagrams] render(" + name + "): no host"); return null; }
    if (!fn) { console.warn("[BS.diagrams] unknown figure \"" + name + "\"; known: " + Object.keys(FIGS).join(", ")); return host; }
    opts = opts || {};
    if (!host.__dgUid) host.__dgUid = ++uidN;
    var out = fn(opts, host.__dgUid);
    var svg = out.b.svg, steps = out.b.steps;
    if (out.b.interactive) svg.setAttribute("role", "group");
    if (vert) svg.setAttribute("class", "dg-v");
    host.classList.add("fig");
    host.setAttribute("data-diagram", name);
    host.setAttribute("data-dg-ready", "");
    host.style.setProperty("--labels-delay", (steps * STAGGER) + "ms");
    host.style.setProperty("--labels-at", (steps * STAGGER) + "ms"); /* the kit's name for the same delay */

    var art = null;
    for (var c = host.firstElementChild; c; c = c.nextElementSibling) if (c.classList.contains("fig__art")) { art = c; break; }
    if (!art) { art = document.createElement("div"); art.className = "fig__art"; host.insertBefore(art, host.firstChild); }

    var prev = host.__dg;
    var oldSvg = art.querySelector(":scope > svg");
    if (prev && prev.name === name && !!prev.v === !!vert && oldSvg && host.classList.contains("is-drawn") && !reduced()) {
      host.classList.add("is-settled");
      patch(oldSvg, svg);
    } else {
      if (oldSvg) art.replaceChild(svg, oldSvg); else art.appendChild(svg);
      if (!prev) prev = { stop: arm(host) };
      else if (host.classList.contains("is-drawn") && prev.name !== name) { host.__dg = { name: name, opts: opts, stop: prev.stop }; replay(host); }
    }

    var cap = host.querySelector(":scope > figcaption");
    if (opts.caption !== false) {
      if (!cap) { cap = document.createElement("figcaption"); cap.className = "fig__caption"; cap.setAttribute("data-dg-caption", ""); host.appendChild(cap); }
      if (cap.hasAttribute("data-dg-caption")) cap.textContent = typeof opts.caption === "string" ? opts.caption : out.caption;
    } else if (cap && cap.hasAttribute("data-dg-caption")) { cap.parentNode.removeChild(cap); }

    host.__dg = { name: name, opts: opts, stop: prev.stop, v: !!vert };
    watchNarrow(host);
    return host;
  }

  function replay(host) {
    host = resolve(host);
    if (!host || !host.__dg) return;
    host.classList.remove("is-settled");
    if (reduced()) return;
    var k = kit();
    /* never spend a figure that has not drawn in yet: it still draws on scroll */
    if (!host.classList.contains("is-drawn")) return;
    if (k && typeof k.redraw === "function") { k.redraw(host); return; }
    host.classList.add("is-nofx");
    host.classList.remove("is-drawn");
    requestAnimationFrame(function () {
      host.getBoundingClientRect(); /* commit the undrawn state */
      host.classList.remove("is-nofx");
      raf2(function () { host.classList.add("is-drawn"); });
    });
  }

  function mount(scope) {
    ensureStyle();
    [].forEach.call((scope || document).querySelectorAll("[data-diagram]:not([data-dg-ready])"), function (el) {
      var o = {};
      try { o = el.getAttribute("data-opts") ? JSON.parse(el.getAttribute("data-opts")) : {}; }
      catch (e) { console.warn("[BS.diagrams] bad data-opts on", el); }
      render(el.getAttribute("data-diagram"), el, o);
    });
  }

  function check(scope) {
    var ps = (scope || document).querySelectorAll("path[data-draw]"), missing = [];
    [].forEach.call(ps, function (p) { if (p.getAttribute("pathLength") !== "1") missing.push(p); });
    return { paths: ps.length, missing: missing };
  }

  /* ── copyable figure hashes (delegated, so figures rendered later just work) ── */
  var COPIED_MS = 1400;   /* the kit's .hash revert (ui.js copyHash) */
  function writeClip(v, done) {
    if (BS.ui && typeof BS.ui.writeClipboard === "function") { BS.ui.writeClipboard(v, done); return; }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(done, done);
      else done();
    } catch (e) { done(); }
  }
  function copyFigHash(g) {
    var v = g.getAttribute("data-dg-hash"), t = g.querySelector(".dg-hash");
    if (!v || !t) return;
    if (g._dgT) clearTimeout(g._dgT);
    if (g._dgOrig == null) { g._dgOrig = t.textContent; g._dgAria = g.getAttribute("aria-label"); }
    writeClip(v, function () {
      t.textContent = "Copied";
      g.classList.add("is-copied");
      g.setAttribute("aria-label", "Copied");
      g._dgT = setTimeout(function () {
        t.textContent = g._dgOrig; g.setAttribute("aria-label", g._dgAria);
        g._dgOrig = null; g._dgT = 0; g.classList.remove("is-copied");
      }, COPIED_MS);
      document.dispatchEvent(new CustomEvent("bs:copy", { detail: { value: v } }));
    });
  }
  document.addEventListener("click", function (e) {
    var g = e.target && e.target.closest && e.target.closest(".fig .dg-hashbtn");
    if (!g) return;
    e.preventDefault();
    copyFigHash(g);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    var g = e.target && e.target.closest && e.target.closest(".fig .dg-hashbtn");
    if (!g || g !== e.target) return;
    e.preventDefault();   /* Space would scroll */
    copyFigHash(g);
  });
  /* rules for the hash buttons, injected here because diagrams.css is shared with J00;
     colours are tokens via diagrams.css's --dg-* roles; hover and focus are colour/ring only */
  function ensureStyle() { /* the figure runtime styles are kit/diagrams-runtime.css (imported by globals.css); nothing is written into <head> */ }

  BS.diagrams = { list: Object.keys(FIGS), render: render, replay: replay, mount: mount, check: check };

  /* nothing runs at load; the site renders figures from its mount sequence */
})();
