/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/blindseal_verify.json`.
 */
export type BlindsealVerify = {
  "address": "6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx",
  "metadata": {
    "name": "blindsealVerify",
    "version": "0.0.0",
    "spec": "0.1.0"
  },
  "instructions": [
    {
      "name": "initialize",
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "allowedVkeys",
          "type": {
            "vec": {
              "array": [
                "u8",
                32
              ]
            }
          }
        },
        {
          "name": "allowlistPolicies",
          "type": "bool"
        }
      ]
    },
    {
      "name": "registerPolicyRoot",
      "docs": [
        "Authority only. Registers a policy root for allowlist mode."
      ],
      "discriminator": [
        46,
        99,
        175,
        61,
        198,
        253,
        254,
        41
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "policyRoot",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "arg",
                "path": "root"
              }
            ]
          }
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "root",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "setConfig",
      "docs": [
        "Authority only. Each field is optional so a single call can flip just `paused`."
      ],
      "discriminator": [
        108,
        158,
        154,
        175,
        212,
        98,
        52,
        66
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "allowedVkeys",
          "type": {
            "option": {
              "vec": {
                "array": [
                  "u8",
                  32
                ]
              }
            }
          }
        },
        {
          "name": "allowlistPolicies",
          "type": {
            "option": "bool"
          }
        },
        {
          "name": "paused",
          "type": {
            "option": "bool"
          }
        }
      ]
    },
    {
      "name": "verifyAndConsume",
      "discriminator": [
        170,
        228,
        198,
        39,
        122,
        93,
        127,
        194
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
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
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
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
          "name": "action",
          "type": {
            "defined": {
              "name": "actionArgs"
            }
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "policyRoot",
      "discriminator": [
        132,
        3,
        153,
        12,
        23,
        82,
        108,
        150
      ]
    }
  ],
  "events": [
    {
      "name": "consumed",
      "discriminator": [
        30,
        74,
        68,
        130,
        40,
        188,
        227,
        125
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "paused",
      "msg": "verifier is paused"
    },
    {
      "code": 6001,
      "name": "disallowedVkey",
      "msg": "detectorVersion is not an allowed vkey"
    },
    {
      "code": 6002,
      "name": "unregisteredPolicyRoot",
      "msg": "policy root is not registered (allowlist mode)"
    },
    {
      "code": 6003,
      "name": "expired",
      "msg": "attestation expired"
    },
    {
      "code": 6004,
      "name": "actionHashMismatch",
      "msg": "action does not match the screened action (actionHash mismatch)"
    },
    {
      "code": 6005,
      "name": "nullifierMismatch",
      "msg": "nullifier does not match actionHash"
    },
    {
      "code": 6006,
      "name": "nullifierAlreadyConsumed",
      "msg": "nullifier already consumed (replay)"
    },
    {
      "code": 6007,
      "name": "invalidProof",
      "msg": "Groth16 proof did not verify"
    },
    {
      "code": 6008,
      "name": "badPublicInputs",
      "msg": "public inputs must be 168 bytes"
    },
    {
      "code": 6009,
      "name": "tooManyVkeys",
      "msg": "too many vkeys"
    },
    {
      "code": 6010,
      "name": "unauthorized",
      "msg": "unauthorized"
    },
    {
      "code": 6011,
      "name": "directCallNotAllowed",
      "msg": "verify_and_consume must be called by CPI from the target program, not as a top-level instruction"
    },
    {
      "code": 6012,
      "name": "nestedCallNotAllowed",
      "msg": "verify_and_consume must be called by exactly one CPI level (the top-level target program)"
    },
    {
      "code": 6013,
      "name": "callerNotTargetProgram",
      "msg": "calling program is not the action's target program"
    }
  ],
  "types": [
    {
      "name": "actionArgs",
      "docs": [
        "The on-chain action the gated program is about to execute, plus the attestation's nonce.",
        "32-byte fields are zero when n/a; `mint` is zero for the native asset."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "chainId",
            "type": "u16"
          },
          {
            "name": "targetProgram",
            "type": "pubkey"
          },
          {
            "name": "sourceAuthority",
            "type": "pubkey"
          },
          {
            "name": "instruction",
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "recipient",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "nonce",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "allowedVkeys",
            "type": {
              "vec": {
                "array": [
                  "u8",
                  32
                ]
              }
            }
          },
          {
            "name": "allowlistPolicies",
            "type": "bool"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "consumed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "nullifier",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "actionHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "policyRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "consumer",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "policyRoot",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "root",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "registeredAt",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    }
  ]
};
