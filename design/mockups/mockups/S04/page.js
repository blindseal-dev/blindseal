/* ============================================================================
   S04 · Docs — page.js
   ----------------------------------------------------------------------------
   Renders the whole docs shell from the fixtures and drives it from one place,
   as the kit's Whitepaper.tsx does:
     · the sidebar tree from BS.data.docs.tree (groups whose only page shares
       the group's name sit as plain rows under "Guides" / "Reference")
     · the page from BS.data.docs.pages[slug] (title, summary, sections, code),
       plus a few per-page blocks drawn from other fixtures (the install block,
       the MCP config, the #token= URL, the mock policy root, the chain head…)
     · ?page=api (= api-reference) generated from BS.data.apiReference: base URL
       + auth, 11 types, 17 endpoints (expandable shapes), 4 WS messages,
       6 error codes (FRONTEND §5)
     · the outline: scroll progress → the fill (scaleY, damped 100 ms linear);
       scroll-spy → the active link (IO band −20 % / −70 %, deepest target wins,
       nothing above the first section, the last target at the very bottom)
     · tree / prev / next swap the page in place: a 200 ms in-out crossfade,
       history.replaceState(?page=), no route cover, no reveal on swaps
   Every hash goes through BS.ui.hash(value, { label }). No runtime highlighter:
   tokenise() tags five token kinds with kit colours.
   ========================================================================== */
