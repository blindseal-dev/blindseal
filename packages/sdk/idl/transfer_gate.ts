/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/transfer_gate.json`.
 */
export type TransferGate = {
  "address": "ErAS5x2oUky3aCJPasSKNaf8USVE9of5vzHHCPWwSEVG",
  "metadata": {
    "name": "transferGate",
    "version": "0.0.0",
    "spec": "0.1.0"
  },
  "instructions": [
    {
      "name": "gatedTransfer",
      "discriminator": [
        152,
        24,
        148,
        100,
        101,
        96,
        252,
        43
      ],
      "accounts": [
        {
          "name": "source",
          "docs": [
            "The authority the transfer debits — also pays for the Nullifier PDA."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "recipient",
          "writable": true
        },
        {
          "name": "config"
        },
        {
          "name": "policyRoot",
          "optional": true
        },
        {
          "name": "nullifier",
          "writable": true
        },
        {
          "name": "verifyProgram",
          "docs": [
            "Typed: a direct call that passes any other program here fails before the transfer."
          ],
          "address": "merZNYKpKwwX4CGgzvma3jPvLfrMTkZcb1cSXUKANcb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "proof",
          "type": "bytes"
        },
        {
          "name": "publicInputs",
          "type": "bytes"
        },
        {
          "name": "nonce",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    }
  ]
};
