# blindseal-verifier-wasm

The off-chain Groth16 attestation verifier (`crates/verifier-wasm`) compiled to WebAssembly and
wrapped with `wasm-bindgen` for the two verify pages (dashboard + site). It runs the **real**
SP1 v5 Groth16 check in the browser — `Groth16Verifier::verify(proof, publicInputs[0],
detectorVersion, GROTH16_VK)` — the same check the on-chain program does via `sp1-solana`.

## API
```js
import init, { verify_attestation_json } from 'blindseal-verifier-wasm';
await init(/* Vite: pass the ?url asset; Next: pass '/…/blindseal_verifier_bg.wasm' */);
const { ok, reason } = JSON.parse(verify_attestation_json(attestationJsonString));
```
`verify_attestation_json` returns a JSON string `{"ok":bool,"reason":string|null}`. It checks only
the proof against its committed public inputs and vkey — expiry / nullifier / policy-allowlist are
the consumer's or the on-chain program's job (the on-chain check order is documented in `programs/blindseal-verify/src/lib.rs`).

## Regenerating (`pkg/` is generated and committed)
```
./build.sh
```
Requires the `wasm32-unknown-unknown` rustup target and `wasm-bindgen-cli =0.2.129` (pinned to the
crate's `wasm-bindgen`). The script remaps `$HOME` out of embedded panic paths and fails if any
identity string lands in the binary. `pkg/` is committed so the frontend builds without a Rust
toolchain.
