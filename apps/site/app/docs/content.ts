// The docs data model — the site-side BS.data.docs (+ apiReference) of the S04 mockup. page.js rendered the
// tree from { group, items [{ slug, title }] } and each page from { slug, group, title, summary, sections
// [{ heading, body, code }], prev, next }; here a section holds typed blocks (prose, code, lists, callouts,
// links, the API table) and the page's path is a real Next route. The written content is the reviewed text
// of the previous docs pages — only the presentation changed. Prose uses a tiny inline markup (inline.tsx):
// `code`, **strong**, *em*, [label](href).

export type CodeLang = 'shell' | 'json' | 'ts' | 'rust' | 'text';
export type LinkIcon = 'arrow-right' | 'arrow-up-right';
export type Endpoint = { method: 'GET' | 'POST' | 'PUT' | 'WS'; path: string; comment: string };

export type Block =
  | { kind: 'p'; text: string }
  | { kind: 'code'; text: string; lang: CodeLang }
  | { kind: 'list'; ordered?: boolean; items: string[] }
  | { kind: 'callout'; title: string; body: string; muted?: boolean }
  | { kind: 'links'; links: { href: string; label: string; icon?: LinkIcon; external?: boolean }[] }
  | { kind: 'api'; endpoints: Endpoint[] };

export type DocSection = { id: string; heading: string; count?: string; blocks: Block[] };
export type DocPage = {
  slug: string; path: string; group: string; title: string; nav?: string; summary: string; sections: DocSection[];
  prev?: string; next?: string;
};
export type TreeGroup = { group: string; items: { slug: string; title: string; path: string; keywords: string }[] };
export type Target = { id: string; label: string; level: 1 | 2 };

const p = (text: string): Block => ({ kind: 'p', text });
const code = (text: string, lang: CodeLang): Block => ({ kind: 'code', text, lang });
const list = (items: string[], ordered = false): Block => ({ kind: 'list', ordered, items });

// ── the Local API (the dashboard's) ──────────────────────────────────────────
export const API_ENDPOINTS: Endpoint[] = [
  { method: 'GET', path: '/api/status', comment: 'Proxy status: connection, policy root, detector version, audit head, L3 mode.' },
  { method: 'GET', path: '/api/decisions', comment: 'List decisions; filters verdict/server/tool/from/to, cursor pagination.' },
  { method: 'GET', path: '/api/decisions/:id', comment: 'One decision with all layer results and commitments.' },
  { method: 'POST', path: '/api/decisions/:id/reveal', comment: 'Reveal the raw payload (requires X-Confirm: reveal). Never stored.' },
  { method: 'GET', path: '/api/audit/head', comment: 'The current hash-chain head.' },
  { method: 'GET', path: '/api/audit/entries', comment: 'Content-free entries in a range (from/to).' },
  { method: 'POST', path: '/api/audit/verify', comment: 'Recompute the chain from genesis → { ok, brokenAt? }.' },
  { method: 'POST', path: '/api/audit/disclose', comment: 'Signed disclosure for a range { from, to }.' },
  { method: 'GET', path: '/api/policy', comment: 'The committed policy: root, version, leaf count, rules.' },
  { method: 'PUT', path: '/api/policy', comment: 'Replace rules; the proxy recomputes the Merkle root.' },
  { method: 'POST', path: '/api/policy/dry-run', comment: 'Screen a payload without logging or chaining it.' },
  { method: 'GET', path: '/api/attestations', comment: 'List attestations; filter by status.' },
  { method: 'POST', path: '/api/attestations', comment: 'Request an attestation for a decision with an action.' },
  { method: 'POST', path: '/api/attestations/:id/submit', comment: 'Submit to Solana mainnet → tx signature.' },
  { method: 'GET', path: '/api/nullifiers/:nullifier', comment: 'On-chain status of a nullifier (mainnet, read server-side).' },
  { method: 'GET', path: '/api/tee/quote', comment: 'The L3 TEE quote. TEE mode is planned; today this returns mode "local".' },
  { method: 'WS', path: '/events', comment: 'Live stream: decision, status, policy, attestation frames.' },
];

