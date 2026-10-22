// Blindseal synthetic fixtures generator (M0). Deterministic, no real traffic.
// Produces the files in FRONTEND.md §5.3 with shapes from §5.1.
//   node fixtures/generate.mjs
// Re-run anytime; output is stable for a fixed SEED.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = path.dirname(fileURLToPath(import.meta.url));
const SEED = 0xb1d5ea1;

// --- deterministic PRNG (mulberry32) ---
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;
const sha = (s) => '0x' + createHash('sha256').update(String(s)).digest('hex');
const hex = (n, salt) => '0x' + createHash('sha256').update(salt + ':' + n).digest('hex').slice(0, n * 2);
// base58 (Solana) address: 44 chars derived deterministically from a salt
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58addr(salt) {
  const h = createHash('sha256').update('addr:' + salt).digest();
  let s = '';
  for (let i = 0; i < 44; i++) s += B58[h[i % h.length] % 58];
  return s;
}

// Crockford base32 ULID-ish (synthetic, monotonic by index)
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid(i) {
  let s = '';
  let x = SEED + i * 7919;
  for (let k = 0; k < 26; k++) {
    s += B32[(x + k * 31) % 32];
    x = (x * 1103515245 + 12345) & 0x7fffffff;
  }
  return s;
}

const T0 = Date.parse('2026-10-20T09:00:00.000Z');
const iso = (i) => new Date(T0 + i * 37_000 + Math.floor(rnd() * 5000)).toISOString();

const SERVERS = [
  { name: 'filesystem', tools: ['read_file', 'write_file', 'list_dir'] },
  { name: 'github', tools: ['create_issue', 'get_pr', 'search_code'] },
  { name: 'postgres', tools: ['query', 'describe_table'] },
  { name: 'slack', tools: ['post_message', 'list_channels'] },
  { name: 'fetch', tools: ['get', 'head'] },
  { name: 'solana-tools', tools: ['transfer_sol', 'spl_transfer', 'invoke_program'] },
];
const REDACT_KINDS = ['api_key', 'private_key', 'seed_phrase', 'jwt', 'email', 'phone', 'card', 'ssn', 'high_entropy'];
const L1_RULES = ['l1-ignore-previous', 'l1-exfil-url', 'l1-tool-override', 'l1-zero-width', 'l1-base64-blob'];
const L0_RULES = ['l0-decoded-injection', 'l0-hex-payload'];

const POLICY_ROOT = hex(32, 'policyRoot');
const DETECTOR_VERSION = hex(32, 'detectorVersion'); // sp1 vkey hash placeholder

// ---------- decisions ----------
function layersFor(verdict, i) {
  const layers = [];
  const l0Fired = verdict === 'block' && chance(0.3);
  layers.push({
    layer: 'L0', ran: true, verdict: l0Fired ? 'block' : 'pass',
    ...(l0Fired ? { ruleIds: [pick(L0_RULES)] } : {}), latencyMs: +(rnd() * 0.8).toFixed(2),
  });
  const l1Fired = !l0Fired && (verdict === 'block' || (verdict === 'flag' && chance(0.6)));
  layers.push({
    layer: 'L1', ran: true, verdict: l1Fired ? (verdict === 'block' ? 'block' : 'flag') : 'pass',
    ...(l1Fired ? { ruleIds: [pick(L1_RULES)] } : {}), latencyMs: +(rnd() * 1.2).toFixed(2),
  });
  // L2 runs unless L0/L1 already blocked
  const l2Ran = !l0Fired;
  const l2Score = verdict === 'pass' ? +(0.05 + rnd() * 0.25).toFixed(3)
    : verdict === 'flag' ? +(0.3 + rnd() * 0.15).toFixed(3)
    : +(0.45 + rnd() * 0.4).toFixed(3);
  layers.push(l2Ran
    ? { layer: 'L2', ran: true, verdict: l2Score > 0.35 ? (verdict === 'block' ? 'block' : 'flag') : 'pass', score: l2Score, latencyMs: +(4 + rnd() * 6).toFixed(2), mode: 'local' }
    : { layer: 'L2', ran: false, verdict: 'skip', latencyMs: 0, mode: 'local' });
  // L3 runs on uncertain/flag/block, local mode
  const l3Ran = verdict !== 'pass' || chance(0.15);
  layers.push(l3Ran
    ? { layer: 'L3', ran: true, verdict: verdict === 'pass' ? 'pass' : verdict, score: +(0.5 + rnd() * 0.49).toFixed(3), latencyMs: +(300 + rnd() * 900).toFixed(0), mode: 'local' }
    : { layer: 'L3', ran: false, verdict: 'skip', latencyMs: 0, mode: 'local' });
  return layers;
}

