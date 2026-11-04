# GPU proving (cuda mode) and the hosted prover's Vast backend

Status 0.8.0: the code path exists and compiles (prover `--mode cuda`, `crates/prover/Dockerfile.cuda`, the
`linux-x64-cuda` release asset, `services/prover-host/src/backends/vast.ts`); it has not yet been run on a GPU. The
benchmark (the mainnet sample under the 0.7.0 and 0.8.0 guests on a rented RTX 4090, and a CPU timing on an x86 box)
is the first thing to do with a Vast.ai key; the steps below are what to run and what to record.

## What runs where

sp1-sdk 5.0.0's CUDA prover is a client: the zkVM executor, `setup` and the final Groth16 wrap run on the CPU, the
STARK proving (core, compress, shrink, wrap) runs in SP1's **Moongate** GPU prover server, reached over HTTP on port
3000. With the prover's lockfile (`sp1-cuda` 5.2.4) the server image is `public.ecr.aws/succinct-labs/sp1-gpu:8fd1ef7`
(env `SP1_GPU_IMAGE` overrides it): Ubuntu 22.04 + CUDA 12.5.1 runtime + `/usr/local/bin/moongate-server`. Left alone,
sp1-cuda starts that image itself with `docker run --gpus all -p 3000:3000`, which needs docker and the NVIDIA
container toolkit on the host. A rented GPU instance is usually itself a container without docker, so the prover also
takes `BLINDSEAL_MOONGATE_URL` and talks to a server that is already running; the Groth16 wrap, which otherwise runs in
the `sp1-gnark` docker image, is compiled in with the `native-gnark` feature (Go >= 1.22 at build time).

Driver: the image's CUDA 12.5 runtime needs an NVIDIA driver >= 535 (470 and 550 series are listed as compatible too).
The Groth16 circuit artifacts (~1 GB) download on first use into `~/.sp1/circuits/groth16/<version>`.

## On a Vast.ai box, by hand (what `vast.ts` automates)

```sh
export VAST_API_KEY="$(cat ~/.blindseal/gpu-box)"      # read into the environment only; never print it
vastai search offers 'gpu_name=RTX_4090 num_gpus=1 rentable=true rented=false cpu_ram>=32 disk_space>=100 reliability>=0.98 dph<=0.60' -o dph_total
vastai create instance <offer id> --image public.ecr.aws/succinct-labs/sp1-gpu:8fd1ef7 --disk 100 --ssh --direct \
  --onstart-cmd 'nohup moongate-server > /var/log/moongate.log 2>&1 &'
vastai show instances                                     # wait for actual_status running, note ssh_host / ssh_port
ssh -p <port> root@<host>
```

On the box (the image has bash and apt; ~15 min of build with the dependency download):

```sh
apt-get update -qq && apt-get install -y -qq git curl build-essential pkg-config libssl-dev clang cmake
curl -sSfL https://go.dev/dl/go1.22.12.linux-amd64.tar.gz | tar -C /usr/local -xz; export PATH=/usr/local/go/bin:$PATH
curl -sSf https://sh.rustup.rs | sh -s -- -y; . ~/.cargo/env
git clone https://github.com/blindseal-dev/blindseal && cd blindseal && git checkout <branch or tag>
cargo build --release --locked --manifest-path crates/prover/Cargo.toml --features cuda,native-gnark
nvidia-smi --query-gpu=name,driver_version --format=csv; nvcc --version 2>/dev/null | tail -1   # record them
export BLINDSEAL_MOONGATE_URL=http://127.0.0.1:3000
```

Inputs for the mainnet sample (the exact lines are in `scripts/check-prover-asset.sh`, step 3):

```sh
node -e "const c=require('./tests/fixtures/mainnet-toolcall-demo.json'); process.stdout.write(JSON.stringify({ tool: c.toolName, args: c.args }))" > payload.json
att() { node -e "const m=require('./tests/fixtures/attestation-mainnet-demo-0.7.0.json'); console.log(($1))"; }
P=crates/prover/target/release/blindseal-prover
BLINDSEAL_EXECUTE=1 $P --payload payload.json --out /dev/null --chain-id "$(att m.chainId)" \
  --target-program "$(att m.action.targetProgram)" --source-authority "$(att m.action.sourceAuthority)" \
  --recipient "$(att m.action.recipient)" --mint "$(att m.action.mint)" --amount "$(att m.action.amount)" \
  --instruction "$(att m.action.instruction)" --expiry "$(att m.expirySlot)" --nonce "$(att m.nonce)"   # CYCLES
time $P --mode cuda --payload payload.json --out attestation-gpu.json ...the same action flags...     # PROVE_MS
```

For the 0.7.0 guest, check out `main`'s ELF first (`git show main:crates/guest/elf/blindseal-guest > crates/guest/elf/blindseal-guest`)
and rebuild; for the 0.8.0 guest use the committed ELF. The public values of the 0.7.0 run must equal the sample
attestation's (payloadHash, policyRoot, detectorVersion, actionHash, nullifier, expirySlot); the 0.8.0 run changes
detectorVersion and so actionHash/nullifier. Verify each attestation with `blindseal verify <file>` (from source:
`pnpm -C packages/proxy build && node packages/proxy/dist/index.js verify <file>`) and record: wall-clock, CYCLES, GPU
model, driver and CUDA versions, the instance's USD/h and the total spend. Then `vastai destroy instance <id>` and
confirm with `vastai show instances` that nothing is left.

## The hosted prover's Vast backend

`services/prover-host/src/backends/vast.ts` does the same per job: cheapest offer under the caps, create from the
Moongate image with that onstart, wait for ssh, copy the cuda prover binary (`proverBinary`, the `linux-x64-cuda`
asset) and the payload in, run `--mode cuda` with `BLINDSEAL_PROVER_HOST=vast`, copy the attestation back, destroy.
The instance is destroyed on success, on error, on abort, when the `maxInstanceAgeMinutes` watchdog fires, and from
the process exit hooks. The API key is read from `apiKeyFile` into the child's `VAST_API_KEY` only.

## Known gaps

- Not yet run on a GPU: no numbers. The 0.8.0 release plan carries the benchmark as a follow-up.
- The `network` Cargo feature does not compile with the current prover lockfile (see `crates/prover/Cargo.toml`).
- `Dockerfile.cuda` is written for the box, not built on a laptop (amd64 emulation).