// The canonical hashing spec. detector-core, blindseal-verify and the SDK reproduce it byte for byte;
// change all of them together with this text.
const HASHING_SPEC = `payloadHash     = sha256(payload_bytes)            -- payload_bytes = canonical_json({tool, args}); no domain prefix in v1 (the shipped guest)
policyRoot      = merkle_sha256(leaves), leaf_i = sha256("blindseal.rule.v1" || rule_id || layer || kind || compiled_bytes)
                  (compiled_bytes = DFA bytes for regex rules, raw value otherwise; tree sorted by rule_id; empty tree = sha256("blindseal.policy.empty.v1"))
detectorVersion = sp1 vkey hash of the guest program (bytes32)
actionHash      = sha256("blindseal.action.v1"
                  || chainId(u16 LE)           -- 1 = solana mainnet, 2 = reserved (no devnet), 3+ reserved for EVM
                  || targetProgram(32)
                  || sourceAuthority(32)       -- signer/authority the action executes under; zero if n/a
                  || instruction(8)            -- anchor discriminator or sha256(name)[..8]
                  || recipient(32)             -- zero if n/a
                  || mint(32)                  -- zero for native
                  || amount(u64 LE)            -- zero if n/a
                  || payloadHash(32)
                  || policyRoot(32)
                  || detectorVersion(32)
                  || expirySlot(u64 LE)
                  || nonce(32))                -- random per attestation
nullifier       = sha256("blindseal.nullifier.v1" || actionHash)`;

