import { DocsNav } from '../nav';

export default function Integrate() {
  return (
    <section className="site-section s04 docs-shell">
      <DocsNav current="/docs/integrate" />
      <div className="docs-body">
        <h1 className="section-head__title">Gating a program on an attestation</h1>
        <p className="copy-text">A gated program executes an action only if a Blindseal attestation for <em>that exact action</em> verifies and is consumed in the same transaction. The one rule that makes this sound: the action fields you forward to the verifier must come from what <strong>your program</strong> is about to execute — your own id, your instruction discriminator, the signer you debit, the recipient, the mint, the amount — never from anything the agent hands you.</p>

        <section id="cpi"><h2 className="title-1">1. CPI verify_and_consume</h2>
          <p className="copy-text">Add <code>blindseal-verify</code> with the <code>cpi</code> feature and call it before the action. The example below is the shipped <code>transfer-gate</code> program, a native-SOL transfer.</p>
          <pre className="code">{`use blindseal_verify::{cpi::accounts::VerifyAndConsume, ActionArgs, program::BlindsealVerify};

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
system_program::transfer(/* source → recipient, amount */)?;`}</pre>
          <p className="copy-text">Type the verifier account as <code>Program&lt;&apos;info, BlindsealVerify&gt;</code> so a caller cannot substitute another program for the CPI.</p></section>

        <section id="checks"><h2 className="title-1">2. What the verifier checks, in order</h2>
          <ol className="copy-text" style={{ paddingLeft: '1.2em' }}>
            <li>not paused</li>
            <li><code>detectorVersion</code> is an allowed vkey</li>
            <li>if allowlist mode: the policy root is registered</li>
            <li><code>expirySlot ≥</code> the current slot</li>
            <li>the action hash recomputed from <em>your</em> fields (+ the committed values + the nonce) equals the public one — <code>ActionHashMismatch</code> otherwise</li>
            <li>the nullifier matches and has not been consumed — <code>NullifierAlreadyConsumed</code> on replay</li>
            <li>the Groth16 proof verifies (sp1-solana)</li>
            <li>the Nullifier PDA is created (payer = your signer) and <code>Consumed</code> is emitted</li>
          </ol>
          <p className="copy-text">Each step fails with its own error code. The five wrong-field cases all surface as <code>ActionHashMismatch</code>: the proof binds one hash over all of them, so the program cannot name which field diverged.</p></section>

        <section id="client"><h2 className="title-1">3. Client side</h2>
          <pre className="code">{`import { buildVerifyIx, actionArgsFrom, submit } from '@blindseal/sdk';

// compose into your own transaction (gated program)…
const ix = buildVerifyIx(attestation, actionArgsFrom(attestation), { payer: wallet.publicKey });

// …or submit directly (no gated program): verifies on chain and consumes the nullifier
const sig = await submit(attestation, { wallet });   // refuses any RPC that is not mainnet-beta`}</pre>
          <p className="copy-text">Budget about 230k compute units for the verify step plus your own logic; set the limit explicitly with a ComputeBudget instruction (the default 200k is not enough). Measured figures live in <code>docs/performance.md</code>.</p></section>

        <section id="accounts"><h2 className="title-1">4. Accounts</h2>
          <pre className="code">{`config      PDA(["config"])                      read
policy_root PDA(["policy", policyRoot])          read, optional (pass the program id for None)
nullifier   PDA(["nullifier", nullifier])        writable, must not exist
payer       signer, writable                     pays the Nullifier PDA rent
program     merZNYKpKwwX4CGgzvma3jPvLfrMTkZcb1cSXUKANcb`}</pre></section>
      </div>
    </section>
  );
}