function actionFor(i) {
  return {
    chain: 'solana',
    targetProgram: pick(['11111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA']),
    instruction: pick(['transfer', 'transferChecked', '0x02']),
    recipient: base58addr('recipient:' + i),
    amount: String(Math.floor(rnd() * 5_000_000_000)),
    mint: chance(0.5) ? 'So11111111111111111111111111111111111111112' : base58addr('mint:' + i),
  };
}

const decisions = [];
const N = 200;
for (let i = 0; i < N; i++) {
  const r = rnd();
  const verdict = r < 0.85 ? 'pass' : r < 0.95 ? 'block' : 'flag';
  const srv = pick(SERVERS);
  const tool = pick(srv.tools);
  const payloadHash = sha('payload:' + i);
  const redactions = [];
  if (chance(0.25)) {
    const k = pick(REDACT_KINDS);
    redactions.push({ kind: k, count: 1 + Math.floor(rnd() * 3) });
    if (chance(0.3)) redactions.push({ kind: pick(REDACT_KINDS), count: 1 });
  }
  const redactedHash = redactions.length ? sha('redacted:' + i) : payloadHash;
  const hasAction = i < 30 || srv.name === 'solana-tools';
  decisions.push({
    id: ulid(i),
    ts: iso(i),
    server: srv.name,
    tool,
    direction: chance(0.5) ? 'request' : 'response',
    verdict,
    layers: layersFor(verdict, i),
    payloadHash,
    redactedHash,
    redactions,
    ...(hasAction ? { action: actionFor(i) } : {}),
    policyRoot: POLICY_ROOT,
    detectorVersion: DETECTOR_VERSION,
    auditIndex: i,
    auditHash: '', // filled by audit chain below
    latencyMs: +(5 + rnd() * 1200).toFixed(0),
  });
}

// ---------- audit chain (matches decisions) ----------
const AUDIT_DOMAIN = 'blindseal.audit.v1';
const GENESIS = sha('blindseal.audit.genesis.v1' + hex(32, 'proxyIdentityPubkey'));
const entries = [];
let prevHash = GENESIS;
for (const d of decisions) {
  const entryCore = { index: d.auditIndex, ts: d.ts, decisionId: d.id, verdict: d.verdict, payloadHash: d.payloadHash, prevHash };
  const h = sha(AUDIT_DOMAIN + JSON.stringify(entryCore));
  d.auditHash = h;
  entries.push({ index: d.auditIndex, hash: h, prevHash, ts: d.ts, verdict: d.verdict, decisionId: d.id, payloadHash: d.payloadHash });
  prevHash = h;
}
const head = { index: entries.length - 1, hash: prevHash, ts: entries[entries.length - 1].ts };
const audit = { head, genesis: GENESIS, entries };

