/* ============================================================================
   _shared/constants.js — window.BS: every published identifier, ONE file
   ----------------------------------------------------------------------------
   Load it first. Nothing brand-specific
   is baked in anywhere else, so a rename is a single edit here.

     BS.BRAND        "Blindseal"
     BS.brand        { name, tagline (the one-liner, copy bank verbatim), mark }
     BS.ROUTES       { site: { home, how, verify, docs, explorer, changelog },
                       dashboard: { decisions, audit, policy, attestations, settings } }
                     paths relative to mockups/<JOB>/ (D13)
     BS.SITE_NAV     the notch nav's five links (+ the brand → home)
     BS.NAV          the dashboard sidebar's five items, Lucide names
     BS.PORTS        board 4830 · mockups 4831 · app 3004 · proxy 7777 (D14)

     BS.VERSION      { proxy, detector, dashboard }
     BS.NEVER_WRITE  the brief's never-write list as
                     { label, re } pairs; BS.neverWriteScan(text?) → hits[]
                     scans document.body.innerText by default (the kitchen
                     sinks run it as a dev check)
     BS.COPY         the copy-bank lines the kit itself prints (verbatim)
   ========================================================================== */
(function () {
  "use strict";
  var BS = (window.BS = window.BS || {});

  BS.BRAND = "Blindseal";

  BS.COPY = Object.freeze({
    oneLiner: "Prove an agent's action was screened — without showing what it was.",   /* copy-bank one-liner; founder may revert to the "pwn" line */
    honestScope: "Blindseal proves that a specific call was screened under a committed policy by a specific detector version, and that the committed L1 rules passed. L0 decoding is run by the proxy but is not inside the proof yet; the model-based layers are attested, not proven: embeddings run locally, and the AI judge is off unless you turn it on (a TEE mode is planned). Blindseal does not prove an agent is safe, and does not cover traffic that doesn't pass through the proxy.",
    detailedLead: "Blindseal is a privacy-preserving, verifiable screening layer for AI agents."
  });

  BS.brand = Object.freeze({
    name: "Blindseal",
    tagline: BS.COPY.oneLiner,
    mark: "A"                        /* D12: pages use mark A; the owner picks (O3) */
  });

  BS.ROUTES = Object.freeze({
    site: Object.freeze({
      home: "../S01/index.html",
      how: "../S02/index.html",
      verify: "../S03/index.html",
      docs: "../S04/index.html",
      explorer: "../S05/index.html",
      changelog: "../S06/index.html"
    }),
    dashboard: Object.freeze({
      decisions: "../D01/index.html",
      audit: "../D03/index.html",
      policy: "../D04/index.html",
      attestations: "../D05/index.html",
      settings: "../D06/index.html"
    })
  });

  BS.SITE_NAV = Object.freeze([
    { id: "how", label: "How it works" },
    { id: "verify", label: "Verify" },
    { id: "docs", label: "Docs" },
    { id: "explorer", label: "Explorer" },
    { id: "changelog", label: "Changelog" }
  ]);

  BS.NAV = Object.freeze([
    { id: "decisions", label: "Decisions", icon: "list" },
    { id: "audit", label: "Audit", icon: "link" },
    { id: "policy", label: "Policy", icon: "scroll-text" },
    { id: "attestations", label: "Attestations", icon: "stamp" },
    { id: "settings", label: "Settings", icon: "settings" }
  ]);

  BS.PORTS = Object.freeze({ board: 4830, mockups: 4831, app: 3004, proxy: 7777 });

  BS.VERSION = Object.freeze({ proxy: "0.4.0", detector: "det-2026.10.1", dashboard: "0.4.0" });

  /* the never-write list. "zero-trust" is banned as a NOUN only:
     the pattern flags it when no word follows ("…a zero-trust." / "zero-trust,"). */
  BS.NEVER_WRITE = Object.freeze([
    { label: "unhackable", re: /\bunhackable\b/i },
    { label: "proves no injection", re: /\bproves?\s+no\s+injection/i },
    { label: "agent is safe", re: /\bagent\s+is\s+safe\b/i },
    { label: "military-grade", re: /\bmilitary[-\s]grade\b/i },
    { label: "zero-trust (noun)", re: /\bzero[-\s]trust\b(?!\s+[a-z])/i }
  ]);
  /* the honest-scope callout says "does not prove an agent is safe": that is the
     brief's own sentence, so a negated use is allowed */
  BS.neverWriteScan = function (text) {
    var t = text == null ? (document.body ? document.body.innerText : "") : String(text);
    t = t.split(BS.COPY.honestScope).join(" ");
    var hits = [];
    BS.NEVER_WRITE.forEach(function (w) { if (w.re.test(t)) hits.push(w.label); });
    return hits;
  };

})();
