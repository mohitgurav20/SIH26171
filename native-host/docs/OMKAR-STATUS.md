# Omkar — phase status

All 40 phases assigned to Omkar across Days 0–5, the speed layer, the
stretch list, verification and the final checks.

**Legend** — `built`: code is written and tested offline. `needs run`: code
and harness are complete, but the done-condition is a measurement on the
demo laptop with Ollama and models installed, so it cannot be closed here.
`needs assets`: complete except for model checkpoints that must be
downloaded. `needs people`: a live rehearsal.

## Day 0

| # | Phase | Status | Where |
|---|---|---|---|
| 11 | Native-messaging registration research | built | `docs/11-native-messaging-registration.md`, `install/register_host.py` |
| 12 | Model shortlist + tool-calling reliability writeup | built / needs run | `docs/12-model-shortlist.md` — methodology and table done, cells marked PENDING |
| 13 | Native host skeleton | built | `voicc_host/main.py`, `protocol.py` |
| 14 | Agent-loop pattern research | built | `docs/145-agent-loop-architecture.md` |

## Day 1

| # | Phase | Status | Where |
|---|---|---|---|
| 28 | Host skeleton + ping-pong messaging | built | `protocol.py`, `main.py` dispatch; round-trip tested |
| 29 | Ollama client wrapper | built | `ollama_client.py` |
| 30 | Structured JSON output enforcement | built | `schemas.parse_model_output`; 22 malformed cases tested |
| 31 | Draft-model wrapper | built / needs run | `draft_planner.py`; latency comparison needs hardware |
| 32 | Multi-action plan schema | built | `schemas.Plan` — **needs Mohit's sign-off** |

## Day 2

| # | Phase | Status | Where |
|---|---|---|---|
| 46 | DOM reasoning prompt (fast default) | built | `prompts.build_reasoning_prompt` |
| 47 | Draft-model escalation trigger | built | `draft_planner._escalation_reason`; 7 triggers, tested |
| 48 | Verification loop (per-plan) | built | `verifier.py`; fallback reports `resume_from` |
| 49 | Warm-keeping + quantization benchmark | needs run | `bench/harness.py warm_keeping` |

## Day 3

| # | Phase | Status | Where |
|---|---|---|---|
| 63 | Voice transcription — hi/kn/en | built / needs assets | `voice/transcriber.py`; three checkpoints must be placed under `models/voice/` |
| 64 | Route transcribed text into the pipeline | built | `voice/router.py`; one pipeline, no separate voice mode |
| 65 | Guardrail validation — live | built | `guardrails.py` |
| 66 | Memory + evidence-aware prompts | built | `prompts.build_reasoning_prompt`, capped at 3 facts |

## Day 4

| # | Phase | Status | Where |
|---|---|---|---|
| 79 | Cache correctness on changed pages | built | `workflow_cache.py`; 4 invalidation modes tested |
| 80 | Draft-model latency measurement | needs run | `bench/harness.py draft_latency` + `average_cost_per_action` |
| 81 | Structured decision logging | built | `decision_log.py`, hash-chained |
| 82 | Lock model choices + quantization | built / needs run | `docs/82-model-lock.md`, values in `config.py` |

## Day 5

| # | Phase | Status | Where |
|---|---|---|---|
| 95 | Reliability pass on the agent loop | built | one exception boundary; 13 error paths tabulated |
| 96 | Rehearse fallback scenarios | built | `selftest.py --scenario <name>`, 11 scenarios |
| 97 | Voice demo rehearsal, 3 languages | needs people | `docs/rehearsal-runbook.md` |

## Advanced speed

| # | Phase | Status | Where |
|---|---|---|---|
| 107 | KV-cache reuse across a task | built / needs run | `PrefixSession`; prefix stability test passes |
| 108 | Stream and act on safe prefixes | built | `streaming.py`; head-start measured |
| 109 | Model warm-swap overlap | built / needs run | `warm_async`; `bench warm_swap` |

## Stretch

| # | Phase | Status | Where |
|---|---|---|---|
| 122 | Runtime model switching | built | `swap_role`, `set_model` message |
| 123 | Health-check endpoint | built | `client.health()`, `health` message |
| 124 | Request queueing | built | `request_queue.py`; double-submits collapse |
| 125 | Language-detection fallback | built | `detect_language`; asks rather than guessing below the floor |
| 126 | Prompt-size optimization | built | `bench prompt_size` — exact token counts |
| 127 | Load test, 10+ runs | built / needs run | `bench load`, RSS growth tracked |
| 128 | Temperature/sampling tuning | built / needs run | `bench sampling`; values locked in config |

## Verification & documentation

| # | Phase | Status | Where |
|---|---|---|---|
| 142 | Structured-output validation vs malformed input | built | `tests/test_structured_output.py`, 41 tests |
| 143 | Draft → vision handoff timing | built / needs run | `bench handoff`, 100 ms visible-stall threshold |
| 144 | Guardrails vs non-obvious mismatches | built | `tests/test_guardrails.py`, 34 tests |
| 145 | Document agent loop + tool calling | built | `docs/145-agent-loop-architecture.md` |

## Micro-optimizations

| # | Phase | Status | Where |
|---|---|---|---|
| 155 | Batch read-only DOM queries | built | `dom_batch.py`; 10 queries → 1 round trip |
| 156 | Preload most-likely-next model | built | `warm_async` at the escalation branch |
| 157 | Cap max plan length | built | `Plan.split_at`, cap 5 |

## Final cross-team

| # | Phase | Status | Where |
|---|---|---|---|
| 161 | All models coexist within hardware limits | needs run | `bench memory_ceiling` — reports headroom with all checkpoints loaded |

---

## What is genuinely blocked, and on what

1. **Ollama + models** — 49, 80, 107, 109, 127, 128, 143, 161, and the
   PENDING cells in 12. The harness is written; each is one command.
2. **Voice checkpoints** — 63. The code refuses to download them
   (`HF_HUB_OFFLINE=1`), so they must be placed under `models/voice/`.
   Everything downstream of transcription is tested with a scripted backend.
3. **Mohit's sign-off on the plan schema** — 32's done-condition.
4. **A live rehearsal** — 97.

## Cross-team boundaries this code depends on

- **Mohit** implements `execute_plan` with a per-step existence check
  immediately before each action, and returns `{completed, failed_index,
  failure, executed[]}`. The fallback's `resume_from` is only correct if
  `completed` is accurate.
- **Siddu** implements `PerceptionProvider.resolve` for the vision rungs
  and supplies `visible_tags` matching what is actually drawn on the crop.
  The host refuses any tag the model picks that is not in that list.
- **Siddu's memory** supplies the fact list; the prompt layer caps it at 3.
- **Chinmay** reads `logs/decisions.jsonl` — already hash-chained, so
  `verify_log` passes on an untouched log and fails on a tampered one.