// ---------- policy (25 rules L0/L1) ----------
const rules = [];
const ruleDefs = [
  ['l0-decoded-injection', 'L0', 'regex', '(?i)ignore (all|previous) instructions'],
  ['l0-hex-payload', 'L0', 'threshold', 'decoded_entropy>4.0'],
  ['l1-ignore-previous', 'L1', 'regex', '(?i)ignore (the )?(above|previous|prior)'],
  ['l1-exfil-url', 'L1', 'regex', '(?i)(curl|fetch|POST)\\s+https?://'],
  ['l1-tool-override', 'L1', 'regex', '(?i)you are now|new instructions:'],
  ['l1-zero-width', 'L1', 'denylist', '\\u200b\\u200c\\u200d'],
  ['l1-base64-blob', 'L1', 'threshold', 'base64_run>256'],
];
for (let i = 0; i < 25; i++) {
  const base = ruleDefs[i % ruleDefs.length];
  rules.push({
    id: i < ruleDefs.length ? base[0] : `${base[0]}-${i}`,
    layer: base[1],
    kind: base[2],
    value: base[3],
    enabled: !chance(0.08),
    ...(chance(0.3) ? { note: 'synthetic fixture rule' } : {}),
  });
}
const policy = { root: POLICY_ROOT, version: 2, updatedAt: iso(0), rules };

// ---------- attestations (6, all statuses) ----------
const actionDecisions = decisions.filter((d) => d.action).slice(0, 6);
const STATUSES = ['generating', 'generated', 'submitted', 'consumed', 'expired', 'rejected'];
function mkAttestation(d, idx, status) {
  const nonce = hex(32, 'nonce:' + idx);
  const actionHash = hex(32, 'actionHash:' + idx);
  const nullifier = sha('blindseal.nullifier.v1' + actionHash);
  const expirySlot = 280_000_000 + idx * 1500 + (status === 'expired' ? -100000 : 50000);
  const publicInputs = [d.payloadHash, policy.root, DETECTOR_VERSION, actionHash, nullifier, '0x' + expirySlot.toString(16)];
  return {
    version: 1,
    id: 'att_' + nonce.slice(2, 10),
    decisionId: d.id,
    actionHash,
    policyRoot: policy.root,
    detectorVersion: DETECTOR_VERSION,
    expirySlot,
    nullifier,
    nonce,
    publicInputs,
    proof: { protocol: 'groth16', curve: 'bn254', bytes: hex(256, 'proof:' + idx) },
    tee: { mode: 'local' },
    status,
    ...(status === 'generating' ? { progressPct: 40 } : {}),
    ...(status === 'submitted' || status === 'consumed' ? { txSig: hex(32, 'txsig:' + idx).slice(2) } : {}),
    createdAt: iso(idx),
  };
}
const attestations = actionDecisions.map((d, idx) => mkAttestation(d, idx, STATUSES[idx % STATUSES.length]));
// link attestationId back onto the decisions
attestations.forEach((a) => {
  const d = decisions.find((x) => x.id === a.decisionId);
  if (d) d.attestationId = a.id;
});

// sample (good) + tampered (one public input flipped)
const sample = mkAttestation(actionDecisions[0], 100, 'generated');
const tampered = JSON.parse(JSON.stringify(sample));
tampered.publicInputs[3] = hex(32, 'tampered-actionHash'); // flip actionHash
tampered.status = 'rejected';

// ---------- write ----------
const files = {
  'decisions.json': decisions,
  'policy.json': policy,
  'audit.json': audit,
  'attestations.json': attestations,
  'attestation-sample.json': sample,
  'attestation-tampered.json': tampered,
};
for (const [name, data] of Object.entries(files)) {
  writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 2) + '\n');
}
const counts = decisions.reduce((a, d) => ((a[d.verdict] = (a[d.verdict] || 0) + 1), a), {});
console.log('wrote fixtures:', Object.keys(files).join(', '));
console.log('decisions:', decisions.length, counts, '| with action:', decisions.filter((d) => d.action).length);
console.log('audit entries:', entries.length, '| head.index:', head.index);
console.log('attestations:', attestations.length, 'statuses:', attestations.map((a) => a.status).join(','));