(function () {
  "use strict";
  var BS = window.BS;
  var M = BS.motion, D = BS.data, ui = BS.ui, fmt = BS.fmt || ui.fmt;
  var DOCS = D.docs, API = D.apiReference;

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return [].slice.call((r || document).querySelectorAll(s)); }
  function esc(s) { return ui.esc(s); }
  function ico(n) { return BS.icon ? BS.icon(n) : ""; }
  function reduced() { return M.reduced(); }
  function slugify(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  /* ── pages, aliases, tree buckets ─────────────────────────────────────── */
  var PAGES = DOCS.pages, BY = {};
  PAGES.forEach(function (p) { BY[p.slug] = p; });
  var ALIAS = { api: "api-reference" };            /* the brief's ?page=api */
  var PUBLIC = { "api-reference": "api" };         /* …and what the URL shows */
  var DEFAULT = "install";
  var REFERENCE = { "api-reference": 1, "changelog": 1 };
  function resolve(s) { s = ALIAS[s] || s; return BY[s] ? s : null; }

  var buckets = [], bucketOf = {};
  DOCS.tree.forEach(function (g) {
    var loose = g.items.length === 1 && g.items[0].title === g.group;
    var name = loose ? (REFERENCE[g.items[0].slug] ? "Reference" : "Guides") : g.group;
    var b = buckets.filter(function (x) { return x.name === name; })[0];
    if (!b) { b = { name: name, items: [] }; buckets.push(b); }
    g.items.forEach(function (it) { b.items.push(it); bucketOf[it.slug] = name; });
  });

  /* ── code: kit .code block + five token kinds ─────────────────────────── */
  var TOK = /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*")(\s*:)?|('[^'\n]*')|(\b\d+(?:\.\d+)?\b)|(\b(?:interface|type|string|number|boolean|true|false|null)\b)|([A-Za-z_$][\w$]*)(?=\??:)|([{}\[\]();,|&?=<>])/g;
  function tokenise(src) {
    var out = "", last = 0, m;
    TOK.lastIndex = 0;
    while ((m = TOK.exec(src))) {
      out += esc(src.slice(last, m.index));
      if (m[1]) out += '<span class="code__c">' + esc(m[1]) + "</span>";
      else if (m[2]) out += m[3] ? '<span class="tk-p">' + esc(m[2]) + '</span><span class="tk-x">' + esc(m[3]) + "</span>" : '<span class="tk-s">' + esc(m[2]) + "</span>";
      else if (m[4]) out += '<span class="tk-s">' + esc(m[4]) + "</span>";
      else if (m[5]) out += '<span class="tk-n">' + esc(m[5]) + "</span>";
      else if (m[6]) out += '<span class="tk-k">' + esc(m[6]) + "</span>";
      else if (m[7]) out += '<span class="tk-p">' + esc(m[7]) + "</span>";
      else if (m[8]) out += '<span class="tk-x">' + esc(m[8]) + "</span>";
      last = TOK.lastIndex;
    }
    return out + esc(src.slice(last));
  }
  function code(text, lang) {
    var html = ui.code(text, { lang: lang });
    var body;
    if (lang === "shell") {
      body = String(text).split("\n").map(function (l) {
        if (/^\$ /.test(l)) return '<span class="code__prompt">$ </span>' + esc(l.slice(2)).replace(/(&quot;[^&]*?&quot;|'[^']*')/g, '<span class="tk-s">$1</span>');
        if (/^#/.test(l)) return '<span class="code__c">' + esc(l) + "</span>";
        return esc(l).replace(/(-[A-Za-z]\b)/g, '<span class="tk-p">$1</span>').replace(/('[^']*'|&quot;[^&]*?&quot;)/g, '<span class="tk-s">$1</span>');
      }).join("\n");
    } else if (lang === "json" || lang === "ts") {
      body = tokenise(String(text));
    } else return html;
    return html.replace(/<pre><code>[\s\S]*<\/code><\/pre>/, function () { return "<pre><code>" + body + "</code></pre>"; });
  }
  /* inline code in fixture prose: paths, files, flags, rule kinds, thresholds */
  var INLINE = /((?:^|(?<=[\s(]))(?:~\/[\w./-]*\w|\/(?:verify|changelog|explorer)\b|(?:GET|POST|PUT) \/[\w/:.-]+[\w])|\b[\w-]+\.json\b|\(\?i\)|\bl[23]\.(?:score|confidence)\b|\b127\.0\.0\.1\b|\bBLINDSEAL_MOCK=1 blindseal run\b|\b(?:exact|regex|allowlist|denylist|threshold)\b(?= (?:matches|names|compares))|#token=…)/g;
  function prose(s) { return esc(s).replace(INLINE, '<code class="docs-ic">$1</code>'); }

  /* ── type text with links to the type panels ──────────────────────────── */
  var TYPES = {};
  API.types.forEach(function (t) { TYPES[t.name] = t; });
  function typeId(name) { return "type-" + slugify(name); }
  function typeRefs(t) {
    return String(t).split(/(\b[A-Z][A-Za-z]+\b)/).map(function (part) {
      return TYPES[part] ? '<a class="api-ref" href="#' + typeId(part) + '" data-goto="' + typeId(part) + '">' + esc(part) + "</a>" : esc(part);
    }).join("");
  }
  function tsOf(t) {
    if (t.kind === "type") return "type " + t.name + " = " + t.definition + ";";
    /* comments sit above their field and long types break, so the block fits the column without a sideways scroll */
    var MAX = 64;
    return "interface " + t.name + " {\n" + t.fields.map(function (f) {
      var key = "  " + f.name + (f.optional ? "?" : "") + ": ", ty = f.type, line = key + ty + ";", out;
      var obj = /^\{ (.+) \}(\[\])?$/.exec(ty);
      if (line.length <= MAX) out = line;
      else if (obj) out = key + "{\n" + obj[1].split("; ").map(function (s) { return "    " + s + ";"; }).join("\n") + "\n  }" + (obj[2] || "") + ";";
      else if (/ \| /.test(ty) && !/[{}]/.test(ty)) out = key + "\n" + ty.split(" | ").map(function (s) { return "    | " + s; }).join("\n") + ";";
      else out = line;
      return (f.comment ? "  // " + f.comment + "\n" : "") + out;
    }).join("\n") + "\n}";
  }

  /* ── small renderers ──────────────────────────────────────────────────── */
  function anchorBtn(id, label) {
    return '<button type="button" class="docs-anchor" data-anchor="' + esc(id) + '" aria-label="Copy a link to ' + esc(label) + '">' + ico("link") + "</button>";
  }
  function section(id, n, heading, body, o) {
    o = o || {};
    return '<section class="docs-sec' + (o.reveal ? " reveal" : "") + '" id="' + esc(id) + '" data-target data-label="' + esc(heading) + '">' +
      '<div class="docs-sec__head"><p class="docs-sec__n"><b>' + pad2(n) + "</b>" + (o.count ? " / " + esc(o.count) : "") + "</p>" +
      '<h2 class="docs-h2">' + esc(heading) + anchorBtn(id, heading) + "</h2></div>" + body + "</section>";
  }
  function p(s) { return '<p class="docs-p">' + prose(s) + "</p>"; }
  function pHtml(s) { return '<p class="docs-p">' + s + "</p>"; }
  function link(href, label, o) {
    o = o || {};
    return '<a class="docs-link" href="' + esc(href) + '"' + (o.page ? ' data-page="' + esc(o.page) + '"' : "") + (o.hash ? ' data-hash="' + esc(o.hash) + '"' : "") + ">" + esc(label) + ico(o.icon || "arrow-right") + "</a>";
  }
  function pageHref(slug, hash) { return "?page=" + (PUBLIC[slug] || slug) + (hash ? "#" + hash : ""); }
  function links(arr) { return '<div class="docs-links">' + arr.join("") + "</div>"; }
  function kv(k, v) { return '<div class="docs-kv"><span class="docs-kv__k">' + esc(k) + '</span><span class="docs-kv__v">' + v + "</span></div>"; }
  function callout(title, body, muted) { return '<div class="callout' + (muted ? " muted" : "") + '"><p class="callout__title">' + esc(title) + '</p><p class="callout__body">' + body + "</p></div>"; }
  function table(heads, rows, cls) {
    return '<div class="table-box' + (cls ? " " + cls : "") + '"><table class="table"><thead><tr>' + heads.map(function (h) { return '<th scope="col">' + esc(h) + "</th>"; }).join("") +
      "</tr></thead><tbody>" + rows.map(function (r) { return "<tr" + (r.attr || "") + ">" + r.cells.join("") + "</tr>"; }).join("") + "</tbody></table></div>";
  }
  function td(html, cls) { return "<td" + (cls ? ' class="' + cls + '"' : "") + ">" + html + "</td>"; }
  function dash() { return td('<span class="is-dash">—</span>'); }
  function install(cmd) {
    return '<div class="install"><span class="install__tile" aria-hidden="true">$</span><code class="install__cmd">' + esc(cmd) + '</code>' +
      '<button type="button" class="copy" data-copy="' + esc(cmd) + '" aria-label="Copy the install command">' + ico("copy") + "</button></div>";
  }

  /* ── fixture picks used across pages ──────────────────────────────────── */
  var origin = "http://127.0.0.1:" + ((BS.PORTS && BS.PORTS.proxy) || 7777);
  var head = D.audit && D.audit.head;
  var rel = (D.changelog || [])[0];
  var feat = D.featured || {};
  var exDecision = feat.withAction || (D.decisions[0] && D.decisions[0].id) || "01J…";
  var exAtt = feat.attestationId || (D.attestations[0] && D.attestations[0].id) || "att_…";
  var connectCode = ((BY["point-an-agent"].sections.filter(function (s) { return s.code; })[0]) || {}).code || "";
  var R = BS.ROUTES || { dashboard: {}, site: {} };

  /* ── per-page additions (after a fixture section, by heading) ─────────── */
  var EXTRA = {
    "install": {
      "First run": function () {
        return kv("Dashboard", '<span class="docs-url">' + esc(origin) + "/#token=</span>" + ui.hash(D.token, { label: "Dashboard token (mock)", cls: "ink" })) +
          p("The token is also written to ~/.blindseal/dashboard.token. It travels in the URL fragment, which the browser never sends to a server, and the dashboard keeps it in memory only.");
      },
      "@after": function (n) {
        return section("connect-an-agent", n, "Connect an agent",
          p("Replace each upstream server in the agent's MCP config with the proxy; the proxy then starts the real server itself.") +
          code(connectCode, "json") +
          '<div class="docs-block">' + callout("No agent yet", "Run the dashboard against fixtures with " + '<code class="docs-ic">BLINDSEAL_MOCK=1 blindseal run</code>' + ". Every decision in mock mode is synthetic.", true) + "</div>" +
          links([link(pageHref("point-an-agent"), "Point an agent at the proxy", { page: "point-an-agent" }), link(pageHref("mock-mode"), "Mock mode", { page: "mock-mode" })]));
      }
    },
    "point-an-agent": {
      "Check it": function () { return links([link(R.dashboard.decisions, "Open the dashboard", { icon: "arrow-up-right" })]); }
    },
    "mock-mode": {
      "What is synthetic": function () {
        return '<div class="docs-meta"><span class="chip mock">MOCK</span><span class="docs-count">the badge, as the status bar shows it</span></div>' +
          links([link(R.dashboard.decisions, "Open the dashboard in mock mode", { icon: "arrow-up-right" })]);
      }
    },
    "dashboard": {
      "Decisions": function () { return links([link(R.dashboard.decisions, "Decisions", { icon: "arrow-up-right" })]); },
      "Audit": function () { return links([link(R.dashboard.audit + "index.html", "Audit", { icon: "arrow-up-right" })]); },
      "Policy": function () { return links([link(R.dashboard.policy + "index.html", "Policy", { icon: "arrow-up-right" })]); },
      "Attestations and settings": function () { return links([link(R.dashboard.attestations + "index.html", "Attestations", { icon: "arrow-up-right" }), link(R.dashboard.settings + "index.html", "Settings", { icon: "arrow-up-right" })]); }
    },
    "policy-rules": {
      "Kinds": function () {
        var rules = (D.policy && D.policy.rules) || [];
        var kinds = ["exact", "regex", "allowlist", "denylist", "threshold"];
        return table(["Kind", "Layer", "Rules in the mock policy"], kinds.map(function (k) {
          var rs = rules.filter(function (r) { return r.kind === k; });
          var layers = rs.map(function (r) { return r.layer; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(" · ");
          var off = rs.filter(function (r) { return !r.enabled; }).length;
          return { cells: [td(esc(k), "is-mono"), td(esc(layers || "—"), "is-mono"), td(esc(rs.length + (off ? " (" + off + " disabled)" : "")), "is-note")] };
        }));
      },
      "The root": function () {
        return kv("Mock policy root", ui.hash(D.policy.root, { label: "Policy root" }) + '<span class="docs-count">&nbsp;· version ' + esc(D.policy.version) + " · " + esc(D.policy.rules.length) + " rules</span>") +
          links([link(R.dashboard.policy + "index.html", "Edit the policy", { icon: "arrow-up-right" })]);
      }
    },
    "attestations": {
      "What it binds": function () { return '<div class="docs-block">' + callout("What we claim", esc(BS.COPY.honestScope)) + "</div>"; },
      "Verify": function () { return links([link(R.site.verify + "index.html", "Open the verifier", { icon: "arrow-up-right" })]); }
    },
    "audit-and-disclosure": {
      "The chain": function () {
        return head ? kv("Mock chain head", '<span>#' + esc(fmt.int(head.index)) + "</span>&nbsp;" + ui.hash(head.hash, { label: "Head hash" })) : "";
      },
      "Disclose": function () { return links([link(R.dashboard.audit + "index.html", "Open the audit log", { icon: "arrow-up-right" })]); }
    },
    "tee-mode": {
      "The quote": function () {
        return code('$ curl ' + origin + '/api/tee/quote \\\n    -H "Authorization: Bearer $TOKEN"', "shell") +
          links([link(pageHref("api-reference", "ep-get-tee-quote"), "GET /tee/quote in the API reference", { page: "api-reference", hash: "ep-get-tee-quote" })]);
      }
    },
    "changelog": {
      "Latest": function () {
        if (!rel) return "";
        var items = (rel.added || []).concat(rel.changed || []).concat(rel.fixed || []);
        return '<ul class="docs-list">' + items.map(function (t) { return '<li class="docs-p">' + prose(t) + "</li>"; }).join("") + "</ul>" +
          links([link(R.site.changelog + "index.html", "Read the full changelog", { icon: "arrow-up-right" })]);
      }
    }
  };

  /* ── a fixture page ───────────────────────────────────────────────────── */
  function renderDoc(pg, first, targets) {
    var ex = EXTRA[pg.slug] || {};
    var n = 0, html = "";
    pg.sections.forEach(function (s) {
      n++;
      var id = slugify(s.heading);
      var codeHtml = "";
      if (s.code) codeHtml = /^\s*\{/.test(s.code) ? code(s.code, "json") : code("$ " + s.code, "shell");
      if (s.code && pg.slug === "install" && s.heading === "Install") codeHtml = install(s.code);   /* the site's install block */
      var add = ex[s.heading];
      var body = p(s.body) + codeHtml + (add ? add() : "");
      html += section(id, n, s.heading, body, { reveal: first });
      targets.push({ id: id, label: s.heading, level: 1 });
    });
    if (ex["@after"]) {
      n++;
      var tmp = document.createElement("div");
      tmp.innerHTML = ex["@after"](n);
      var sec = tmp.firstElementChild;
      if (first) sec.classList.add("reveal");
      html += tmp.innerHTML;
      targets.push({ id: sec.id, label: sec.getAttribute("data-label"), level: 1 });
    }
    return html;
  }

  /* ── the API reference (FRONTEND §5, from BS.data.apiReference) ───────── */
  var GROUPS = [["status", "Status"], ["decisions", "Decisions"], ["audit", "Audit"], ["policy", "Policy"], ["attestations", "Attestations"], ["tee", "TEE"]];
  function epId(e) { return "ep-" + e.method.toLowerCase() + "-" + e.path.replace(/[/:]+/g, "-").replace(/^-|-$/g, ""); }
  function pathHtml(path) {
    return esc(path).replace(/(:[a-z]+)/g, "<i>$1</i>");
  }
  function exampleValue(name, type) {
    if (name === "from") return 0;
    if (name === "to") return head ? Math.min(49, head.index) : 49;
    if (name === "decisionId") return exDecision;
    if (name === "expirySlots") return 150000;
    if (name === "cluster") return "devnet";
    if (name === "payload") return "<tool call JSON>";
    return type === "number" ? 0 : "…";
  }
  function curlOf(e) {
    var isAtt = /attestations/.test(e.path), hasId = /:id/.test(e.path);
    var path = e.path.replace(":id", "$ID");
    var q = { "/decisions": "?limit=50&verdict=block", "/audit/entries": "?from=0&to=49", "/attestations": e.method === "GET" ? "?status=generated" : "" }[e.path] || "";
    var url = origin + "/api" + path + q;
    var head0 = [];
    if (hasId) head0.push("$ ID=" + (isAtt ? exAtt : exDecision));
    if (e.params.some(function (x) { return x.name === "decisionId"; })) head0.push("# a decision with action fields");
    var lines = ["$ curl" + (e.method === "GET" ? "" : " -X " + e.method) + ' "' + url + '"', '    -H "Authorization: Bearer $TOKEN"'];
    e.params.filter(function (x) { return x.in === "header"; }).forEach(function (x) { lines.push('    -H "' + x.name + ": " + x.type.replace(/"/g, "") + '"'); });
    var body = e.params.filter(function (x) { return x.in === "body"; });
    if (body.length) {
      lines.push('    -H "Content-Type: application/json"');
      if (body[0].name === "rules") lines.push("    -d @policy.json");
      else {
        var o = {};
        body.forEach(function (x) { o[x.name] = exampleValue(x.name, x.type); });
        var one = "    -d '" + JSON.stringify(o).replace(/,"/g, ', "').replace(/":/g, '": ') + "'";
        lines.push(one.length <= 64 ? one : "    -d '" + JSON.stringify(o, null, 2).replace(/\n/g, "\n    ") + "'");
      }
    }
    if (/export$/.test(e.path)) lines.push("    -o attestation.json");
    return (head0.length ? head0.join("\n") + "\n" : "") + lines.join(" \\\n");
  }
  function bodyShape(e) {
    var b = e.params.filter(function (x) { return x.in === "body"; });
    if (!b.length) return "";
    return "{ " + b.map(function (x) { return x.name + (x.optional ? "?" : "") + ": " + x.type; }).join("; ") + " }";
  }
  function responseBlock(e) {
    var m = /^([A-Z]\w+)(\[\])?(\s*&\s*.+)?$/.exec(e.response);
    var t = m && TYPES[m[1]];
    var st = e.status === 202 ? "202 Accepted" : "200 OK";
    if (t) return code("// " + st + " · " + e.response + "\n" + tsOf(t), "ts");
    return code("// " + st + "\n" + e.response, "ts");
  }
  function endpointHtml(e) {
    var id = epId(e);
    var rows = e.params.map(function (x) {
      return { cells: [td(esc(x.name) + (x.optional ? '<span class="is-opt">?</span>' : ""), "is-mono"), td(esc(x.in), "is-mono is-note"), td(typeRefs(x.type), "is-mono is-type"), x.comment ? td(esc(x.comment), "is-note") : dash()] };
    });
    var shape = bodyShape(e);
    var refs = (e.response.match(/\b[A-Z][A-Za-z]+\b/g) || []).filter(function (n, i, a) { return TYPES[n] && a.indexOf(n) === i; });
    return '<details class="api-ep" id="' + id + '" data-api-ep="' + esc(e.method + " " + e.path) + '">' +
      '<summary class="api-ep__sum"><span class="api-m" data-m="' + esc(e.method) + '">' + esc(e.method) + '</span>' +
      '<span class="api-ep__path">' + pathHtml(e.path) + '</span><span class="api-ep__desc">' + esc(e.comment) + "</span>" + '<svg class="api-ep__chev lucide" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></summary>' +
      '<div class="api-ep__body">' +
        (rows.length ? "<div><p class=\"api-ep__k\">Parameters</p>" + table(["Name", "In", "Type", "Note"], rows) + "</div>" : '<p class="api-ep__note">No parameters.</p>') +
        "<div><p class=\"api-ep__k\">Request</p>" + code(curlOf(e), "shell") + "</div>" +
        (shape ? "<div><p class=\"api-ep__k\">Request body</p>" + code(shape, "ts") + "</div>" : "") +
        "<div><p class=\"api-ep__k\">Response <span class=\"chip " + (e.status === 202 ? "accent" : "neutral") + "\">" + (e.status || 200) + "</span></p>" + responseBlock(e) + "</div>" +
        (refs.length ? '<p class="api-ep__note">Types: ' + refs.map(function (r) { return '<a class="api-ref" href="#' + typeId(r) + '" data-goto="' + typeId(r) + '">' + esc(r) + "</a>"; }).join(", ") + "</p>" : "") +
      "</div></details>";
  }
  function renderApi(first, targets) {
    var html = "", n = 0;
    var authTail = API.auth.replace(/^[^.]+\.\s*/, "");

    /* 01 · base URL and auth */
    n++;
    html += section("base-url-and-auth", n, "Base URL and auth",
      code(API.baseUrl, "url") +
      '<div class="docs-block">' + code("Authorization: Bearer <token>", "header") + "</div>" +
      '<div class="docs-block">' + p(authTail) + "</div>" +
      '<div class="docs-sub" id="mock-mode-api" data-target data-label="Mock mode"><h3 class="docs-h3">Mock mode' + anchorBtn("mock-mode-api", "Mock mode") + "</h3>" +
        p(API.mock) + code("$ BLINDSEAL_MOCK=1 blindseal run", "shell") + "</div>", { reveal: first });
    targets.push({ id: "base-url-and-auth", label: "Base URL and auth", level: 1 }, { id: "mock-mode-api", label: "Mock mode", level: 2 });

    /* 02 · types */
    n++;
    targets.push({ id: "types", label: "Types", level: 1 });
    var types = API.types.map(function (t) {
      var id = typeId(t.name);
      targets.push({ id: id, label: t.name, level: 2, mono: true });
      var headHtml = '<div class="api-type__head"><h3 class="api-type__name">' + esc(t.name) + "</h3>" +
        '<span class="chip outline">' + esc(t.kind) + "</span>" +
        '<span class="docs-count">' + (t.kind === "type" ? "union" : t.fields.length + " fields") + "</span>" + anchorBtn(id, t.name) + "</div>";
      var bodyHtml;
      if (t.kind === "type") {
        var vals = (t.definition.match(/"([a-z]+)"/g) || []).map(function (v) { return v.replace(/"/g, ""); });
        bodyHtml = '<div class="api-type__def">' + code(tsOf(t), "ts") +
          '<p class="api-type__render">Renders as ' + vals.map(function (v) { return ui.verdict(v); }).join(" ") + "</p></div>";
      } else {
        bodyHtml = '<table class="table"><thead><tr><th scope="col">Field</th><th scope="col">Type</th><th scope="col">Note</th></tr></thead><tbody>' +
          t.fields.map(function (f) {
            return "<tr data-api-field>" + td(esc(f.name) + (f.optional ? '<span class="is-opt">?</span>' : ""), "is-mono") + td(typeRefs(f.type), "is-mono is-type") +
              (f.comment ? td(esc(f.comment), "is-note") : dash()) + "</tr>";
          }).join("") + "</tbody></table>";
      }
      return '<div class="table-box api-type" id="' + id + '" data-target data-label="' + esc(t.name) + '" data-api-type="' + esc(t.name) + '">' + headHtml + bodyHtml + "</div>";
    }).join("");
    html += section("types", n, "Types",
      p("Every shape the API sends, in TypeScript. A ? marks an optional field; type names link to their panel.") +
      '<div class="api-types">' + types + "</div>", { reveal: first, count: API.types.length + " types" });

    /* 03 · endpoints */
    n++;
    targets.push({ id: "endpoints", label: "Endpoints", level: 1 });
    var eps = GROUPS.map(function (g) {
      var list = API.endpoints.filter(function (e) { return e.path.split("/")[1] === g[0]; });
      if (!list.length) return "";
      var id = "endpoints-" + g[0];
      targets.push({ id: id, label: g[1], level: 2 });
      return '<div class="docs-sub" id="' + id + '" data-target data-label="' + esc(g[1]) + '"><h3 class="docs-h3">' + esc(g[1]) +
        '<span class="docs-count">' + list.length + "</span>" + anchorBtn(id, g[1]) + "</h3>" +
        '<div class="api-eps">' + list.map(endpointHtml).join("") + "</div></div>";
    }).join("");
    html += section("endpoints", n, "Endpoints",
      pHtml("Paths are relative to the base URL. Open a row for its parameters, a request and the response shape.") + eps,
      { reveal: first, count: API.endpoints.length + " endpoints" });

    /* 04 · websocket */
    n++;
    targets.push({ id: "websocket-events", label: "WebSocket events", level: 1 });
    var gen = (D.attestations || []).filter(function (a) { return a.status === "generating"; })[0];
    var wsExample = JSON.stringify({ type: "attestation", data: { id: gen ? gen.id : exAtt, status: "generating", progressPct: gen && gen.progressPct != null ? gen.progressPct : 62 } }, null, 2);
    html += section("websocket-events", n, "WebSocket events",
      '<div class="api-ws-path"><span class="api-m" data-m="WS">WS</span><span class="api-ep__path">' + esc(API.ws.path) + '</span><span class="api-ws-url">' + esc(origin.replace("http", "ws") + "/api" + API.ws.path) + "</span></div>" +
      '<div class="docs-block">' + table(["Type", "Data", "Note"], API.ws.messages.map(function (m) {
        return { attr: ' data-api-ws="' + esc(m.type) + '"', cells: [td('"' + esc(m.type) + '"', "is-mono"), td(typeRefs(m.data), "is-mono is-type"), td(esc(m.comment), "is-note")] };
      })) + "</div>" +
      '<div class="docs-block">' + code(wsExample, "json") + "</div>",
      { reveal: first, count: API.ws.messages.length + " messages" });

    /* 05 · errors */
    n++;
    targets.push({ id: "error-codes", label: "Error codes", level: 1 });
    html += section("error-codes", n, "Error codes",
      p("Errors come back as one envelope with the matching HTTP status. Handle every code below.") +
      code('{ "error": { "code": string; "message": string } }', "ts") +
      '<div class="docs-block">' + table(["Code", "HTTP", "Meaning"], API.errors.map(function (e) {
        return { attr: ' data-api-err="' + esc(e.code) + '"', cells: [td(esc(e.code), "is-mono"), td(esc(e.status), "is-mono is-note"), td(esc(e.comment), "is-note")] };
      })) + "</div>",
      { reveal: first, count: API.errors.length + " codes" });
    return html;
  }

  /* ── one whole page ───────────────────────────────────────────────────── */
  function render(slug, first) {
    var pg = BY[slug], targets = [];
    var mast = '<header class="docs-mast"><p class="docs-crumb"><span>Docs</span><span aria-hidden="true">/</span><span>' + esc(bucketOf[slug] || pg.group) + "</span></p>" +
      '<h1 class="docs-title" id="docs-title">' + esc(pg.title) + "</h1>" +
      '<p class="docs-summary">' + prose(pg.summary) + "</p>" +
      (slug === "api-reference" ? '<div class="docs-meta">' + [API.types.length + " types", API.endpoints.length + " endpoints", API.ws.messages.length + " WebSocket messages", API.errors.length + " error codes"].map(function (c) { return '<span class="chip neutral">' + esc(c) + "</span>"; }).join("") + "</div>" : "") +
      "</header>";
    var body = slug === "api-reference" ? renderApi(first, targets) : renderDoc(pg, first, targets);
    var prev = pg.prev && BY[pg.prev], next = pg.next && BY[pg.next];
    var pn = '<nav class="docs-pn" aria-label="Previous and next page">' +
      (prev ? '<a class="docs-pn__card" href="' + pageHref(prev.slug) + '" data-page="' + prev.slug + '" rel="prev"><span class="docs-pn__k">' + ico("chevron-left") + 'Previous</span><span class="docs-pn__t">' + esc(prev.title) + '</span><span class="docs-pn__g">' + esc(bucketOf[prev.slug]) + "</span></a>"
            : '<p class="docs-pn__start">You are on the first page.</p>') +
      (next ? '<a class="docs-pn__card docs-pn__card--next" href="' + pageHref(next.slug) + '" data-page="' + next.slug + '" rel="next"><span class="docs-pn__k">Next' + ico("chevron-right") + '</span><span class="docs-pn__t">' + esc(next.title) + '</span><span class="docs-pn__g">' + esc(bucketOf[next.slug]) + "</span></a>"
            : '<p class="docs-pn__end">End of the docs.</p>') +
      "</nav>";
    return { html: mast + body + pn, targets: targets, page: pg };
  }

  /* ── the tree ─────────────────────────────────────────────────────────── */
  var treeEl = $("[data-tree]");
  treeEl.innerHTML = buckets.map(function (b) {
    return '<div class="docs-tree__group"><p class="docs-tree__head">' + esc(b.name) + "</p>" + b.items.map(function (it) {
      return '<a class="docs-tree__item" href="' + pageHref(it.slug) + '" data-page="' + esc(it.slug) + '"><span class="docs-tree__dot" aria-hidden="true"></span><span>' + esc(it.title) + "</span></a>";
    }).join("") + "</div>";
  }).join("");
  if (rel) {
    $("[data-side-foot]").innerHTML = '<p class="docs-side__k">Latest release</p>' +
      '<p class="docs-side__v">proxy ' + esc(rel.version) + '<span class="chip outline">' + esc(fmt.date(rel.date + "T12:00:00Z")) + "</span></p>" +
      '<p class="docs-side__sub">The docs track the latest proxy release.</p>' +
      '<a class="docs-link" href="' + esc(R.site.changelog + "index.html") + '">Changelog' + ico("arrow-up-right") + "</a>";
  }
  function markTree(slug) {
    $$(".docs-tree__item", treeEl).forEach(function (a) {
      if (a.getAttribute("data-page") === slug) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
  }

  /* ── the outline: fill + scroll-spy ───────────────────────────────────── */
  var listEl = $("[data-otp-list]"), fill = $("[data-fill]"), topBtn = $("[data-top]");
  var io = null, visible = {}, targetsEls = [], linkMap = {}, parentOf = {}, ioActive = "", active = null, atBottom = false;
  function buildOutline(targets) {
    var lastTop = null;
    linkMap = {}; parentOf = {};
    listEl.innerHTML = targets.map(function (t) {
      if (t.level === 1) lastTop = t.id; else parentOf[t.id] = lastTop;
      return '<li><a class="docs-otp__link' + (t.level === 2 ? " is-sub" : "") + '" href="#' + esc(t.id) + '" data-otp="' + esc(t.id) + '">' + esc(t.label) + "</a></li>";
    }).join("");
    $$("[data-otp]", listEl).forEach(function (a) { linkMap[a.getAttribute("data-otp")] = a; });
    if (io) io.disconnect();
    visible = {}; ioActive = ""; active = null; pinned = "";
    targetsEls = targets.map(function (t) { return document.getElementById(t.id); }).filter(Boolean);
    io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) visible[e.target.id] = 1; else delete visible[e.target.id]; });
      ioActive = "";
      for (var i = targetsEls.length - 1; i >= 0; i--) { if (visible[targetsEls[i].id]) { ioActive = targetsEls[i].id; break; } }
      spy();
    }, { rootMargin: "-20% 0px -70% 0px" });
    targetsEls.forEach(function (el) { io.observe(el); });
  }
  function setActive(id) {
    if (id === active) return;
    active = id;
    var par = parentOf[id];
    Object.keys(linkMap).forEach(function (k) {
      var a = linkMap[k], on = k === id;
      a.classList.toggle("is-active", on);
      a.classList.toggle("is-parent", k === par);
      if (on) a.setAttribute("aria-current", "location"); else a.removeAttribute("aria-current");
    });
  }
  /* a clicked outline target stays lit until the reader scrolls by hand: a one-row
     subsection (TEE, Types) can never win the −20 % / −70 % band on its own */
  var pinned = "";
  function unpin() { pinned = ""; }
  window.addEventListener("wheel", unpin, { passive: true });
  window.addEventListener("touchstart", unpin, { passive: true });
  document.addEventListener("keydown", function (e) {
    if (/^(ArrowUp|ArrowDown|PageUp|PageDown|Home|End| |Spacebar)$/.test(e.key) && !(e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))) unpin();
  });
  function spy() {
    if (pinned && linkMap[pinned]) return setActive(pinned);
    if (!targetsEls.length) return setActive("");
    if (atBottom) return setActive(targetsEls[targetsEls.length - 1].id);
    if (targetsEls[0].getBoundingClientRect().top > window.innerHeight * 0.3) return setActive("");
    setActive(ioActive);
  }
  var pend = 0;
  function onScroll() {
    pend = 0;
    var se = document.scrollingElement || document.documentElement;
    var max = se.scrollHeight - window.innerHeight, y = window.scrollY;
    var pct = max > 0 ? Math.min(1, Math.max(0, y / max)) : 0;
    fill.style.transform = "scaleY(" + pct.toFixed(4) + ")";
    atBottom = max > 0 && max - y < 2;
    topBtn.disabled = y < 8;
    spy();
  }
  window.addEventListener("scroll", function () { if (!pend) pend = requestAnimationFrame(onScroll); }, { passive: true });
  window.addEventListener("resize", function () { if (!pend) pend = requestAnimationFrame(onScroll); });

  /* ── jump to an anchor inside the page ────────────────────────────────── */
  function jump(id, o) {
    o = o || {};
    var el = document.getElementById(id);
    if (!el) return;
    if (el.tagName === "DETAILS") el.open = true;
    var pin = linkMap[id] ? id : ((el.closest("[data-target]") || {}).id || "");
    if (pin && linkMap[pin]) { pinned = pin; setActive(pin); }
    el.scrollIntoView({ behavior: reduced() || o.instant ? "instant" : "smooth", block: "start" });
    try { history.replaceState(null, "", location.pathname + location.search + "#" + id); } catch (e) { /* file:// */ }
    var h = el.matches("h1,h2,h3") ? el : el.querySelector("h2, h3, summary");
    if (h && !o.noFocus) { if (!h.matches("summary")) h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
    if (el.classList.contains("api-type") && !reduced()) M.restart ? M.restart(el, "is-target") : (el.classList.remove("is-target"), void el.offsetWidth, el.classList.add("is-target"));
  }

  /* ── swap pages in place (200 ms crossfade, replaceState) ─────────────── */
  var stage = $("[data-stage]"), pageEl = $("[data-doc]"), current = null, swapTimer = 0;
  function setUrl(slug, hash) {
    try {
      var q = new URLSearchParams(location.search);
      q.set("page", PUBLIC[slug] || slug);
      history.replaceState(null, "", location.pathname + "?" + q.toString() + (hash ? "#" + hash : ""));
    } catch (e) { /* file:// */ }
  }
  function show(slug, o) {
    o = o || {};
    var r = render(slug, !!o.first);
    var next = document.createElement("article");
    next.className = "docs-page"; next.setAttribute("data-doc", ""); next.setAttribute("aria-live", "polite");
    next.innerHTML = r.html;
    if (o.first) {
      stage.replaceChild(next, pageEl);
      if (!reduced()) next.classList.add("is-rising");
    } else if (reduced()) {
      stage.replaceChild(next, pageEl);
    } else {
      var old = pageEl;
      clearTimeout(swapTimer);
      $$(".docs-page.is-leaving", stage).forEach(function (x) { x.remove(); });
      old.classList.remove("is-arriving", "is-rising");
      old.removeAttribute("data-doc"); old.removeAttribute("aria-live"); old.setAttribute("aria-hidden", "true"); old.setAttribute("inert", "");
      old.classList.add("is-leaving");
      stage.classList.add("is-swapping");
      stage.insertBefore(next, old);
      next.classList.add("is-arriving");
      M.restart(listEl, "is-arriving");
      swapTimer = setTimeout(function () { old.remove(); stage.classList.remove("is-swapping"); next.classList.remove("is-arriving"); listEl.classList.remove("is-arriving"); }, M.scale(200) + 40);
    }
    pageEl = next;
    current = slug;
    document.title = r.page.title + " · Docs · Blindseal";
    markTree(slug);
    window.scrollTo({ top: 0, behavior: "instant" });
    buildOutline(r.targets);
    onScroll();
    return r;
  }
  function go(slug, o) {
    o = o || {};
    if (slug !== current) {
      show(slug, {});
      setUrl(slug, o.hash);
      if (!o.hash) { var t = $("#docs-title", pageEl); if (t && o.focus !== false) { t.setAttribute("tabindex", "-1"); t.focus({ preventScroll: true }); } }
    }
    if (o.hash) M.raf2(function () { jump(o.hash, { instant: true }); });
  }

  /* ── delegated clicks: tree, prev / next, in-page links, refs, anchors ─── */
  document.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
    var a = e.target.closest("a[data-page]");
    if (a) { e.preventDefault(); go(a.getAttribute("data-page"), { hash: a.getAttribute("data-hash") }); return; }
    var ref = e.target.closest("a[data-goto]");
    if (ref) { e.preventDefault(); jump(ref.getAttribute("data-goto")); return; }
    var ol = e.target.closest("a[data-otp]");
    if (ol) { e.preventDefault(); jump(ol.getAttribute("data-otp")); return; }
    var an = e.target.closest("[data-anchor]");
    if (an) {
      e.preventDefault();
      var id = an.getAttribute("data-anchor");
      var url = location.origin + location.pathname + "?page=" + (PUBLIC[current] || current) + "#" + id;
      ui.writeClipboard(url, function () {
        if (an._t) clearTimeout(an._t);
        if (an._label == null) an._label = an.getAttribute("aria-label");
        an.classList.add("is-done"); an.innerHTML = ico("check"); an.setAttribute("aria-label", "Link copied");
        an._t = setTimeout(function () { an.classList.remove("is-done"); an.innerHTML = ico("link"); an.setAttribute("aria-label", an._label); an._label = null; }, 1400);
        document.dispatchEvent(new CustomEvent("bs:copy", { detail: { value: url } }));
      });
    }
  });
  topBtn.addEventListener("click", function () {
    window.scrollTo({ top: 0, behavior: reduced() ? "instant" : "smooth" });
    setUrl(current);
    var t = $("#docs-title", pageEl); if (t) { t.setAttribute("tabindex", "-1"); t.focus({ preventScroll: true }); }
  });

  /* ── search slot: visual only ─────────────────────────────────────────── */
  var search = $("#docs-search");
  function searchToast() { BS.toast({ title: "Search arrives with the build", body: "Every page is one click away in the tree for now.", tone: "info", id: "docs-search" }); }
  /* never on keyboard focus alone (Tab traversal): a press, the / shortcut, Enter or typing */
  search.addEventListener("pointerdown", searchToast);
  search.addEventListener("input", searchToast);
  search.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { search.value = ""; search.blur(); }
    if (e.key === "Enter") { e.preventDefault(); searchToast(); }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    search.focus();
    searchToast();
  });

  /* ── first paint ──────────────────────────────────────────────────────── */
  var params = new URLSearchParams(location.search);
  var asked = params.get("page");
  var start = resolve(asked || DEFAULT) || DEFAULT;
  show(start, { first: true });
  if (asked && !resolve(asked)) {
    setUrl(start);
    M.wait(400).then(function () { BS.toast({ title: "No docs page called “" + asked + "”", body: "Showing Install instead.", tone: "info", id: "docs-404" }); });
  }
  if (!reduced()) $("[data-docs]").classList.add("is-rising");
  BS.mountSite({ active: "docs" });                    /* after the render: it arms the first paint's .reveal */
  var initialHash = (location.hash || "").slice(1);
  if (initialHash && document.getElementById(initialHash)) M.raf2(function () { jump(initialHash, { instant: true, noFocus: true }); });
  onScroll();

  BS.page = {
    go: go, jump: jump,
    current: function () { return current; },
    active: function () { return active; },
    slugs: PAGES.map(function (x) { return x.slug; })
  };
})();
