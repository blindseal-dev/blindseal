#!/usr/bin/env node
// Production dependency audit gate (CI job `dependency audit`).
//
// Runs `pnpm audit --prod --json` and fails (exit 1) on any critical or high advisory that is not in the
// allowlist. The allowlist (scripts/audit-allowlist.json) holds advisories that were triaged as not
// reachable from Blindseal's code; each entry is documented in SECURITY.md ("Dependency advisories") and
// carries an expiry date, after which it fails the gate until it is re-triaged.
//
//   node scripts/audit-deps.mjs [--dir <workspace root>] [--allowlist <file>] [--json <saved audit output>]
//
// Allowlist format: [{ "id": "GHSA-…", "package": "<module name>", "reason": "…", "expires": "YYYY-MM-DD" }]
// Entries match on the GHSA id AND the package (one GHSA can cover several packages). Moderate/low advisories
// are reported but do not fail. An expired entry fails. An entry the audit no longer reports only warns.
// The gate fails closed: an audit that errors or returns no advisory data is a failure, not a pass.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const dir = path.resolve(opt('--dir', path.join(HERE, '..')));
const allowFile = path.resolve(opt('--allowlist', path.join(HERE, 'audit-allowlist.json')));
const savedJson = opt('--json', null);
const FAIL_ON = new Set(['critical', 'high']);

const die = (msg) => { console.error(`audit-deps: ${msg}`); process.exit(1); };

// ---- allowlist -----------------------------------------------------------------------------------------
let allow;
try { allow = JSON.parse(readFileSync(allowFile, 'utf8')); } catch (e) { die(`cannot read allowlist ${allowFile}: ${e.message}`); }
if (!Array.isArray(allow)) die('allowlist must be a JSON array');
const today = new Date().toISOString().slice(0, 10);
let bad = 0;
for (const [i, e] of allow.entries()) {
  const where = `allowlist[${i}] ${e?.id ?? '?'} (${e?.package ?? '?'})`;
  if (!e || !/^GHSA(-[0-9a-z]{4}){3}$/.test(e.id ?? '')) { console.error(`✗ ${where}: id must be a GHSA id`); bad++; continue; }
  if (!e.package) { console.error(`✗ ${where}: package missing`); bad++; }
  if (!e.reason || e.reason.length < 20) { console.error(`✗ ${where}: reason missing or too short`); bad++; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.expires ?? '')) { console.error(`✗ ${where}: expires must be YYYY-MM-DD`); bad++; }
  else if (e.expires < today) { console.error(`✗ ${where}: expired ${e.expires} — re-triage it and update SECURITY.md`); bad++; }
}
const key = (id, pkg) => `${id}::${pkg}`;
const allowed = new Map(allow.map((e) => [key(e.id, e.package), e]));

// ---- audit ---------------------------------------------------------------------------------------------
let raw;
if (savedJson) raw = readFileSync(savedJson, 'utf8');
else {
  try {
    raw = execFileSync('pnpm', ['audit', '--prod', '--json'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // pnpm audit exits non-zero whenever it finds anything; the JSON on stdout is what counts
    raw = e.stdout ?? '';
    if (!raw.trim()) die(`pnpm audit produced no output (exit ${e.status}): ${String(e.stderr ?? e.message).trim().slice(0, 500)}`);
  }
}
let report;
try { report = JSON.parse(raw); } catch { die(`pnpm audit output is not JSON: ${raw.slice(0, 300)}`); }
if (report.error) die(`pnpm audit error: ${JSON.stringify(report.error).slice(0, 500)}`);
if (!report.advisories || typeof report.advisories !== 'object' || !report.metadata?.vulnerabilities) die('pnpm audit returned no advisory data — failing closed');

const seen = new Set();
const rows = { fail: [], allowed: [], info: [] };
for (const a of Object.values(report.advisories)) {
  const id = a.github_advisory_id || `npm:${a.id}`;
  const k = key(id, a.module_name);
  seen.add(k);
  const versions = [...new Set((a.findings ?? []).map((f) => f.version))].join(',');
  const via = (a.findings?.[0]?.paths?.[0] ?? '').replace(/__/g, '/');
  const line = `${a.severity.padEnd(8)} ${id}  ${a.module_name}@${versions} (fixed ${a.patched_versions})  via ${via}`;
  if (allowed.has(k)) rows.allowed.push(`${line}\n           allowlisted until ${allowed.get(k).expires}: ${allowed.get(k).reason}`);
  else if (FAIL_ON.has(a.severity)) rows.fail.push(line);
  else rows.info.push(line);
}
for (const e of allow) if (!seen.has(key(e.id, e.package))) console.warn(`! allowlist entry no longer reported by the audit (remove it): ${e.id} (${e.package})`);

const v = report.metadata.vulnerabilities;
console.log(`pnpm audit --prod: ${report.metadata.dependencies ?? '?'} deps; critical ${v.critical} · high ${v.high} · moderate ${v.moderate} · low ${v.low}`);
if (rows.allowed.length) { console.log(`\nallowlisted (documented in SECURITY.md):`); for (const r of rows.allowed) console.log(`  ${r}`); }
if (rows.info.length) { console.log(`\nmoderate/low, not allowlisted (reported, not failing):`); for (const r of rows.info) console.log(`  ${r}`); }
if (rows.fail.length) { console.log(`\n✗ critical/high advisories not allowlisted:`); for (const r of rows.fail) console.log(`  ${r}`); }
if (rows.fail.length || bad) {
  console.log(`\naudit-deps: FAIL — ${rows.fail.length} unaddressed critical/high advisor${rows.fail.length === 1 ? 'y' : 'ies'}, ${bad} allowlist problem${bad === 1 ? '' : 's'}. Upgrade/override the package, or triage it as not reachable: add it to scripts/audit-allowlist.json and SECURITY.md.`);
  process.exit(1);
}
console.log('\naudit-deps: pass — no unaddressed critical/high advisories');
