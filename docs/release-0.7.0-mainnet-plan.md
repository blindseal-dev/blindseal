# Release 0.7.0: mainnet plan (read before signing)

Script: `scripts/mainnet-0.7.0.sh [--dry-run | --simulate] [--url <rpc>] <0|b|a|c1|c2|d>`, with helper
`scripts/lib/mainnet-admin-0.7.0.mts`. The order is **0 → b → a → c1 → (sign, then consume a new-vkey sample) →
c2 → optional d**.

All numbers below come from three sources:

- a read-only read of live mainnet at slot ≈ 462,360,300 (`getAccountInfo` and `simulateTransaction` only);
- a full rehearsal on a local `solana-test-validator` that clones mainnet;
- the verifiable build of this branch.

Nothing was sent to mainnet or devnet.

| | |
|---|---|
| Release branch HEAD | `15c772f` when the builds were made (last change under `programs/`: `84e52a6`, "0.7.0: guest binds the screened payload…"). `programs/` is clean. This commit only changes scripts and docs: `git diff 15c772f HEAD -- programs` is empty. So the hashes below hold for the HEAD that step 0 will print, and for any commit whose `programs/` tree matches. |
| Config PDA | `9je2jP8yLogrSbm6qxDFjjQXKKwk9A25KMqwXCqDb4M3` |
| Default PolicyRoot PDA | `9XfreXFvq3TyQywnbjjKPNRV8FDxegzEZPj4DtMLe3CC` (root `0x36a9e9…8397`) |
| Authority, fee payer and signer for every step | `88sR7XCxG3BGwxnPbMKnbjmcitpTBkMquMrwqGVa6bJj`, balance **3.197621665 SOL** |
| Old vkey | `0x006a0d1e62646623f1d2b9af7f3792c4d15aa7d6107bdb089a0760fd5b29331e` |
| New vkey (CURRENT_VKEY) | `0x00cdf40c21b14717fd783bdecb539b762094b3b0da75a567f4b6cc088e9f2967` |
| Mainnet rent | 5,080 lamports per byte, counting the 128-byte account overhead. This was read with `getMinimumBalanceForRentExemption`: 303 B → 2,189,480 and 49 B → 899,160. It is **not** the 6,960 that a local validator uses. |
| Fees | 5,000 lamports per signature. The script sets no priority fee. |

## Config BEFORE (live mainnet, decoded with the repo SDK)

```
Config 9je2jP… (303 bytes, 2,189,480 lamports; fixed size: max_len 8 vkeys, so c1/c2 change no rent)
  {"authority":"88sR7XCxG3BGwxnPbMKnbjmcitpTBkMquMrwqGVa6bJj",
   "allowedVkeys":["0x006a0d1e…331e"], "allowlistPolicies":false, "paused":false, "bump":255}
PolicyRoot[default] 9XfreX…  EXISTS: owner 6z4Heh…, root 0x36a9e9…8397, registered_at slot 461768200, 899,160 lamports
transfer-gate     9fjiag…  ProgramData 6cWCSq…  192,720 B  0.97989644 SOL  upgrade authority 88sR7X…  hash 51c4a28e…
blindseal-verify  6z4Heh…  ProgramData FEkyNt…  356,432 B  1.81155340 SOL  upgrade authority 88sR7X…  hash d69490a1…
Nullifier(attestation-mainnet-demo.json) HBtSaS…  consumed at slot 462212604 by transfer-gate
Nullifier(attestation-test.json)         2J3YJa…  not consumed
```

**Step b is already done on mainnet.** The default policy root was registered at slot 461,768,200, so step `b`
sends nothing (the script prints "already registered — nothing to send"). Its rent of 899,160 lamports was paid
then.

## 1. Every transaction, in order

### Step 0: program upgrades (transfer-gate first, then blindseal-verify)

