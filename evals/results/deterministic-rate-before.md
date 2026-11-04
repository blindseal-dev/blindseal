# Deterministic (proven) layer catch rate

Layers: `runLayer0` (decode-then-L1) then `runLayer1`, as the guest runs them. Any non-clean
verdict, suspicious included, counts as caught on an attack set and as flagged on a clean set.

| dataset | samples | caught | catch rate |
|---|---:|---:|---:|
| red-team scoreboard (attacks) | 31 | 9 | 29.0 % |
| red-team self bypass attempts | 38 | 19 | 50.0 % |
| corpus/injection-patterns | 200 | 25 | 12.5 % |
| holdout-attacks-burned-v1 (design) | 188 | 19 | 10.1 % |
| holdout-v2-novel (held out) | 50 | 0 | 0.0 % |
| holdout-v2-paraphrase (held out) | 30 | 2 | 6.7 % |
| **true holdout (v2 novel + paraphrase)** | 80 | 2 | **2.5 %** |

| clean dataset | samples | flagged | false-positive rate |
|---|---:|---:|---:|
| benign | 110 | 0 | 0.0 % |
| benign-v2 | 100 | 1 | 1.0 % |
| red-team scoreboard (clean) | 32 | 0 | 0.0 % |
| **benign + benign-v2** | 210 | 1 | **0.5 %** |

## Per-pattern hits (samples, all datasets, L0 and L1 combined)

| pattern | samples |
|---|---:|
| instruction-prefix:ignore-previous | 20 |
| instruction-prefix:you-are-now | 13 |
| bracket-ai-directive | 6 |
| instruction-prefix:disregard-above | 5 |
| large-base64-blob | 5 |
| unicode-tag-smuggling | 5 |
| zero-width-density | 5 |
| html-comment-injection | 3 |
| html-entity-encoded-run | 3 |
| instruction-prefix:new-instructions | 3 |
| instruction-prefix:system-prefix | 3 |
| task-reassignment-directive | 3 |
| bidi-override-smuggling | 2 |
| markdown-link-prompt-anchor | 2 |
| memory-store-injection | 2 |
| pipeline-authority-claim | 2 |
| dan-dual-label | 1 |
| instruction-prefix:forget-previous | 1 |

## Flagged clean samples

- benign-v2 / benign.json:bv2-a18: large-base64-blob "Google Cloud Pub/Sub message (retrieved via subscription pull):\n{\n  \"message\": {\n    \"data\": \"eyJvcmRlcl9pZCI6ICJPUkQtOT"
