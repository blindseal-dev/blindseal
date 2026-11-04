# Catch rate of the proven layers, as the proof sees it (release 0.8.0)

Each sample is the `memo` of the mainnet sample transfer call, serialized as `blindseal attest` serializes it,
and screened the way the 0.8.0 guest asserts it: L1 and L0 on the raw payload and on every JSON string leaf.
Caught = the screen is not clean (suspicious included), so no proof can be made. L2/L3 are not counted.

| attack set | samples | caught | catch rate |
|---|---:|---:|---:|
| **true holdout** (holdout-v2 novel + paraphrase) | 80 | 2 | 2.5 % |
| — novel | 50 | 0 | 0.0 % |
| — paraphrase | 30 | 2 | 6.7 % |
| **red-team set** (scoreboard attacks) | 31 | 9 | 29.0 % |

| clean set | samples | flagged | false-positive rate |
|---|---:|---:|---:|
| **benign + benign-v2** | 210 | 1 | 0.5 % |
| scoreboard clean samples | 32 | 0 | 0.0 % |

## Reconciling the red-team number

The scoreboard (packages/eval/scoreboard.md) still shows 32.3 % (10 of 31) for L1. That table came with the
repository when it was created from its base project and was never regenerated here. Run on the same 31 samples:

| method | caught of 31 |
|---|---:|
| L1 alone on the raw sample text (the scoreboard's method, today's rules) | 9 |
| the proof's method above | 9 |

The rules in the first commit of this repository give the same 9 of 31 as today, so 29.0 % is the reproducible
figure and 32.3 % is withdrawn. Placing a sample inside a tool call does not change any result on these sets.
