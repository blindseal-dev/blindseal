/* ============================================================================
   S01 — Site: Home · page script
   ----------------------------------------------------------------------------
   Fills the fixture-driven bits (every hash through BS.ui.hash), draws the
   flow figure, builds the two small code blocks, mounts the site chrome, and
   holds the CTA's glass buttons until the panel is in view (they live outside
   every .reveal, so they fade on their own with BS.motion.staggerFade).
   Order matters: content first, then BS.mountSite (it wires [data-copy] and
   arms every .reveal).
   ========================================================================== */
(function () {
  "use strict";
  var BS = window.BS, ui = BS.ui, D = BS.data, M = BS.motion;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var esc = ui.esc;

  /* every link resolves to a sibling mockup */
  var ROUTES = {
    home: "../S01/index.html", how: "../S02/index.html", verify: "../S03/index.html",
    docs: "../S04/index.html", explorer: "../S05/index.html", changelog: "../S06/index.html"
  };

  /* 02 — the four-step flow, drawn in on scroll (D07); the columns under it carry the copy */
  BS.diagrams.render("flow4", $("#flow"), { caption: false });

  /* 03 — the public side shows what an attestation really carries (the verified sample) */
  var att = D.attestationSample;
  /* one value per slot, each behind a small mono key */
  var kv = function (k, v) { return '<span class="s01-hp__k">' + esc(k) + "</span>" + v; };
  var vals = {
    proof: kv("id", ui.hash(att.id, { label: "Attestation id" })),
    root: kv("root", ui.hash(att.policyRoot, { label: "Policy root" })),
    detector: kv("version", '<span class="s01-hp__mono">' + esc(att.detectorVersion) + "</span>"),
    action: kv("action", ui.hash(att.actionHash, { label: "Action hash" })),
    expiry: kv("expiry", '<span class="s01-hp__mono">slot ' + esc(BS.fmt.slot(att.expirySlot)) + "</span>"),
    nullifier: kv("nullifier", ui.hash(att.nullifier, { label: "Nullifier" }))
  };
  [].forEach.call(document.querySelectorAll("[data-hp]"), function (el) { el.innerHTML = vals[el.getAttribute("data-hp")] || ""; });

  /* 05 — step art: start the proxy · the 4-line MCP config */
  $("#step-run").innerHTML = ui.code("$ blindseal run", { lang: "sh" });
  $("#step-mcp").innerHTML = ui.code([
    '"github": {',
    '  "command": "blindseal",',
    '  "args": ["run", "--", "npx",',
    '    "@modelcontextprotocol/server-github"] }'
  ].join("\n"), { lang: "json" });

  /* the chrome: notch nav (home lights no link; the brand is home), nebula, footer, masthead rise, reveals */
  BS.mountSite({ active: "home", routes: ROUTES, action: { label: "Open dashboard", href: "../D01/index.html" } });

  /* CTA — the glass buttons fade in once the panel is in view (opacity on the buttons, never an ancestor) */
  var acts = $("#cta-actions");
  if (acts && !M.reduced() && "IntersectionObserver" in window) {
    acts.classList.add("is-pending");
    var done = false;
    var go = function () {
      if (done) return; done = true; io.disconnect(); window.removeEventListener("scroll", onScroll);
      M.staggerFade(acts, { duration: 400, start: 180, gap: 60 });
      acts.classList.remove("is-pending");
    };
    var io = new IntersectionObserver(function (es) { if (es.some(function (e) { return e.isIntersecting; })) go(); }, { rootMargin: "0px 0px -12% 0px" });
    var onScroll = function () { if (M.seen(acts, null)) go(); };   /* the kit's sweep fallback (a fast jump past the IO) */
    io.observe(acts);
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  /* dev check (the kit's): the never-write list must stay clean */
  var hits = BS.neverWriteScan();
  if (hits.length) console.warn("[S01] never-write hits:", hits.join(", "));
})();
