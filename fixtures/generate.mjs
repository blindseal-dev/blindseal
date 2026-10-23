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

// The 22 committed L1 rules, verbatim from crates/detector-core (name + severity). The policy
// root is a Merkle over these 22 DFA leaves + 1 zero-width-threshold leaf = 23 leaves; it is NOT
// reproducible in JS (leaves are serialized regex-automata DFA bytes), so it is pinned to the real
// value emitted by detector-core's policy.rs test. See docs/FRONTEND-CONTRACT.md.
const L1_RULE_DEFS = [
  ['unicode-tag-smuggling', 'Malicious'],
  ['bidi-override-smuggling', 'Malicious'],
  ['html-entity-encoded-run', 'Suspicious'],
  ['instruction-prefix:ignore-previous', 'Malicious'],
  ['instruction-prefix:disregard-above', 'Malicious'],
  ['instruction-prefix:forget-previous', 'Malicious'],
  ['instruction-prefix:system-prefix', 'Malicious'],
  ['instruction-prefix:you-are-now', 'Malicious'],
  ['instruction-prefix:new-instructions', 'Malicious'],
  ['instruction-prefix:override-above', 'Malicious'],
  ['html-comment-injection', 'Suspicious'],
  ['markdown-link-prompt-anchor', 'Suspicious'],
  ['large-base64-blob', 'Suspicious'],
  ['bracket-ai-directive', 'Suspicious'],
  ['refusal-suppression-directive', 'Suspicious'],
  ['memory-store-injection', 'Malicious'],
  ['pipeline-authority-claim', 'Malicious'],
  ['sleeper-trigger-setup', 'Suspicious'],
  ['recursive-output-injection', 'Suspicious'],
  ['dan-dual-label', 'Malicious'],
  ['affirmative-prefix-elicitation', 'Suspicious'],
  ['task-reassignment-directive', 'Suspicious'],
];
const L1_RULES = L1_RULE_DEFS.map((r) => r[0]);
// L0 is decode-then-L1: a decoder surfaces hidden text that an L1 rule then catches.
const L0_RULES = ['base64-decoded-run', 'hex-decoded-run', 'url-decoded-run', 'html-entity-decoded-run'];

// Real committed policy root (detector-core default policy, 23 leaves) — see evals/vectors/policy-root.txt.
const POLICY_ROOT = '0x36a9e9457db6ecfd752a379fc9279ad6a0acfea07928f61e2f3638a685c38397';
const DETECTOR_VERSION = hex(32, 'detectorVersion'); // sp1 vkey (0x+64hex); real value is the guest vkey

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

// ---------- policy (22 committed L1 rules + zero-width threshold parameter) ----------
// Mirrors crates/detector-core exactly: 22 L1 rules, each a DFA leaf; severity Malicious -> block
// verdict, Suspicious -> flag. The committed root is over these 22 leaves + the zero-width
// threshold leaf (23 leaves total), pinned to the real detector-core value.
const SEV_VERDICT = { Malicious: 'block', Suspicious: 'flag' };
const rules = L1_RULE_DEFS.map(([name, severity]) => ({
  id: name,
  layer: 'L1',
  kind: 'dfa',
  name,
  severity,
  verdict: SEV_VERDICT[severity],
  enabled: true,
}));
const policy = {
  root: POLICY_ROOT,
  version: 2,
  updatedAt: iso(0),
  detectorVersion: DETECTOR_VERSION,
  leafCount: 23,
  parameters: { zeroWidthDensityThreshold: 0.1 },
  l0Decoders: L0_RULES,
  rules,
};

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
