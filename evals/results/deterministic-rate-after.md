# Deterministic (proven) layer catch rate

Layers: `runLayer0` (decode-then-L1) then `runLayer1`, as the guest runs them. Any non-clean
verdict, suspicious included, counts as caught on an attack set and as flagged on a clean set.

| dataset | samples | caught | catch rate |
|---|---:|---:|---:|
| red-team scoreboard (attacks) | 31 | 29 | 93.5 % |
| red-team self bypass attempts | 38 | 32 | 84.2 % |
| corpus/injection-patterns | 200 | 152 | 76.0 % |
| holdout-attacks-burned-v1 (design) | 188 | 127 | 67.6 % |
| holdout-v2-novel (held out) | 50 | 1 | 2.0 % |
| holdout-v2-paraphrase (held out) | 30 | 9 | 30.0 % |
| **true holdout (v2 novel + paraphrase)** | 80 | 10 | **12.5 %** |

| clean dataset | samples | flagged | false-positive rate |
|---|---:|---:|---:|
| benign | 110 | 0 | 0.0 % |
| benign-v2 | 100 | 1 | 1.0 % |
| red-team scoreboard (clean) | 32 | 0 | 0.0 % |
| **benign + benign-v2** | 210 | 1 | **0.5 %** |

## Per-pattern hits (samples, all datasets, L0 and L1 combined)

| pattern | samples |
|---|---:|
| safety-restrictions-removed | 66 |
| unrestricted-persona | 47 |
| ai-addressed-note | 37 |
| instruction-prefix:ignore-previous | 36 |
| prompt-exfiltration | 35 |
| decode-and-execute | 32 |
| bracket-ai-directive | 24 |
| concealment-directive | 22 |
| persona-adoption | 21 |
| authority-claim | 18 |
| instruction-prefix:new-instructions | 17 |
| exfil-to-destination | 15 |
| reply-format-hijack | 15 |
| ai-directive-field | 14 |
| from-now-on-directive | 13 |
| instruction-prefix:you-are-now | 13 |
| sleeper-trigger-setup | 13 |
| instruction-prefix:override-above | 12 |
| instruction-prefix:disregard-above | 11 |
| persistent-hidden-goal | 10 |
| treat-as-instructions | 10 |
| prompt-boundary-spoof | 9 |
| prior-instructions-voided | 8 |
| dual-output-jailbreak | 7 |
| memory-store-injection | 7 |
| tool-abuse-directive | 6 |
| large-base64-blob | 5 |
| unicode-tag-smuggling | 5 |
| zero-width-density | 5 |
| instruction-prefix:forget-previous | 4 |
| html-comment-injection | 3 |
| html-entity-encoded-run | 3 |
| instruction-prefix:system-prefix | 3 |
| task-reassignment-directive | 3 |
| bidi-override-smuggling | 2 |
| markdown-link-prompt-anchor | 2 |
| pipeline-authority-claim | 2 |
| dan-dual-label | 1 |

## Flagged clean samples

- benign-v2 / benign.json:bv2-a18: large-base64-blob "Google Cloud Pub/Sub message (retrieved via subscription pull):\n{\n  \"message\": {\n    \"data\": \"eyJvcmRlcl9pZCI6ICJPUkQtOT"
