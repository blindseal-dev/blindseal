/* ============================================================================
   D01 — Dashboard: Decisions (page.js)
   ----------------------------------------------------------------------------
   The operator's main screen: every screened tool call, live, with filters
   (verdict / server / tool / time) that map straight onto
   GET /decisions?verdict&server&tool&from&to, counts for the current filter,
   cursor pagination ("Load more", 50 at a time) and the live stream
   (BS.data.stream, one decision every 3 s) with Live / Paused.

   ?state=empty         onboarding empty state in place of the table
   ?state=unauthorized  full-screen token screen over a faint nebula, no shell
   ?state=offline       banner + countdown odometer, cached text cells dimmed to 80 % with a Cached chip (D36 cap)
   ?state=reconnecting  quieter banner, live stream held (bonus)

   Kit only: BS.mountShell, BS.ui.{seg, hash, verdict, layerStrip, status,
   code, empty, toast}, BS.motion.{odometer, enterRow, flash, wait, reduced},
   BS.data.{query, counts, stream, attestation, programName, on}, BS.fmt.
   Every hash goes through BS.ui.hash(). No colour literal in this file.
   ========================================================================== */
(function () {
  "use strict";

  var BS = window.BS, D = BS.data, ui = BS.ui, M = BS.motion, fmt = BS.fmt;
  var PAGE = 50;                       /* GET /decisions limit (brief: 50 rows) */
  var RANGES = { "1h": D.HOUR, "24h": D.DAY, "7d": 7 * D.DAY };
  var RETRY_EVERY = 5;                 /* s between reconnect attempts after the first (brief: "retrying in 5 s") */

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return [].slice.call((r || document).querySelectorAll(s)); }
  function esc(s) { return ui.esc(s); }
  function ico(n, o) { return BS.icon(n, o); }
  /* row link: ?id=<id>, plus the frozen clock / motion mode so D02 rebuilds the same fixtures */
  var CARRY = (function () {
    var q = new URLSearchParams(location.search), out = "";
    ["now", "motion"].forEach(function (k) { if (q.get(k)) out += "&" + k + "=" + encodeURIComponent(q.get(k)); });
    return out;
  })();
  function d02(id) { return "../D02/index.html?id=" + encodeURIComponent(id) + CARRY; }
  function reduced() { return M.reduced(); }
  function redCount(d) { return (d.redactions || []).reduce(function (a, r) { return a + r.count; }, 0); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  /* "YYYY-MM-DD HH:MM" in UTC — the from/to field format */
  function stamp(ms) {
    var t = new Date(ms);
    return t.getUTCFullYear() + "-" + pad(t.getUTCMonth() + 1) + "-" + pad(t.getUTCDate()) + " " + pad(t.getUTCHours()) + ":" + pad(t.getUTCMinutes());
  }
  function parseStamp(s) {
    var m = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?\s*$/.exec(s || "");
    if (!m) return NaN;
    var ms = Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
    var back = new Date(ms);
    if (back.getUTCMonth() !== +m[2] - 1 || back.getUTCDate() !== +m[3] || (m[4] && +m[4] > 23)) return NaN;
    return ms;
  }

  /* the fragment token: read it, keep it in memory, strip it from the address bar (01-PAGES §2.0) */
  var memToken = null;
  (function () {
    var m = /[#&]token=([^&]+)/.exec(location.hash || "");
    if (!m) return;
    memToken = decodeURIComponent(m[1]);
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* noop */ }
  })();

  /* ══ ?state=unauthorized — no shell, a full-screen panel over a faint nebula ══ */
  if (BS.state.is("unauthorized")) { mountUnauthorized(); return; }

  /* ══ the shell ════════════════════════════════════════════════════════════ */
  var EMPTY = BS.state.is("empty");
  var OFFLINE = BS.state.is("offline") || D.connection === "offline";
  var RECONNECTING = !OFFLINE && (BS.state.is("reconnecting") || D.connection === "reconnecting");
  var STREAMING = !EMPTY && !OFFLINE && !RECONNECTING;

  var actions = document.createElement("span");
  actions.className = "d01-actions";
  actions.innerHTML =
    '<div class="glass-seg d01-live" id="d01-live" aria-label="Live stream">' +
      '<button type="button" class="glass-seg__item" data-value="live"><span class="live-dot" aria-hidden="true"></span>Live</button>' +
      '<button type="button" class="glass-seg__item" data-value="paused">' + ico("pause") + "Paused</button>" +
    "</div>" +
    '<button type="button" class="d01-newpill" id="d01-newpill" aria-hidden="true" tabindex="-1">' + ico("chevron-up") +
      '<span class="d01-newpill__n num" data-new>0</span><span>new</span></button>';

  BS.mountShell({ active: "decisions", title: "Decisions", actions: actions });

  /* empty: a fresh chain — the status bar reads audit #0 (brief) */
  if (EMPTY) BS.shell.setAuditHead({ index: 0, hash: D.audit.head.hash, ts: D.audit.head.ts });

  var refs = {
    page: $("#d01-page"), banner: $("#d01-banner"), filters: $("#d01-filters"), counts: $("#d01-counts"),
    box: $("#d01-tablebox"), rows: $("#d01-rows"), none: $("#d01-none"), more: $("#d01-more"),
    loadMore: $("#d01-loadmore"), onboard: $("#d01-onboard"),
    server: $("#d01-server"), tool: $("#d01-tool"), from: $("#d01-from"), to: $("#d01-to"),
    range: $("#d01-range"), clear: $("#d01-clear"), live: $("#d01-live"), pill: $("#d01-newpill")
  };

  /* ══ filter state ═════════════════════════════════════════════════════════ */
  var DEFAULT = { verdict: "all", server: "", tool: "", range: "all", from: null, to: null };
  var filter = Object.assign({}, DEFAULT);
  var live = true, queue = [], cursor = null, shownCount = 0, firstPaint = true;

  function params(withVerdict) {
    var p = {};
    if (withVerdict !== false && filter.verdict !== "all") p.verdict = filter.verdict;
    if (filter.server) p.server = filter.server;
    if (filter.tool) p.tool = filter.tool;
    if (filter.from != null) p.from = filter.from;
    if (filter.to != null) p.to = filter.to;
    return p;
  }
  function matches(d) {
    var t = Date.parse(d.ts);
    if (filter.verdict !== "all" && d.verdict !== filter.verdict) return false;
    if (filter.server && d.server !== filter.server) return false;
    if (filter.tool && d.tool !== filter.tool) return false;
    if (filter.from != null && t < filter.from) return false;
    if (filter.to != null && t > filter.to) return false;
    return true;
  }
  function isDefault() {
    return filter.verdict === "all" && !filter.server && !filter.tool && filter.from == null && filter.to == null;
  }

  /* ══ rows ═════════════════════════════════════════════════════════════════ */
  function dayKey(ts) { return String(ts).slice(0, 10); }
  function dayLabel(key) {
    var today = dayKey(new Date(D.now()).toISOString());
    var yest = dayKey(new Date(D.now() - D.DAY).toISOString());
    var ms = Date.parse(key + "T12:00:00Z");
    var name = key === today ? "Today" : key === yest ? "Yesterday" : ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(ms).getUTCDay()];
    return '<span class="d01-day__name">' + name + '</span><span class="d01-day__date">' + esc(fmt.date(ms)) + "</span>";
  }
  function dayRow(key) {
    return '<tr class="d01-day" data-day="' + key + '"><th colspan="11" scope="rowgroup">' + dayLabel(key) + "</th></tr>";
  }
  function nil() { return '<span class="d01-nil" aria-label="none">—</span>'; }
  function actionTip(a) {
    var prog = D.programName(a.targetProgram) || fmt.shortB58(a.targetProgram);
    return a.chain + " · " + prog + (a.instruction ? " · " + a.instruction : "") + (a.recipient ? " → " + fmt.shortB58(a.recipient) : "");
  }
  function attCell(d) {
    if (!d.attestationId) return nil();
    var a = D.attestation(d.attestationId);
    return ui.status(a ? a.status : "generating", { progress: a ? a.progressPct : 0 });
  }
  function rowHtml(d) {
    var rc = redCount(d);
    var redTip = (d.redactions || []).map(function (r) { return r.kind + " × " + r.count; }).join(", ");
    return '<tr class="table__row is-clickable d01-row" data-id="' + esc(d.id) + '" data-day-of="' + dayKey(d.ts) + '">' +
      '<td class="is-time"><a class="d01-rowlink" href="' + d02(d.id) + '" data-tip="' + esc(fmt.dateTime(d.ts)) + '" aria-label="' +
        esc("Decision at " + fmt.dateTime(d.ts) + ", " + d.server + " " + d.tool + ", " + d.verdict) + '">' + esc(fmt.time(d.ts)) + "</a></td>" +
      "<td>" + esc(d.server) + "</td>" +
      '<td class="is-muted d01-tool">' + esc(d.tool) + "</td>" +
      '<td><span class="d01-dir" data-dir="' + esc(d.direction) + '" data-tip="' + (d.direction === "request" ? "Request: screened before the call ran" : "Response: screened before the agent saw it") + '">' + (d.direction === "request" ? "req" : "res") + "</span></td>" +
      "<td>" + ui.verdict(d.verdict) + "</td>" +
      "<td>" + ui.layerStrip(d.layers) + "</td>" +
      '<td class="num">' + (rc ? '<span class="d01-red" data-tip="' + esc(redTip) + '">' + rc + "</span>" : nil()) + "</td>" +
      "<td>" + (d.action ? '<span class="chip outline d01-act" data-tip="' + esc(actionTip(d.action)) + '">' + ico("box") + esc(d.action.chain) + "</span>" : nil()) + "</td>" +
      '<td data-att="' + esc(d.attestationId || "") + '">' + attCell(d) + "</td>" +
      '<td class="num d01-lat">' + esc(fmt.ms(d.latencyMs)) + "</td>" +
      "<td>" + ui.hash(d.payloadHash, { label: "Payload hash (sha256, pre-redaction)" }) + "</td>" +
      "</tr>";
  }
  /* rows (+ a day divider whenever the UTC day changes); lastKey = the day already open above */
  function rowsHtml(items, lastKey) {
    var out = "";
    items.forEach(function (d) {
      var k = dayKey(d.ts);
      if (k !== lastKey) { out += dayRow(k); lastKey = k; }
      out += rowHtml(d);
    });
    return out;
  }
  function lastDayKey() {
    var last = refs.rows.lastElementChild;
    return last ? last.getAttribute("data-day") || last.getAttribute("data-day-of") : null;
  }

  /* the filter / load-more cascade: card-in, 20 ms per row, capped at 12 (page.css sets --stagger-card) */
  function cascade(nodes) {
    if (reduced() || !nodes.length) return;
    nodes.forEach(function (n, i) { n.style.setProperty("--i", String(i)); n.classList.remove("card-in"); });
    void refs.rows.offsetWidth;
    nodes.forEach(function (n) { n.classList.add("card-in"); });
  }
  refs.rows.addEventListener("animationend", function (e) {
    var n = e.target;
    if (e.animationName === "card-in") { n.classList.remove("card-in"); n.style.removeProperty("--i"); }
  });

  /* ══ counts: odometers for the current filter ═════════════════════════════ */
  var odo = {};
  $$("[data-odo]", refs.counts).forEach(function (el) { odo[el.getAttribute("data-odo")] = M.odometer(el, 0, { mode: "roll", format: fmt.int }); });
  odo.of = M.odometer($("[data-of]", refs.counts), D.decisions.length, { mode: "tick", format: fmt.int });
  var segOdo = {};
  $$("[data-count]", refs.filters).forEach(function (el) { segOdo[el.getAttribute("data-count")] = M.odometer(el, 0, { mode: "tick", format: fmt.int }); });
  var moreOdo = {
    shown: M.odometer($("[data-shown]", refs.more), 0, { mode: "tick", format: fmt.int }),
    matching: M.odometer($("[data-matching]", refs.more), 0, { mode: "tick", format: fmt.int })
  };
  var matching = 0;

  function refreshCounts() {
    var c = D.counts(params(true));
    var all = D.counts(params(false));
    matching = c.total;
    odo.total.set(c.total);
    odo.pass.set(c.pass); odo.block.set(c.block); odo.flag.set(c.flag);
    odo.of.set(D.decisions.length);
    ["pass", "block", "flag"].forEach(function (v) {
      $('[data-share="' + v + '"]', refs.counts).textContent = c.total ? fmt.pct(c[v] / c.total) + " of matching" : "—";
    });
    segOdo.total.set(all.total); segOdo.pass.set(all.pass); segOdo.block.set(all.block); segOdo.flag.set(all.flag);
    refreshMore();
  }
  function refreshMore() {
    shownCount = refs.rows.querySelectorAll("tr.d01-row").length;
    moreOdo.shown.set(shownCount);
    moreOdo.matching.set(matching);
    var done = !cursor;
    refs.loadMore.disabled = done;
    $("[data-more-label]", refs.loadMore).textContent = done ? "All loaded" : "Load " + Math.min(PAGE, Math.max(0, matching - shownCount)) + " more";
    refs.more.hidden = matching === 0;
    refs.clear.disabled = isDefault();
    var none = matching === 0;
    refs.none.hidden = !none;
    refs.box.classList.toggle("is-none", none);
    if (none && !refs.none.innerHTML) {
      refs.none.innerHTML = ui.empty({ bare: true, icon: "filter", title: "No decisions match",
        body: "Nothing screened in this window matches these filters. Widen the time range or clear them.",
        actions: '<button type="button" class="btn secondary sm" data-clear>' + ico("rotate-ccw") + "Clear filters</button>" });
    }
  }

  /* ══ render (filters apply instantly) ═════════════════════════════════════ */
  function render() {
    queue = []; setPill();
    var q = D.query(Object.assign(params(true), { limit: PAGE }));
    cursor = q.nextCursor || null;
    refs.rows.innerHTML = rowsHtml(q.items, null);
    refreshCounts();
    if (!firstPaint) cascade([].slice.call(refs.rows.children));
    firstPaint = false;
  }

  function loadMore() {
    if (!cursor || refs.loadMore.getAttribute("aria-busy") === "true") return;
    refs.loadMore.setAttribute("aria-busy", "true");
    /* the cursor page: GET /decisions?cursor=c_<auditIndex>&limit=50&… */
    M.wait(180).then(function () {
      var q = D.query(Object.assign(params(true), { limit: PAGE, cursor: cursor }));
      cursor = q.nextCursor || null;
      var before = refs.rows.children.length;
      refs.rows.insertAdjacentHTML("beforeend", rowsHtml(q.items, lastDayKey()));
      cascade([].slice.call(refs.rows.children, before));
      refs.loadMore.removeAttribute("aria-busy");
      refreshMore();
      if (!cursor) BS.toast({ title: "All " + fmt.int(shownCount) + " decisions loaded", body: "The oldest entry is audit #" + D.decisions[D.decisions.length - 1].auditIndex + ".", tone: "info", id: "more" });
    });
  }
  refs.loadMore.addEventListener("click", loadMore);

  /* ══ live stream: prepend, enter + flash; Paused queues, the pill releases ══ */
  function prepend(list) {
    /* list is oldest → newest; the newest ends on top */
    var fresh = [];
    list.forEach(function (d) {
      var k = dayKey(d.ts);
      var top = refs.rows.firstElementChild;
      if (top && top.classList.contains("d01-day") && top.getAttribute("data-day") === k) {
        top.insertAdjacentHTML("afterend", rowHtml(d));
        fresh.push(top.nextElementSibling);
      } else {
        refs.rows.insertAdjacentHTML("afterbegin", dayRow(k) + rowHtml(d));
        fresh.push(refs.rows.children[1]);
      }
    });
    if (reduced()) return fresh;
    /* one cascade, newest first: row-in 320 out-expo + the 2.4 s flash, 20 ms apart */
    fresh.reverse().forEach(function (tr, i) {
      var go = function () { M.enterRow(tr); M.flash(tr); };
      if (i === 0) go(); else setTimeout(go, M.scale(Math.min(i, 11) * 20));
    });
    return fresh;
  }
  var pillOdo = M.odometer($("[data-new]", refs.pill), 0, { mode: "tick", format: fmt.int });
  function setPill() {
    var n = queue.length;
    pillOdo.set(n);
    var on = !live && n > 0;
    refs.pill.classList.toggle("is-on", on);
    refs.pill.setAttribute("aria-hidden", String(!on));
    refs.pill.tabIndex = on ? 0 : -1;
    refs.pill.setAttribute("aria-label", "Release " + n + " new decision" + (n === 1 ? "" : "s"));
  }
  function release() {
    if (!queue.length) return;
    var list = queue.slice(); queue = [];
    prepend(list);
    refreshCounts();
    setPill();
  }
  refs.pill.addEventListener("click", release);

  function onDecision(d, head) {
    BS.shell.setAuditHead(head);
    /* the numbers always follow the audit head; only the rows wait while Paused */
    if (matches(d)) { if (live) prepend([d]); else { queue.push(d); setPill(); } }
    refreshCounts();
  }

  var liveSeg = ui.seg(refs.live, {
    value: "live",
    onChange: function (v) {
      live = v === "live";
      refs.page.toggleAttribute("data-held", !live);   /* not .is-paused: that kit class freezes every animation below it */
      if (live) release();
      setPill();
    }
  });

  /* attestation progress from the event bus (WS "attestation") */
  D.on("attestation", function (a) {
    $$('td[data-att="' + a.id + '"] .status', refs.rows).forEach(function (el) { ui.setStatus(el, a.status, { progress: a.progressPct }); });
  });

  /* ══ filter controls ══════════════════════════════════════════════════════ */
  var verdictSeg = ui.seg($("#d01-verdict"), { value: "all", onChange: function (v) { filter.verdict = v; render(); } });

  D.status.upstreams.forEach(function (u) {
    var o = document.createElement("option");
    o.value = u.name; o.textContent = u.name; if (!u.healthy) o.title = "unhealthy: not answering";
    refs.server.appendChild(o);
  });
  function fillTools() {
    var keep = filter.tool;
    var list = D.tools.filter(function (t) { return !filter.server || t.server === filter.server; });
    var html = '<option value="">All tools</option>';
    if (filter.server) html += list.map(function (t) { return '<option value="' + esc(t.tool) + '">' + esc(t.tool) + "</option>"; }).join("");
    else D.status.upstreams.forEach(function (u) {
      var ts = list.filter(function (t) { return t.server === u.name; });
      if (ts.length) html += '<optgroup label="' + esc(u.name) + '">' + ts.map(function (t) { return '<option value="' + esc(t.tool) + '">' + esc(t.tool) + "</option>"; }).join("") + "</optgroup>";
    });
    refs.tool.innerHTML = html;
    if (keep && list.some(function (t) { return t.tool === keep; })) refs.tool.value = keep;
    else { filter.tool = ""; refs.tool.value = ""; }
  }
  fillTools();
  refs.server.addEventListener("change", function () { filter.server = refs.server.value; fillTools(); render(); });
  refs.tool.addEventListener("change", function () { filter.tool = refs.tool.value; render(); });

  var rangeBtns = $$(".tab", refs.range);
  refs.range.setAttribute("role", "group");
  function markRange() { rangeBtns.forEach(function (b) { var on = b.dataset.value === filter.range; b.classList.toggle("is-active", on); b.setAttribute("aria-pressed", String(on)); }); }
  function setRange(v) {
    filter.range = v;
    filter.to = null;
    filter.from = RANGES[v] ? D.now() - RANGES[v] : null;
    refs.from.value = filter.from != null ? stamp(filter.from) : "";
    refs.to.value = "";
    [refs.from, refs.to].forEach(function (i) { i.removeAttribute("aria-invalid"); });
    markRange();
  }
  rangeBtns.forEach(function (b) { b.addEventListener("click", function () { if (filter.range === b.dataset.value) return; setRange(b.dataset.value); render(); }); });
  markRange();

  function onDate(input, key) {
    var v = input.value.trim();
    if (!v) { input.removeAttribute("aria-invalid"); filter[key] = null; }
    else {
      var ms = parseStamp(v);
      if (isNaN(ms)) {
        input.setAttribute("aria-invalid", "true");
        BS.toast({ title: "Use YYYY-MM-DD HH:MM", body: "Times are UTC, e.g. " + stamp(D.now() - D.HOUR) + ".", tone: "warn", id: "date" });
        return;
      }
      input.removeAttribute("aria-invalid");
      if (key === "to" && !/\d:\d/.test(v)) ms += D.DAY - D.MIN;   /* a bare date as "to" runs to 23:59 */
      filter[key] = key === "to" ? ms + D.MIN - 1 : ms;             /* "to" includes its whole minute */
      input.value = stamp(ms);
    }
    filter.range = filter.from == null && filter.to == null ? "all" : "custom";
    markRange();
    render();
  }
  refs.from.addEventListener("change", function () { onDate(refs.from, "from"); });
  refs.to.addEventListener("change", function () { onDate(refs.to, "to"); });
  [refs.from, refs.to].forEach(function (i) { i.addEventListener("keydown", function (e) { if (e.key === "Enter") i.blur(); }); });

  function clearAll() {
    filter = Object.assign({}, DEFAULT);
    verdictSeg.set("all", { silent: true });
    refs.server.value = ""; fillTools();
    setRange("all");
    render();
  }
  refs.clear.addEventListener("click", clearAll);
  refs.none.addEventListener("click", function (e) { if (e.target.closest("[data-clear]")) clearAll(); });

  /* ══ row → /decisions/:id (D02) ═══════════════════════════════════════════ */
  function openDecision(tr) {
    var href = d02(tr.getAttribute("data-id"));
    $$("tr.is-open", refs.rows).forEach(function (r) { r.classList.remove("is-open"); });
    tr.classList.add("is-open");
    if (reduced()) { location.href = href; return; }
    /* the shell's page → page path: cover in 180, then D02 lifts it quick */
    BS.shell.cover(false).then(function () {
      try { sessionStorage.setItem("bs-route-v1", String(Date.now())); } catch (e) { /* noop */ }
      location.href = href;
    });
  }
  refs.rows.addEventListener("click", function (e) {
    var tr = e.target.closest("tr.d01-row");
    if (!tr || e.target.closest(".hash")) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) {
      if (!e.target.closest("a")) window.open(d02(tr.getAttribute("data-id")), "_blank", "noopener");
      return;
    }
    e.preventDefault();
    openDecision(tr);
  });
  refs.rows.addEventListener("auxclick", function (e) {
    var tr = e.target.closest("tr.d01-row");
    if (tr && e.button === 1 && !e.target.closest("a, .hash")) window.open(d02(tr.getAttribute("data-id")), "_blank", "noopener");
  });
  /* back from D02 (bfcache): lift the cover, drop the open mark */
  window.addEventListener("pageshow", function (e) {
    if (!e.persisted) return;
    BS.shell.uncover(true);
    $$("tr.is-open", refs.rows).forEach(function (r) { r.classList.remove("is-open"); });
  });

  /* ══ states ═══════════════════════════════════════════════════════════════ */
  if (EMPTY) mountEmpty();
  else render();

  if (OFFLINE) mountOffline();
  else if (RECONNECTING) mountReconnecting();

  if (!STREAMING) {
    $$(".glass-seg__item", refs.live).forEach(function (b) { b.disabled = true; });
    refs.live.setAttribute("data-tip", EMPTY ? "Live as soon as the first tool call is screened" : "The event stream is down; live resumes when the proxy answers");
  }
  if (STREAMING) D.stream.start(onDecision);
  if (memToken && STREAMING) BS.toast({ title: "Token held in memory", body: "Read from #token= and stripped from the address bar.", tone: "ok", id: "token" });

  /* ── ?state=empty — the onboarding ─────────────────────────────────────── */
  function mountEmpty() {
    [refs.filters, refs.counts, refs.box, refs.more].forEach(function (n) { n.hidden = true; });
    refs.onboard.hidden = false;
    var snippet = [
      '"mcpServers": {',
      '  "github": {',
      '    "command": "blindseal",',
      '    "args": ["run", "--upstream", "github-mcp"]',
      "  }",
      "}"
    ].join("\n");
    var chips = D.status.upstreams.map(function (u) {
      return '<li class="d01-up" data-healthy="' + u.healthy + '" data-tip="' + esc(u.transport + " · " + (u.healthy ? "healthy" : "unhealthy: not answering")) + '" tabindex="0" role="button">' +
        ico(u.transport === "http" ? "radio" : "terminal") + '<span class="d01-up__name">' + esc(u.name) + '</span><span class="d01-up__t">' + esc(u.transport) + "</span></li>";
    }).join("");
    refs.onboard.innerHTML =
      '<div class="d01-onboard__lead">' +
        '<p class="eyebrow">Fresh install</p>' +
        '<h2 class="d01-onboard__title" id="d01-onboard-title">No decisions yet.</h2>' +
        '<p class="d01-onboard__body">Point an agent at the proxy and every tool call will appear here as it is screened.</p>' +
        '<p class="d01-listen"><span class="live-dot" aria-hidden="true"></span>Listening on <span class="d01-mono">127.0.0.1:7777</span><span class="d01-listen__sep">·</span>audit #0</p>' +
        '<a class="btn link d01-doclink" href="../S04/index.html?page=point-an-agent">Point an agent at the proxy<span class="nudge">' + ico("arrow-right") + "</span></a>" +
      "</div>" +
      '<ol class="d01-steps">' +
        '<li class="d01-step"><span class="d01-step__n">01</span><div class="d01-step__main"><p class="d01-step__t">Route an MCP server through the proxy</p>' +
          '<p class="d01-step__d">In the agent\'s MCP config, launch the server with <span class="d01-mono">blindseal run</span> in front of it.</p>' + ui.code(snippet, { lang: "json" }) + "</div></li>" +
        '<li class="d01-step"><span class="d01-step__n">02</span><div class="d01-step__main"><p class="d01-step__t">Upstreams detected <span class="d01-step__count num">' + D.status.upstreams.length + "</span></p>" +
          '<p class="d01-step__d">Any of these names works as <span class="d01-mono">--upstream</span>.</p><ul class="d01-ups">' + chips + "</ul></div></li>" +
        '<li class="d01-step"><span class="d01-step__n">03</span><div class="d01-step__main"><p class="d01-step__t">Or run mock mode</p>' +
          '<div class="d01-mockline">' + ui.code("$ BLINDSEAL_MOCK=1 blindseal run") + '<span class="d01-step__d">to try it with fixtures.</span></div></div></li>' +
      "</ol>";
    refs.onboard.querySelector(".d01-doclink").addEventListener("click", function (e) {
      e.preventDefault();
      var href = this.getAttribute("href");
      if (reduced()) { location.href = href; return; }
      BS.shell.cover(false).then(function () { location.href = href; });
    });
    $$(".d01-up", refs.onboard).forEach(function (li) {
      li.addEventListener("click", function () {
        BS.toast({ title: li.querySelector(".d01-up__name").textContent, body: li.getAttribute("data-healthy") === "true" ? "Healthy. Use it as --upstream " + li.querySelector(".d01-up__name").textContent + "." : "Not answering. Check it on Settings.", tone: li.getAttribute("data-healthy") === "true" ? "info" : "warn", id: "up" });
      });
      li.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); li.click(); } });
    });
  }

  /* ── ?state=offline — banner + countdown, cached rows dimmed ───────────── */
  function mountOffline() {
    var rc = D.reconnect || { attempt: 1, nextInSec: RETRY_EVERY };
    var attempt = rc.attempt, left = RETRY_EVERY;   /* attempt from the fixture; the wait reads the brief's 5 s from first paint */
    var lastSync = D.decisions[0] ? fmt.time(D.decisions[0].ts) + " UTC" : "—";
    refs.banner.hidden = false;
    refs.banner.setAttribute("data-kind", "offline");
    refs.banner.innerHTML =
      '<span class="d01-banner__ico">' + ico("triangle-alert") + "</span>" +
      '<p class="d01-banner__main"><span class="d01-banner__t">Proxy unreachable</span><span class="d01-banner__sep">·</span>' +
        '<span class="d01-banner__retry" data-retry>retrying in <span class="num d01-banner__s" data-left>' + left + "</span> s</span></p>" +
      '<p class="d01-banner__sub">Attempt <span class="num" data-attempt>' + attempt + "</span> · showing cached decisions from the last sync at " + esc(lastSync) + ". Start it with <span class=\"d01-mono\">blindseal run</span>.</p>" +
      '<button type="button" class="btn secondary sm d01-banner__btn" data-retry-now>' + ico("refresh-cw") + "Retry now</button>";
    refs.box.classList.add("is-stale");
    var retryEl = $("[data-retry]", refs.banner);
    var leftOdo = M.odometer($("[data-left]", refs.banner), left, { mode: "tick", format: String });
    var attOdo = M.odometer($("[data-attempt]", refs.banner), attempt, { mode: "tick", format: String });
    var btn = $("[data-retry-now]", refs.banner);
    var timer = 0, trying = false;
    function tick() {
      if (trying) return;
      left -= 1;
      if (left <= 0) { tryNow(); return; }
      leftOdo.set(left);
    }
    function tryNow() {
      trying = true;
      retryEl.classList.add("is-trying");
      btn.setAttribute("aria-busy", "true");
      retryEl.firstChild.textContent = "retrying now… ";
      setTimeout(function () {
        trying = false;
        attempt += 1; attOdo.set(attempt);
        left = RETRY_EVERY; leftOdo.set(left);
        retryEl.firstChild.textContent = "retrying in ";
        retryEl.classList.remove("is-trying");
        btn.removeAttribute("aria-busy");
      }, M.scale(1200));
    }
    btn.addEventListener("click", function () {
      if (trying) return;
      tryNow();
      BS.toast({ title: "Still unreachable", body: "127.0.0.1:7777 did not answer. Cached data stays visible.", tone: "warn", id: "retry" });
    });
    timer = setInterval(tick, 1000);
    document.addEventListener("visibilitychange", function () { if (document.hidden) clearInterval(timer); else { clearInterval(timer); timer = setInterval(tick, 1000); } });
  }

  function mountReconnecting() {
    refs.banner.hidden = false;
    refs.banner.setAttribute("data-kind", "reconnecting");
    refs.banner.innerHTML =
      '<span class="d01-banner__ico">' + ico("refresh-cw") + "</span>" +
      '<p class="d01-banner__main"><span class="d01-banner__t">Event stream reconnecting</span><span class="d01-banner__sep">·</span><span class="d01-banner__retry">live updates held</span></p>' +
      '<p class="d01-banner__sub">The API still answers; filters and Load more work on the latest data.</p>';
  }

  /* ══ ?state=unauthorized ══════════════════════════════════════════════════ */
  function mountUnauthorized() {
    var main = document.getElementById("main-content");
    main.classList.add("d01-authmain");
    document.documentElement.classList.add("d01-auth-html");
    main.innerHTML =
      '<div class="d01-auth">' +
        '<div class="d01-auth__space" aria-hidden="true"></div>' +
        '<div class="d01-auth__col">' +
          '<section class="panel d01-auth__panel" aria-labelledby="d01-auth-title">' +
            '<div class="d01-auth__mark">' + BS.mark("A", 40) + "</div>" +
            '<p class="eyebrow">Blindseal · local dashboard</p>' +
            '<h1 class="d01-auth__title" id="d01-auth-title">Dashboard token required</h1>' +
            '<p class="d01-auth__body">The token is printed when the proxy starts and lives at <span class="d01-mono d01-path">~/.blindseal/dashboard.token</span>. Open the dashboard with it in the URL fragment:</p>' +
            '<div class="d01-auth__url"><span class="d01-mono">http://127.0.0.1:7777/#token=…</span></div>' +
            '<form class="d01-auth__form" id="d01-auth-form" novalidate>' +
              '<div class="field"><label for="d01-token">Paste token</label>' +
                '<div class="d01-auth__row"><input class="input mono" id="d01-token" name="token" autocomplete="off" spellcheck="false" placeholder="48 hex characters" aria-describedby="d01-token-help">' +
                '<button type="submit" class="btn primary" id="d01-continue">Continue<span class="nudge">' + ico("arrow-right") + "</span></button></div>" +
                '<p class="field__err" id="d01-token-err" hidden>' + ico("triangle-alert") + "<span></span></p>" +
              "</div>" +
            "</form>" +
            '<p class="d01-auth__note" id="d01-token-help">' + ico("info") + "The token is kept in memory only: never written to storage, and stripped from the address bar once read.</p>" +
          "</section>" +
          '<p class="d01-auth__foot"><span class="d01-mono">127.0.0.1:7777</span><span class="d01-auth__sep" aria-hidden="true">·</span><span>v' + esc((BS.VERSION && BS.VERSION.proxy) || "0.4.0") + '</span><span class="d01-auth__sep" aria-hidden="true">·</span><a class="link" href="' + esc(stateHref()) + '">Open the mock dashboard</a></p>' +
        "</div>" +
      "</div>";
    BS.mountSpace($(".d01-auth__space"), { intensity: "faint", seed: 7, stars: 140 });
    var form = $("#d01-auth-form"), input = $("#d01-token"), err = $("#d01-token-err"), go = $("#d01-continue");
    function fail(msg) {
      input.setAttribute("aria-invalid", "true");
      err.hidden = false; err.querySelector("span").textContent = msg;
      input.focus();
    }
    input.addEventListener("input", function () { input.removeAttribute("aria-invalid"); err.hidden = true; });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var v = input.value.trim();
      if (!v) { fail("Paste the token printed at proxy start."); return; }
      if (!/^[0-9a-f]{48}$/i.test(v)) { fail("A dashboard token is 48 hex characters."); return; }
      go.setAttribute("aria-busy", "true");
      M.wait(600).then(function () {
        go.removeAttribute("aria-busy");
        var ok = v.toLowerCase() === String(D.token || "").toLowerCase();
        BS.toast(ok
          ? { title: "Token accepted", body: "Held in memory for this tab. In the build the dashboard opens now.", tone: "ok", id: "auth" }
          : { title: "Token not accepted", body: "The proxy answered UNAUTHORIZED. Rotate it on Settings or copy it again from the proxy log.", tone: "warn", id: "auth" });
      });
    });
    requestAnimationFrame(function () { input.focus({ preventScroll: true }); });
  }
  /* the same URL without the state switch (keeps ?now= and ?motion=) */
  function stateHref() {
    var q = new URLSearchParams(location.search);
    q.delete("state");
    var s = q.toString();
    return "index.html" + (s ? "?" + s : "");
  }
})();
