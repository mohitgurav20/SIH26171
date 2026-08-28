# 82 — Final model and quantization lock

Phase 82's done-condition is that this is **decided and not revisited**.
The values below are the ones in `voicc_host/config.py`; changing a model
means changing that file and re-running the harness, not editing this doc.

## Locked

| Role | Model | Quantization | Rationale |
|---|---|---|---|
| draft | `qwen2.5:0.5b-instruct` | q4_K_M | speed is its only job; q4 costs nothing that matters for a first-pass proposal that gets validated anyway |
| text | `qwen2.5:3b-instruct` | q4_K_M | best structured-output adherence in the size class |
| vision | `qwen2-vl:2b-instruct` | q4_K_M | reads numbered overlays reliably on cropped patches |
| embed | `nomic-embed-text` | default | batched input for Siddu's memory writes |

Sampling, locked for repeatability (phase 128) — a demo needs the same
command to produce the same plan:

| Setting | Value |
|---|---|
| draft temperature | 0.0 |
| text temperature | 0.1 |
| vision temperature | 0.1 |
| top_p | 0.9 |
| seed | 42 |
| keep_alive | 30m |

## Why q4_K_M everywhere

q4_K_M is the point where the size drop stops being free. Below it (q3, q2)
JSON adherence degrades noticeably in the 0.5–3B class — the model starts
emitting *almost* valid objects, which is the worst outcome because it
costs a full escalation each time. Above it (q5, q8) the accuracy gain does
not show up in selection tasks that are already constrained by a schema,
but the memory does show up in phase 161's ceiling.

Operator-level graph optimization (phase 103, Siddu) is the free win to
take instead: it is a speed gain with no accuracy tradeoff, unlike dropping
another quantization level.

## Verification before freeze

```bash
python bench/harness.py all --runs 20      # real Ollama, demo laptop
python bench/harness.py memory_ceiling     # phase 161
```

Freeze is valid when: no missing models, `headroom_ok` is true with all
three voice checkpoints loaded, and sampling shows `identical_fraction`
at 1.0 for the locked temperatures.
