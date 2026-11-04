// The "pending mainnet" marker for release 0.8.0: L0 (decode-then-L1) now runs inside the proof together
// with L1, but the new verifier key is not yet allowed on chain. Every sentence that states the new
// coverage carries this one badge (docs prose gets it through the {{pending}} token in inline.tsx; the kit's
// diagram labels and the claim text carry the words). Remove this component, the token, the
// `[data-pending-mainnet]` rule in kit/ui.css and the words "pending mainnet" in one commit once the owner
// has allowed the key.
export function PendingMainnet() {
  return <span className="chip outline pending-mainnet" data-pending-mainnet="" title="The 0.8.0 verifier key is not yet allowed on mainnet">pending mainnet</span>;
}