// ── the pages, in reading order (prev / next follow it) ──────────────────────
const PAGE_LIST: Omit<DocPage, 'prev' | 'next'>[] = [
  {
    slug: 'quickstart', path: '/docs', group: 'Getting started', title: 'Quickstart',
    summary: 'Install Blindseal, place it between your agent and its tools, and see requests being checked on your own computer. You can try the local dashboard without connecting a real agent. No Solana development tools are needed for basic use.',
    sections: [
      { id: 'install', heading: 'Install and run', blocks: [
        code(`$ npm i -g blindseal              # or run every command below with npx: npx blindseal …
$ blindseal init                   # scaffolds ~/.blindseal: identity keys, the default policy, the dashboard token
$ blindseal run --mock             # the local API + dashboard over sample traffic
blindseal (MOCK): local API on http://127.0.0.1:7777
  dashboard: http://127.0.0.1:7777/#token=…`, 'shell'),
        p('`blindseal` is the proxy and the CLI in one package. The proxy serves the dashboard from its own origin with a Content-Security-Policy that allows the WebAssembly verifier and nothing else. Open the printed URL — the token is in the fragment and never leaves memory. `run --mock` shows the dashboard over sample decisions; leave `--mock` off once an agent is pointed at the proxy.'),
        { kind: 'links', links: [{ href: 'https://www.npmjs.com/package/blindseal', label: 'blindseal on npm', icon: 'arrow-up-right', external: true }] },
      ] },
      { id: 'agent', heading: 'Point an agent', blocks: [
        p('Put `blindseal --` in front of the MCP server command. Everything after the `--` is the upstream server; every tool call and result passes the four detection layers locally before it reaches the agent or the server.'),
        code(`$ blindseal -- github-mcp --stdio    # the proxy launches the server and sits in the middle`, 'shell'),
        p('Or let `blindseal init --wrap` rewrite the MCP configs it finds so every server is launched through the proxy. By hand, the config entry looks like this:'),
        code(`"mcpServers": {
  "github": { "command": "blindseal", "args": ["--", "github-mcp"] }
}`, 'json'),
      ] },
      { id: 'attest', heading: 'Attest a screened action', blocks: [
        p('An attestation is a Groth16 proof that a specific tool call was screened under a committed policy by a specific detector version and that the committed L1 rules passed (L0 decoding runs in the proxy but is not inside the proof yet — see [What is proven](/docs/scope)). Proving runs locally on CPU and takes hours: the sample attestation on the [verify page](/verify) took 2 h 16 min to prove on an Apple M1 Max (32 GB). It is asynchronous by design.'),
        p('`call.json` is the screened tool call: the tool name and its arguments. For the transfer gate it must carry the source authority, the recipient and the amount in lamports:'),
        code(`{\n  "toolName": "transfer_sol",\n  "args": { "from": "<source authority pubkey>", "to": "<recipient pubkey>", "lamports": 1000000, "memo": "optional" }\n}`, 'json'),
        code(`$ blindseal attest call.json --target-program 9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa --out attestation.json
decision d_…: clean (audit #12 0x…)
proving (hours on CPU)…
attestation written: attestation.json`, 'shell'),
        p('The attestation expires at the current slot + 40,000 by default (about 4.4 hours), because proving takes hours; pass `--expiry <slot>` for a longer window, or `--no-expiry` to opt out. `attest` warns when your last proof took more than half the window.'),
        p('The decision is appended to the hash-chained audit log before proving starts, content-free: only ids, the verdict and the payload hash. The prover is a separate binary: on first use it is downloaded from the project’s GitHub release for your platform, or you can build it yourself and pass `--prover <path>` (see [From source](/docs/source)).'),
      ] },
      { id: 'verify', heading: 'Verify it — anywhere', blocks: [
        code(`$ blindseal verify attestation.json        # off-chain, the wasm verifier
$ blindseal submit attestation.json --wallet source.json   # Solana mainnet: the gated transfer — transfer-gate verifies and consumes in one transaction
$ blindseal submit attestation.json --check   # has this nullifier been consumed?`, 'shell'),
        p('Or drop the file on the [verify page](/verify): it runs the same verifier in your browser and uploads nothing. `submit` compares the RPC’s genesis hash with mainnet-beta’s before sending; there is no other cluster. `blindseal audit verify` recomputes the local audit chain, and `blindseal dashboard` reopens the dashboard for a running proxy.'),
      ] },
      { id: 'api', heading: 'API reference', count: `${API_ENDPOINTS.length} endpoints`, blocks: [
        p('The local API the dashboard speaks. Auth: `Authorization: Bearer <token>`. Same-origin only; the browser never contacts an RPC — on-chain reads go through the proxy.'),
        { kind: 'api', endpoints: API_ENDPOINTS },
      ] },
    ],
  },
  {
    slug: 'concepts', path: '/docs/concepts', group: 'Concepts', title: 'Concepts',
    summary: 'Blindseal sits between an agent and its tools. Every call and result is screened locally, the decision is written to a hash-chained log, and — when the action touches a chain — a zero-knowledge proof binds the screening to that exact action. The five objects below are the whole model.',
    sections: [
      { id: 'decision', heading: 'Decision', blocks: [
        p('One screened tool call or result. Four layers run in order: L0 decodes (base64, hex, URL, HTML entities, nested) and re-screens; L1 is a fixed set of regex rules compiled to DFAs; L2 compares embeddings against a corpus; L3 is a model judge. Today the proof covers L1; L0 runs in the proxy and is next to go inside the proof; L2 and L3 are attested, not proven. A decision carries a verdict (pass / flag / block), which layer decided, and the commitments below. The raw payload is encrypted at rest and can be revealed on the operator’s explicit confirmation; it is never written to the chain or the log.'),
      ] },
      { id: 'policy', heading: 'Policy and the policy root', blocks: [
        p('The policy is the set of deterministic rules in force. Its root is a Merkle root over one leaf per rule, where a regex rule’s leaf hashes its compiled DFA bytes — so the root commits to exactly what the detector executes, not to a pattern string that could be compiled differently. Changing a rule, or the regex engine version, changes the root. Operators can register roots on chain and run the verifier in allowlist mode.'),
      ] },
      { id: 'audit', heading: 'Audit chain and disclosure', blocks: [
        p('Each decision appends a content-free entry — decision id, verdict, payload hash, timestamp — whose hash includes the previous entry’s hash. `audit verify` recomputes the chain from genesis; any edit shows as a break. A *disclosure* is a signed slice of the chain over a time window that a third party can verify offline against the proxy’s identity key, without seeing any content.'),
      ] },
      { id: 'attestation', heading: 'Attestation', blocks: [
        p('A Groth16 proof from an SP1 zkVM guest that: recomputed the payload hash, recomputed the policy root from the DFAs it ran, ran L1 and found the payload clean, and bound the on-chain action through an *action hash*. Its public inputs are six values — payload hash, policy root, detector version (the guest’s verifying key), action hash, nullifier, expiry slot. Nothing about the content, the agent, or the operator is public. Proving is local, CPU-only and slow — the sample attestation took 2 h 16 min on an Apple M1 Max (32 GB); it is asynchronous by design and the measured numbers are published in `docs/performance.md`.'),
      ] },
      { id: 'verifier', heading: 'On-chain verifier and nullifier', blocks: [
        p('A Solana program verifies the proof (one instruction, alt_bn128 syscalls) and consumes a *nullifier* — a PDA derived from the action hash — so an attestation can be used exactly once. A gated program calls it by CPI in the same transaction as the action it guards, passing the action fields **it** is about to execute; if they differ from the screened action the hash does not match and the transaction fails. If the action itself fails, the whole transaction reverts and the nullifier stays unconsumed. The verifier has a paused flag, a vkey allowlist and an optional policy-root allowlist, all authority-controlled.'),
      ] },
      { id: 'mainnet', heading: 'One chain', blocks: [
        p('Solana mainnet is the only deploy target; `chainId 1` is the only chain id and the SDK refuses to send to any RPC whose genesis hash is not mainnet-beta’s. Localnet exists for the test suite only.'),
      ] },
    ],
  },
  {
    slug: 'hashing', path: '/docs/hashing', group: 'Canonical hashing', title: 'Canonical hashing', nav: 'Hashing spec',
    summary: 'All hashes are SHA-256 (a Solana syscall and an SP1 precompile), domain-separated.',
    sections: [
      { id: 'spec', heading: 'The spec', blocks: [
        p('This is the canonical spec; three implementations reproduce it byte for byte and are tested against each other: the Rust detector core (host and in-zkVM), the on-chain program, and the TypeScript SDK.'),
        code(HASHING_SPEC, 'text'),
        p('Nonce exists so two legitimately identical actions get distinct attestations. Nullifier is a pure function of the action hash so the consumer can’t be tricked into accepting a nullifier for a different action.'),
      ] },
      { id: 'public-inputs', heading: 'Public inputs', blocks: [
        p('The proof commits one 168-byte blob in this order: `payloadHash ‖ policyRoot ‖ detectorVersion ‖ actionHash ‖ nullifier` (five × 32 bytes) then `expirySlot` as a little-endian u64. The verifier (on chain and in the browser) checks the proof against the blob; UIs decode the blob into the six named fields for display.'),
      ] },
      { id: 'pdas', heading: 'On-chain addresses', blocks: [
        code(`Config     = PDA(["config"])
PolicyRoot = PDA(["policy", policyRoot32])
Nullifier  = PDA(["nullifier", nullifier32])     -- exists ⇔ consumed
program    = 6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx  (Solana mainnet)`, 'text'),
      ] },
    ],
  },
  {
    slug: 'integrate', path: '/docs/integrate', group: 'Gating a program on an attestation', title: 'Gating a program on an attestation', nav: 'Gated programs',
    summary: 'A Solana program can make proof of screening a requirement. It checks that a valid Blindseal proof belongs to the exact action it is about to perform, and rejects the action if the proof is wrong, expired, or already used.',
    sections: [
      { id: 'rule', heading: 'The one rule', blocks: [
        p('The action details must come from the receiving program’s own intended action, not separate details supplied by the agent. The program must also check that the proof uses approved rules and software, and verify it in the same transaction as the action.'),
        { kind: 'callout', title: 'What makes this sound', body: 'The action fields you forward to the verifier must come from what **your program** is about to execute — your own id, your instruction discriminator, the signer you debit, the recipient, the mint, the amount — never from anything the agent hands you.' },
      ] },
      { id: 'cpi', heading: 'CPI verify_and_consume', blocks: [
        p('Add `blindseal-verify` with the `cpi` feature and call it before the action. The example below is the shipped `transfer-gate` program, a native-SOL transfer.'),
        code(`use blindseal_verify::{cpi::accounts::VerifyAndConsume, ActionArgs, program::BlindsealVerify};

let disc: [u8; 8] = <crate::instruction::GatedTransfer as anchor_lang::Discriminator>::DISCRIMINATOR
    .try_into().unwrap();
let action = ActionArgs {
    chain_id: 1,                                   // Solana mainnet (the only chain id)
    target_program: crate::ID,                     // ourselves
    source_authority: ctx.accounts.source.key(),   // the signer we debit
    instruction: disc,                             // our discriminator
    recipient: ctx.accounts.recipient.key(),
    mint: Pubkey::default(),                       // native SOL
    amount,
    nonce,                                         // from the attestation
};
blindseal_verify::cpi::verify_and_consume(
    CpiContext::new(ctx.accounts.verify_program.to_account_info(), VerifyAndConsume {
        config: ctx.accounts.config.to_account_info(),
        policy_root: ctx.accounts.policy_root.as_ref().map(|a| a.to_account_info()),
        nullifier: ctx.accounts.nullifier.to_account_info(),
        payer: ctx.accounts.source.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
    }),
    proof, public_inputs, action,
)?;
// …then the action. If it fails, the whole tx reverts and the nullifier stays unconsumed.
system_program::transfer(/* source → recipient, amount */)?;`, 'rust'),
        p('Type the verifier account as `Program<\'info, BlindsealVerify>` so a caller cannot substitute another program for the CPI.'),
      ] },
      { id: 'checks', heading: 'What the verifier checks, in order', blocks: [
        list([
          'not paused',
          '`detectorVersion` is an allowed vkey',
          'if allowlist mode: the policy root is registered',
          '`expirySlot ≥` the current slot',
          'the action hash recomputed from *your* fields (+ the committed values + the nonce) equals the public one — `ActionHashMismatch` otherwise',
          'the nullifier matches and has not been consumed — `NullifierAlreadyConsumed` on replay',
          'the Groth16 proof verifies (sp1-solana)',
          'the Nullifier PDA is created (payer = your signer) and `Consumed` is emitted',
        ], true),
        p('Each step fails with its own error code. The five wrong-field cases all surface as `ActionHashMismatch`: the proof binds one hash over all of them, so the program cannot name which field diverged.'),
      ] },
      { id: 'client', heading: 'Client side', blocks: [
        code(`import { buildVerifyIx, actionArgsFrom, submit } from 'blindseal-sdk';

// compose into your own transaction (gated program)…
const ix = buildVerifyIx(attestation, actionArgsFrom(attestation), { payer: wallet.publicKey });

// …or submit directly (no gated program): verifies on chain and consumes the nullifier
const sig = await submit(attestation, { wallet });   // refuses any RPC that is not mainnet-beta`, 'ts'),
        p('Budget about 230k compute units for the verify step plus your own logic; set the limit explicitly with a ComputeBudget instruction (the default 200k is not enough). Measured figures live in `docs/performance.md`.'),
      ] },
      { id: 'accounts', heading: 'Accounts', blocks: [
        code(`config      PDA(["config"])                      read
policy_root PDA(["policy", policyRoot])          read, optional (pass the program id for None)
nullifier   PDA(["nullifier", nullifier])        writable, must not exist
payer       signer, writable                     pays the Nullifier PDA rent
program     6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx`, 'text'),
      ] },
    ],
  },
  {
    slug: 'scope', path: '/docs/scope', group: 'What is proven — and what is not', title: 'What is proven — and what is not', nav: 'What is proven',
    summary: 'Blindseal proves that a specific call was screened under a committed policy by a specific detector version, and that the committed L1 rules passed. L0 decoding is run by the proxy but is not inside the proof yet; the model-based layers run locally and are attested, not proven (a TEE mode is planned). Blindseal does not prove an agent is safe, and does not cover traffic that doesn\'t pass through the proxy. CPU proving takes hours, so v1 is prove-then-act, not real-time gating; faster proving is M4.',
    sections: [
      { id: 'plain', heading: 'In plain words', blocks: [
        { kind: 'callout', title: 'What we prove today', body: 'A specific request was checked under a specific set of rules and software version. Its pattern checks passed, and the proof is tied to one exact action.' },
        { kind: 'callout', title: 'What we do not prove yet', body: 'That all four layers passed inside the proof, that every agent action went through Blindseal, or that an action is risk-free. Blindseal does not cover requests that bypass it or protect against a compromised computer.', muted: true },
      ] },
      { id: 'proven', heading: 'Proven (zero-knowledge, verifiable by anyone)', blocks: [
        list([
          'The payload with this hash was screened by the detector with this verifying key, under the policy with this root.',
          'The committed L1 rules (regex rules, as committed DFAs) found it clean. A proof cannot exist for a payload L1 flags.',
          'The screening is bound to one on-chain action — program, instruction, signer, recipient, mint, amount — and to an expiry slot and a fresh nonce.',
          'On chain: the attestation was consumed once. A second use fails.',
        ]),
      ] },
      { id: 'attested', heading: 'Attested, not proven', blocks: [
        list([
          'L2 (embeddings) and L3 (model judge) verdicts. They are recorded in the audit log and can be run in a TEE (planned); their output is not inside the proof.',
          'The content of the audit log itself. The chain proves integrity and order of entries, not that an operator ran every call through the proxy.',
        ]),
      ] },
      { id: 'not', heading: 'Not covered', blocks: [
        list([
          'Traffic that does not pass through the proxy.',
          'Novel attacks the committed rules miss. On the published red-team corpus the proven layer alone catches roughly a third of attacks and little of the novel holdout set; detection in practice leans on L2/L3, which are attested rather than proven. The numbers are in `packages/LIMITATIONS.md` and are updated with every corpus change.',
          'The correctness of the gated program beyond the fields it forwards. Blindseal checks that the forwarded action equals the screened one; it does not audit the program.',
          'L0 (decode-then-L1) is run by the proxy but is not inside the proof yet; the proof covers L1 on the payload as received. L0 inside the proof is the next increment and will change the detector version.',
        ]),
      ] },
      { id: 'privacy', heading: 'What is public', blocks: [
        p('Six hashes and a slot number. No prompt, no tool arguments, no policy contents or thresholds, no model scores, and nothing that names the agent or the operator. The explorer shows counts and policy roots only.'),
      ] },
      { id: 'upgradeable', heading: 'Who can update the programs?', blocks: [
        p('The verifier and example payment gate can currently be updated by a single project key. Requiring multiple approvals and a waiting period for updates is planned.'),
        p('Both on-chain programs — the verifier `6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx` and the transfer-gate example `9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa` — keep an upgrade authority, held today by a single key. Whoever holds it can change what the verifier accepts; the integrity of past consumptions is unaffected, but a verifier you trust is a verifier whose authority you trust. Upgrades are announced in the [changelog](/changelog), and `solana-verify` lets you check that the deployed bytes match the public source.'),
      ] },
    ],
  },
  {
    slug: 'source', path: '/docs/source', group: 'From source', title: 'From source',
    summary: 'Everything on the [Quickstart](/docs) comes from npm. This page is for working from the repository instead: running the proxy and dashboard from a clone, building the Solana programs and the prover, and reproducing the deployed program bytes. Node 20+ and pnpm for the TypeScript side; Rust, Solana and Anchor toolchains only for the parts that say so.',
    sections: [
      { id: 'clone', heading: 'Clone and run', blocks: [
        code(`$ git clone https://github.com/blindseal-dev/blindseal && cd blindseal
$ ./scripts/quickstart.sh          # pnpm install, build the dashboard, verify the sample attestation (real Groth16) and reject a tampered copy
$ BLINDSEAL_MOCK=1 pnpm -C packages/proxy exec tsx src/index.ts run --mock
blindseal (MOCK): local API on http://127.0.0.1:7777
  dashboard: http://127.0.0.1:7777/#token=…`, 'shell'),
        p('`scripts/quickstart.sh` needs only Node and pnpm: the wasm verifier and the program IDLs are committed, so nothing is compiled. The last line runs the CLI from the checkout; every `blindseal …` command on the other pages is `pnpm -C packages/proxy exec tsx src/index.ts …` here.'),
      ] },
      { id: 'programs', heading: 'Build the programs', blocks: [
        code(`$ scripts/build-programs.sh        # cargo build-sbf for blindseal-verify and transfer-gate + anchor idl build
$ scripts/test-m2.sh               # the on-chain suite against a local validator`, 'shell'),
        p('Requires Rust, the Solana CLI and Anchor. The script builds to SBF with `cargo build-sbf` (target dir outside `programs/`) and writes the `.so` files to `target/deploy/` and the IDLs to `target/idl/`. Program ids are fixed: the verifier `6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx`, the transfer-gate example `9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa`.'),
      ] },
      { id: 'prover', heading: 'Build the prover', blocks: [
        code(`$ cargo build --release -p blindseal-prover
$ blindseal attest call.json --target-program 9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa \\
    --out attestation.json --prover target/release/blindseal-prover`, 'shell'),
        p('The prover wraps the committed SP1 guest (`crates/guest`) and produces the Groth16 attestation. It needs the SP1 toolchain and, for the Groth16 wrap, Docker with about 24 GB of memory available. Proving takes hours on CPU — 2 h 16 min for the sample attestation on an Apple M1 Max (32 GB). Without `--prover`, `blindseal attest` uses the release binary it downloads on first use; the built binary is the same program.'),
      ] },
      { id: 'reproduce', heading: 'Reproduce the deployed programs', blocks: [
        code(`$ cd programs
$ solana-verify build -b solanafoundation/solana-verifiable-build:4.3.0 --library-name blindseal_verify
$ solana-verify build -b solanafoundation/solana-verifiable-build:4.3.0 --library-name transfer_gate
$ solana-verify get-program-hash 6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx     # compare with the executable hash printed above`, 'shell'),
        p('`solana-verify` builds in a pinned container so the bytes are reproducible, then compares the executable hash with what is deployed on mainnet. Both programs keep an upgrade authority; see [What is proven](/docs/scope) for what that means for trust.'),
      ] },
      { id: 'layout', heading: 'Repository layout', blocks: [
        list([
          '`packages/proxy` — the MCP proxy and CLI, published as `blindseal`.',
          '`packages/sdk` — the verify instruction, submit, off-chain verify; published as `blindseal-sdk`.',
          '`packages/verifier-wasm` — the Groth16 verifier compiled to WebAssembly; published as `blindseal-verifier-wasm`.',
          '`crates/` — the detector core (DFA rules), the SP1 guest, the prover and the verifier crate.',
          '`programs/` — the Anchor programs `blindseal-verify` and `transfer-gate`.',
          '`apps/site` — this site; `packages/dashboard` — the local dashboard the proxy serves.',
        ]),
      ] },
    ],
  },
];