These are built by `solanafoundation/solana-verifiable-build:4.3.0` from HEAD `15c772f`. The build was run twice
(a standalone build, and again inside the rehearsal's step 0) and produced the same hashes both times:

| program | binary | `solana-verify` executable hash | sha256 of .so | currently deployed |
|---|---|---|---|---|
| transfer_gate | 185,760 B (smaller than the 192,720 B ProgramData) | `a0d51e460d88919e137bd02d77a97d63def0e78c6bef1112df777c658107fb86` | `512b6e8c…4e391d` | `51c4a28e…` |
| blindseal_verify | 360,360 B (+3,928) | `5a1f0e90dd3e910ea04db2de02cff5cc7cac2de29db6925b9a6e1250ce078bed` | `f1b62b69…1a2274` | `d69490a1…` |

For each program, `solana program deploy` (CLI 4.3.1) sends the transactions below. The counts and instruction
mix were measured on the clone by decoding every transaction the authority signed.

1. **Create buffer** (2 signatures, fee 10,000 lamports). The signers are the authority `88sR7X…` (fee payer) and
   an ephemeral buffer keypair. Instructions:
   - System `CreateAccount`:
     - from: `88sR7X…` (signer, writable);
     - new: buffer (signer, writable);
     - owner: BPFLoaderUpgradeable;
     - space: binary + 37 bytes.
   - Loader `InitializeBuffer`:
     - buffer (writable);
     - authority `88sR7X…`.
   - **Verifier only**, in this same transaction: Loader `ExtendProgram` (10,240 bytes):
     - ProgramData (writable);
     - program (writable);
     - System program;
     - payer `88sR7X…` (signer, writable).
     - The CLI extends by max(growth, 10,240). The verifier grows by only 3,928 bytes, so it is extended by
       10,240, giving ProgramData 366,672 B (observed on the clone).
2. **N × Write** (1 signature each, 5,000 lamports each). Accounts: buffer (writable), authority `88sR7X…`
   (signer). Each carries up to 1,012 bytes of the binary.
3. **Upgrade** (1 signature, 5,000 lamports). Accounts:
   - ProgramData (writable);
   - program (writable);
   - buffer (writable);
   - spill = `88sR7X…` (writable);
   - Rent sysvar;
   - Clock sysvar;
   - upgrade authority `88sR7X…` (signer).

   The Upgrade instruction itself empties and closes the buffer, so **there is no separate "buffer close"
   transaction**. All of the buffer's lamports are refunded to `88sR7X…`.

| | transfer-gate | blindseal-verify |
|---|---|---|
| Transactions | 1 + **184 writes** + 1 = **186** | 1 (with extend) + **357 writes** + 1 = **359** |
| Buffer rent, held during the deploy and refunded by Upgrade | 0.944499000 SOL | 1.831467000 SOL |
| ProgramData growth rent (kept) | 0 | 0.052019200 SOL (10,240 B × 5,080) |
| Fees | 0.000935000 SOL | 0.001800000 SOL |
| **Net cost** | **0.000935 SOL** | **0.053819 SOL** |

**Step 0 in total:** 545 transactions and a net cost of **≈ 0.054754 SOL**.

- The lowest balance during the deploy will be about 3.1976 − 0.0027 − 1.8315 − 0.0520 ≈ **1.31 SOL**, while the
  verifier buffer is held.
- After step 0 the balance will be ≈ **3.1429 SOL**.
- The script now refuses to start unless the balance is at least the largest buffer plus growth plus fees plus
  0.02 SOL (**1.906 SOL**).

**If a deploy stops part-way** (for example, dropped writes), the partly written buffer keeps its rent. Do not just
re-run, because a second buffer may not fit the balance. Instead, do one of these:

- **Resume:** recover the buffer key with `solana-keygen recover` from the 12-word phrase the CLI prints, then run
  `solana program deploy … --buffer <file>`.
- **Reclaim:** run `solana program close <buffer>`. The CLI prints this command.

**Stopping between the two upgrades is safe.** The first clone rehearsal (see section 2) aborted after the gate
upgrade, which left the new gate in front of the old verifier. The demo sample still failed cleanly there with
`NullifierAlreadyConsumed` (6006). Each upgrade has its own typed confirmation.

A **mainnet simulation of step 0 is not meaningful.** `Upgrade` needs a buffer already written on chain, and
writing a buffer is a send that costs the buffer rent. `--simulate 0` therefore prints the cost plan above, taken
live from mainnet. The clone run below is the rehearsal.

### Step b: `register_policy_root(0x36a9e9…)`. Nothing to send (already registered).

If it were needed, the transaction would be:

- program `6z4Heh…`;
- accounts:
  - Config (read-only);
  - PolicyRoot PDA `9XfreX…` (writable, created);
  - `88sR7X…` (signer, writable, payer);
  - System program;
- rent 899,160 lamports, fee 5,000.

### Step a: `set_config(allowed_vkeys=None, allowlist_policies=Some(true), paused=None)`

| | |
|---|---|
| Program | `6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx` |
| Instructions | ComputeBudget `SetComputeUnitLimit(50,000)`, then the instruction below |
| Accounts | Config `9je2jP…` (writable); `88sR7X…` (signer, read-only) |
| Data | `6c9e9aafd4623442 00 01 01 00` |
| Signer and fee payer | `88sR7X…` |
| Fee | 5,000 lamports |
| Rent | none |
| Config change | `allowlistPolicies` false → **true** |

### Step c1: `set_config(allowed_vkeys=Some([old, new]))`

| | |
|---|---|
| Program and accounts | Same as step a |
| Data | `6c9e9aafd4623442 01 02000000 <old vkey> <new vkey> 00 00` |
| Fee | 5,000 lamports |
| Rent | none (Config is fixed-size) |
| Config change | `allowedVkeys` [old] → **[old, new]** |

### Step c2 (later): `set_config(allowed_vkeys=Some([new]))`

| | |
|---|---|
| Program and accounts | Same as step a |
| Data | `6c9e9aafd4623442 01 01000000 <new vkey> 00 00` |
| Fee | 5,000 lamports |
| Config change | `allowedVkeys` [old, new] → **[new]** |
| Preconditions (the script checks both) | Prover manifest ≥ 0.7.0 (it is **0.5.1** today); `--new-sample` names a new-vkey attestation already consumed on mainnet |

### Step d (optional): `set_authority(<Ledger pubkey>)`

| | |
|---|---|
| Program | `6z4Heh…` |
| Accounts | Config (writable); `88sR7X…` (signer); the Ledger key (signer). Both keys must sign. |
| Data | `85fa25156ea31a79 <new authority, 32 bytes>` |
| Fee | 10,000 lamports (2 signatures) |
| Config change | `authority` 88sR7X… → the Ledger |
| Note | `set_authority` exists **only after step 0**. Against today's mainnet binary it fails with `InstructionFallbackNotFound` (101); see the simulation below. |
| Order | **Run d last, after c2.** Once d lands, `set_config` needs the Ledger's signature, and this script only signs `set_config` with a keypair file. The script now refuses d while the old vkey is still allowed (on mainnet; on a simulation or a local rehearsal it reports this instead). |

### Totals, and whether the script's order matches the owner's

**Total cost, all steps:**

- step 0: ≈ 0.054754 SOL;
- steps a + c1 + c2: 15,000 lamports;
- step d: 10,000 lamports;
- **≈ 0.054779 SOL** in all.

The peak amount temporarily held is 1.88 SOL, during the verifier deploy.

**Order and gates:**

- The script's order already matched the plan (0 → b → a → c1 → c2 → d). No reordering was needed.
- Gate changes:
  - `a` refuses unless the default root is registered (unchanged);
  - **new: `c1` refuses unless `a` is done** (`allowlist_policies` true), so the order is enforced;
  - `c2` refuses unless `c1` is done and both of its preconditions hold (unchanged).
- Combining `a` and `c1` in one `set_config` would be safe on-chain: the root is registered, and c1 only adds a key.
  They are kept as two steps with two typed confirmations because combining them gains nothing.

### Questions checked

**Does an old-vkey proof still verify after `a` (allowlist on)? Yes.**
- Both existing mainnet samples (`attestation-mainnet.json` and `attestation-mainnet-demo.json`) and
  `attestation-test.json` commit the policy root `0x36a9e9457db6ecfd752a379fc9279ad6a0acfea07928f61e2f3638a685c38397`.
  That is the default root, and it is registered.
- The old vkey stays allowed until c2.
- The new transfer-gate's own check (`EXPECTED_POLICY_ROOTS = [default]`) also passes.
- Shown on the clone below with a full, successful consume.

**After c2, which error rejects an old-vkey proof? `DisallowedVkey`**, Anchor error **6001 (0x1771)**, "detectorVersion
is not an allowed vkey".
- This is the verifier's check 4.
- Checks 1–3 (CPI depth, caller == target program, not paused) run before it.
- Checks 5–9 (policy root, expiry, action hash, nullifier, Groth16) run after it.
- So a stale, consumed or otherwise invalid old-vkey proof gets the same error.
- Seen on the clone with both samples.

## 2. Clone rehearsal (local `solana-test-validator`, trimmed transcript)

**Validator setup:**

```
solana-test-validator --url <mainnet> --clone-feature-set \
  --clone-upgradeable-program 9fjiag… --clone-upgradeable-program 6z4Heh… \
  --clone 9je2jP… (Config)  --clone 9XfreX… (PolicyRoot)  --clone HBtSaS… --clone 7H4wZQ… (nullifiers)  --clone 88sR7X…
```

The cloned programs kept upgrade authority `88sR7X…`, so every local transaction was signed with the real
authority key, locally only. The whole script ran with typed confirmations piped in:

```
scripts/mainnet-0.7.0.sh --url http://127.0.0.1:18899 <step>
```

Three differences from mainnet affect the results:

- **Rent is higher.** The test validator charges the default rent (6,960 lamports per byte, not mainnet's 5,080).
  So the cloned ProgramData accounts get topped up on upgrade, and buffers cost about 37% more.
  - The first rehearsal stopped at the verifier deploy with "account does not have enough SOL". The script
    correctly aborted and printed the buffer close command.
  - The second rehearsal airdropped +1 SOL to the authority **locally**.
  - The transaction counts and instruction mix are independent of rent. The SOL figures in section 1 use mainnet
    rent.
- **The clone starts near slot 0.** So the demo sample (expirySlot 462,259,397) is not expired there and reaches the
  nullifier check. On mainnet today (slot ≈ 462.36 M) it would stop earlier, at `Expired` (6003).
- **`attestation-test.json` is the real "accepted" evidence.** It is an old-vkey proof with the default root, expiry
  slot 2e9, and is unconsumed on mainnet. It is signed by the seed-derived test wallet `Zv5PpL…`, the same derivation
  as `tests/m2.spec.ts`.

```
######## state BEFORE  (= mainnet)
Config {"authority":"88sR7X…","allowedVkeys":["0x006a0d1e…331e"],"allowlistPolicies":false,"paused":false,"bump":255}
PolicyRoot[default] exists root 0x36a9e9…8397 registered_at 461768200
Nullifier[attestation-mainnet-demo.json] consumed {"consumedAtSlot":"462212604","consumerProgram":"9fjiag…"}
Nullifier[attestation-test.json] not consumed

######## STEP 0
   commit 15c772f96d513f1d6f644dd8b7b2b964ab009f9a (last change under programs/: 84e52a6)
   local executable hash transfer_gate: a0d51e460d88919e137bd02d77a97d63def0e78c6bef1112df777c658107fb86
   local executable hash blindseal_verify: 5a1f0e90dd3e910ea04db2de02cff5cc7cac2de29db6925b9a6e1250ce078bed
→ upgrade transfer_gate (9fjiag…), deployed hash now: 51c4a28e…
   $ solana program deploy programs/target/deploy/transfer_gate.so --program-id 9fjiag… --upgrade-authority ~/.blindseal/mainnet-authority.json -k ~/.blindseal/mainnet-authority.json --url <rpc> --commitment confirmed
Signature: 2wWp92c2…
   deployed hash a0d51e460d88919e137bd02d77a97d63def0e78c6bef1112df777c658107fb86
→ upgrade blindseal_verify (6z4Heh…), deployed hash now: d69490a1…
Signature: 3WTRp5d9…
   deployed hash 5a1f0e90dd3e910ea04db2de02cff5cc7cac2de29db6925b9a6e1250ce078bed
######## step 0 transactions (decoded from the authority's signatures)
  1 × system.CreateAccount+loader.InitializeBuffer                                    (gate)
  1 × system.CreateAccount+loader.InitializeBuffer+loader.ExtendProgram(10240 bytes)  (verifier)
  541 × loader.Write  (184 gate + 357 verifier; max 1012 bytes each)
  2 × loader.Upgrade
  (+1 local airdrop transfer)
blindseal-verify Data Length 356432 → 366672; no buffers left (`solana program show --buffers` empty)

######## after 0, before a: old-vkey demo sample (consumed on mainnet)
RESULT FAILED {"InstructionError":[1,{"Custom":6006}]}   NullifierAlreadyConsumed

######## STEP b
b: default policy root 0x36a9e9…8397 already registered (9XfreX…) — nothing to send
######## STEP a
SIGNATURE a 3sMYrR5G…   (CU on mainnet simulation: 3,346)
Config after: {…,"allowedVkeys":["0x006a0d1e…"],"allowlistPolicies":true,…}
######## STEP c1
Config after: {…,"allowedVkeys":["0x006a0d1e…331e","0x00cdf40c…2967"],"allowlistPolicies":true,…}

######## after a+c1: old-vkey demo sample
RESULT FAILED {"InstructionError":[1,{"Custom":6006}]} CU 19435
  AnchorError … Error Code: NullifierAlreadyConsumed. Error Number: 6006
  → passed check 4 (vkey allowed) and check 5 (PolicyRoot registered) with allowlist ON; stopped only at the nullifier
######## after a+c1: old-vkey UNCONSUMED fixture (attestation-test.json)
RESULT OK (consumed + transferred) CU 269091
  → an old-vkey proof with the default root is fully ACCEPTED by the 0.7.0 binaries (Groth16 included)

######## STEP c2   (local: preconditions reported, not enforced)
   PRECONDITION NOT MET (a real mainnet send would refuse here): prover manifest is 0.5.1 …
   PRECONDITION NOT MET (a real mainnet send would refuse here): pass --new-sample …
Config after: {…,"allowedVkeys":["0x00cdf40c…2967"],"allowlistPolicies":true,…}
######## after c2: old-vkey demo sample
RESULT FAILED {"InstructionError":[1,{"Custom":6001}]} CU 13922     DisallowedVkey
######## after c2: old-vkey attestation-test.json
RESULT FAILED {"InstructionError":[1,{"Custom":6001}]} CU 13922     DisallowedVkey

######## STEP d (throwaway key CErczS… stands in for the Ledger; --new-authority-keypair, local only)
step d: transaction (fee payer 88sR7X…, fee 10000 lamports)
  account 0 9je2jP… writable / account 1 88sR7X… signer / account 2 CErczS… signer
SIGNATURE d FY3boTXe…
Config after: {"authority":"CErczS6mNKB6o8F9tRmRJJKNM9xAJWBDGatpshgpX2fE","allowedVkeys":["0x00cdf40c…2967"],"allowlistPolicies":true,"paused":false,"bump":255}
######## after d: old authority runs a step
mainnet-admin-0.7.0 failed: config authority is CErczS…, not 88sR7X…
######## admin txs after step 0: 3 × set_config + 1 × set_authority, total 25,000 lamports

######## guard: `--dry-run d --new-authority-keypair …` pointed at mainnet
mainnet-admin-0.7.0 failed: d: --new-authority-keypair is for a local rehearsal only; on mainnet the new authority is the Ledger (--ledger-pubkey)
```

**Baseline:** the same unconsumed fixture consumed through the *old* binaries in 267,344 CU, compared with 269,091
on 0.7.0.

## 3. Mainnet simulations (`--simulate`, current live state, unsigned, `sigVerify:false`, `replaceRecentBlockhash:true`)

`--simulate` builds an **unsigned** transaction (a signed one is never handed to the RPC) and asks for the
post-state of the Config account. A step whose prerequisites have not landed yet gets their instructions prepended,
marked "projected", so it runs against the state it will actually meet. These simulations ran against today's
(pre-0.7.0) verifier binary. The clone ran the same steps on the 0.7.0 binary: a = 3,344 CU there.

| step | instructions simulated | result | CU (whole transaction) | Config after (simulated) |
|---|---|---|---|---|
| b | none | nothing to send (root registered at 461,768,200) | n/a | unchanged |
| a | set_config(allowlist=true) | **OK** | 3,346 (program 3,196) | allowlist **true**, vkeys [old] |
| c1 | a (projected) + c1 | **OK** | 6,754 (c1 alone: 3,408) | allowlist true, vkeys **[old, new]** |
| c2 | a + c1 (projected) + c2 | **OK** | 10,119 (c2 alone: 3,365) | allowlist true, vkeys **[new]** |
| d | set_authority(placeholder key) | **FAILS 101 `InstructionFallbackNotFound`** | 2,321 | n/a: `set_authority` arrives with step 0 |
| 0 | n/a | cost plan only (see section 1) | n/a | n/a |

For c2, the simulation also reported both preconditions as unmet: prover manifest 0.5.1, and no `--new-sample`.
A real send refuses on either.

Logs (a; c1 and c2 add one identical `SetConfig` block per instruction):

```
| Program ComputeBudget111111111111111111111111111111 invoke [1]
| Program ComputeBudget111111111111111111111111111111 success
| Program 6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx invoke [1]
| Program log: Instruction: SetConfig
| Program 6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx consumed 3196 of 49850 compute units
| Program 6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx success
```

d, against today's binary:

```
| Program log: AnchorError occurred. Error Code: InstructionFallbackNotFound. Error Number: 101. Error Message: Fallback functions are not supported.
| Program 6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx failed: custom program error: 0x65
```

Step 0's cost plan, live from mainnet (`--simulate 0`):

```
transfer_gate: ProgramData holds 192720 bytes, new binary 185760 bytes (grows 0 → extended by 0); txs: 1 create buffer + 184 writes + 1 upgrade = 186
   buffer rent held during the deploy 0.944499000 SOL (refunded by the upgrade); ProgramData growth rent 0.000000000 SOL (kept); fees 0.000935000 SOL
blindseal_verify: ProgramData holds 356432 bytes, new binary 360360 bytes (grows 3928 → extended by 10240); txs: 1 create buffer + extend + 357 writes + 1 upgrade = 359
   buffer rent held during the deploy 1.831467000 SOL (refunded by the upgrade); ProgramData growth rent 0.052019200 SOL (kept); fees 0.001800000 SOL
payer 88sR7X… balance 3.197621665 SOL; needs ≥ 1.906221200 SOL (largest buffer + growth + fees + 0.02 margin)
```

Re-run these right before signing:

```
BLINDSEAL_RPC_URL=<mainnet rpc> scripts/mainnet-0.7.0.sh --simulate a      # then c1, and later c2 / d
scripts/mainnet-0.7.0.sh --simulate d --ledger-pubkey <ledger pubkey>     # after step 0
```

## 4. Script changes in this commit

- **`--simulate`**: builds each step's transaction unsigned and simulates it. It prints the logs, CU, the result, and
  the Config the transaction would leave, and sends nothing. Prerequisites that have not landed are prepended and
  marked "projected". `--simulate 0` prints the live cost plan.
- **`--url <rpc>`**: accepts only mainnet-beta, or a **local** validator (host 127.0.0.1 or localhost, and a genesis
  that is not mainnet, devnet or testnet). Anything else is refused. The two local-only relaxations depend on that
  check and never on a flag:
  - c2's preconditions are reported but not enforced;
  - `d --new-authority-keypair <file>` uses a throwaway key in place of the Ledger.
- **Gates:**
  - `c1` refuses unless `a` is done;
  - `d` refuses while the old vkey is still allowed, so it must come after c2.
- **Step 0:**
  - prints the per-program transaction count, buffer rent, growth rent and fees, using rent from the cluster;
  - refuses to start below the required balance;
  - documents how to resume or close a stray buffer.
  - The old comment ("verifier ≈ +6 KB, gate ≈ +1.5 KB") was wrong and is removed: the gate shrinks, and the verifier
    grows by 3,928 B but is extended by 10,240 B.
- **No RPC URL in output:** the preflight prints the cluster name, and echoed commands show `<rpc>`.
- **Real sends unchanged:** each step still needs its typed confirmation.
