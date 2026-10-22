//! Blindseal M0.5 minimal guest: read a few bytes, commit sha256(bytes) + length.
//! This is the version-compatibility spike, not the real detector guest (that is M1, §3.4).
#![no_main]
sp1_zkvm::entrypoint!(main);

use sha2::{Digest, Sha256};

pub fn main() {
    let input = sp1_zkvm::io::read::<Vec<u8>>();
    let digest: [u8; 32] = Sha256::digest(&input).into();
    // public values: input length (u32) then the 32-byte digest
    sp1_zkvm::io::commit(&(input.len() as u32));
    sp1_zkvm::io::commit(&digest);
}
