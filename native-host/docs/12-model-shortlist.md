# 12 — Model shortlist and tool-calling reliability

Phase 12 is a joint task: Siddu and Mohit have the strongest laptops, so
all three of us pull and run the candidates; **Omkar owns writing up the
tool-calling reliability results**, which is this document.

Hardware-dependent cells are marked `PENDING` until they are filled from a
real run on the demo laptop. Nothing here is quoted in the pitch until then
— phase 99 requires every number to be ours.

## Candidates

| Role | Candidate | Size (q4_K_M) | Why it is on the list |
|---|---|---|---|
| draft | `qwen2.5:0.5b-instruct` | ~0.4 GB | fastest instruct model that still emits valid JSON |
| draft (alt) | `llama3.2:1b-instruct` | ~0.8 GB | better reasoning, roughly 2× the latency |
| text | `qwen2.5:3b-instruct` | ~1.9 GB | strongest JSON adherence in this class |
| text (alt) | `llama3.2:3b-instruct` | ~2.0 GB | better English prose, weaker structured output |
| vision | `qwen2-vl:2b-instruct` | ~1.5 GB | reads numbered overlays reliably at small crop sizes |
| vision (alt) | `moondream:1.8b` | ~1.7 GB | smaller and faster, weaker at dense numeric overlays |
| embed | `nomic-embed-text` | ~0.3 GB | batched input, feeds Siddu's memory layer |

## What "tool-calling reliability" means here

Local models in this class are unreliable at hosted function-calling APIs,
so the system does not use them. It uses **constrained structured output**:
a JSON Schema is passed to Ollama's `format` parameter, and every response
is then re-validated through `parse_model_output`. Reliability is measured
against that path, not against a function-calling API we do not use.

Four metrics, all produced by the harness:

1. **Schema-valid rate** — responses that parse and validate first time.
2. **Grounded rate** — of those, how many reference only tag ids that
   actually exist on the page. This is the anti-hallucination number.
3. **Coordinate leakage** — attempts to emit pixel coordinates instead of a
   tag id. Should be zero; `Action` has no coordinate fields, so any such
   attempt fails validation.
4. **Latency** — mean and p90 per call, warm.

## Results table

Fill with:

```bash
python bench/harness.py draft_latency --runs 20
python bench/harness.py sampling --runs 10
python bench/harness.py prompt_size          # exact, hardware-independent
```

| Model | Role | Schema-valid | Grounded | Coord leak | Mean ms | p90 ms |
|---|---|---|---|---|---|---|
| qwen2.5:0.5b | draft | PENDING | PENDING | PENDING | PENDING | PENDING |
| llama3.2:1b | draft | PENDING | PENDING | PENDING | PENDING | PENDING |
| qwen2.5:3b | text | PENDING | PENDING | PENDING | PENDING | PENDING |
| llama3.2:3b | text | PENDING | PENDING | PENDING | PENDING | PENDING |
| qwen2-vl:2b | vision | PENDING | PENDING | PENDING | PENDING | PENDING |
| moondream:1.8b | vision | PENDING | PENDING | PENDING | PENDING | PENDING |

Prompt-size figures (exact, already measurable):

```bash
python bench/harness.py prompt_size --scripted
```

## Voice checkpoints (phase 63)

| Language | Checkpoint | Note |
|---|---|---|
| Hindi | AI4Bharat IndicConformer (hi) | better than multilingual Whisper at this size |
| Kannada | AI4Bharat IndicConformer (kn) | the deciding case — multilingual Whisper's Kannada WER makes that demo moment unreliable |
| English | Whisper small.en | fast and accurate; no Indic tradeoff needed |

Three per-language checkpoints rather than one multilingual model. The cost
is needing a language decision up front, which the selector UI (phase 120)
and the auto-detector (phase 125) provide. The benefit is that the Kannada
moment works.