export const PAGES: DocPage[] = PAGE_LIST.map((pg, i) => ({
  ...pg, prev: i > 0 ? PAGE_LIST[i - 1].slug : undefined, next: i < PAGE_LIST.length - 1 ? PAGE_LIST[i + 1].slug : undefined,
}));
export const BY_SLUG: Record<string, DocPage> = Object.fromEntries(PAGES.map((pg) => [pg.slug, pg]));

// ── the tree (page.js: a group whose only page shares its name is a loose row under Guides / Reference;
//    the fixture convention: such a page's group IS its title) ──
const REFERENCE = new Set(['hashing', 'scope']);
const rawTree: { group: string; items: DocPage[] }[] = [];
PAGES.forEach((pg) => {
  let g = rawTree.find((x) => x.group === pg.group);
  if (!g) { g = { group: pg.group, items: [] }; rawTree.push(g); }
  g.items.push(pg);
});
// what the sidebar search matches: the title, the headings and the prose (not the code)
function searchText(pg: DocPage): string {
  const prose = pg.sections.flatMap((s) => s.blocks.flatMap((b) => b.kind === 'p' ? [b.text] : b.kind === 'list' ? b.items : b.kind === 'callout' ? [b.title, b.body] : []));
  return [pg.title, pg.nav ?? '', pg.summary, ...pg.sections.map((s) => s.heading), ...prose].join(' ').replace(/[`*]/g, '').toLowerCase();
}
export const TREE: TreeGroup[] = [];
export const BUCKET_OF: Record<string, string> = {};
rawTree.forEach((g) => {
  const loose = g.items.length === 1 && g.items[0].title === g.group;
  const name = loose ? (REFERENCE.has(g.items[0].slug) ? 'Reference' : 'Guides') : g.group;
  let b = TREE.find((x) => x.group === name);
  if (!b) { b = { group: name, items: [] }; TREE.push(b); }
  g.items.forEach((pg) => {
    b!.items.push({ slug: pg.slug, title: pg.nav ?? pg.title, path: pg.path, keywords: searchText(pg) });
    BUCKET_OF[pg.slug] = name;
  });
});

export function targetsOf(pg: DocPage): Target[] {
  return pg.sections.map((s) => ({ id: s.id, label: s.heading, level: 1 }));
}

