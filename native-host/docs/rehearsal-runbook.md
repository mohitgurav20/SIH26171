# 95 / 96 / 97 — Reliability pass and rehearsal runbook

## 95 — Every error path shows a clear message

There is exactly one place exceptions become user-facing outcomes:
`AgentLoop.run`'s try/except. Nothing below it is allowed to reach the UI
as a stack trace. Verify with:

```bash
python -m voicc_host.selftest          # all 11 scenarios
python -m pytest                       # 155 tests
```

| Failure | What the user sees | Code |
|---|---|---|
| Ollama not running | "The local model server isn't running. Start Ollama and try again." | `backend_unavailable` |
| model missing | "A required local model isn't installed." | `model_not_found` |
| malformed model output | escalates silently; only a repeated failure surfaces | `invalid_model_output` |
| intent ≠ real label | "Blocked: you asked for X but that element is Y." | `guardrail_violation` |
| no perceptual evidence | "Blocked: nothing on the page justifies that action." | `evidence_missing` |
| below confidence floor | "I'm only N% sure about X. Go ahead?" | `low_confidence` |
| target not on page | the model's own explanation, as a refusal | `no_matching_element` |
| plan halted mid-run | "That didn't complete: …" plus `resume_from` | `verification_failed` |
| silent/short audio | "I didn't hear anything — try again." | `transcription_failed` |
| language undetectable | "I couldn't tell which language that was." | `transcription_failed` |
| double-submit | collapsed onto the in-flight command | — |
| queue full | "Too many commands at once — slow down a moment." | `queue_overflow` |
| browser stops replying | "The browser stopped responding to the agent." | `protocol_error` |

## 96 — Forcing each fallback on demand

Every moment can be triggered deliberately rather than hoped for:

```bash
python -m voicc_host.selftest --scenario low_confidence
python -m voicc_host.selftest --scenario vision_fallback
python -m voicc_host.selftest --scenario guardrail_block
python -m voicc_host.selftest --scenario backend_down
python -m voicc_host.selftest --scenario cache          # hit, then invalidation
python -m voicc_host.selftest --scenario hallucinated_element
python -m voicc_host.selftest --scenario plan_cap
```

Live, against the real dashboard:

| Moment | How to force it |
|---|---|
| low confidence | vague command: "click the thing on the left" |
| vision fallback | command targeting the canvas widget |
| guardrail block | "export the report" on a page where Export sits next to "Delete all" |
| offline | disable the network adapter mid-demo; nothing changes, which is the point |
| cache replay | run the same command twice; the second shows the replay badge |
| cache invalidation | reload the dashboard with a reordered table, then repeat the command |

## 97 — Voice rehearsal, all three languages

```bash
python -m voicc_host.selftest --scenario voice
```

| Language | Spoken | Canonical form the model sees |
|---|---|---|
| Hindi | रिपोर्ट्स पेज खोलो और सबमिट दबाओ | `reports page open and submit click` |
| Kannada | ವರದಿ ಪುಟ ತೆರೆ ಮತ್ತು ಸಲ್ಲಿಸಿ ಒತ್ತಿ | `report page open and submit click` |
| English | open the reports page and click submit | unchanged |

The UI shows what was **said**; the model reasons over the canonical form.
Proper nouns and field values pass through untouched — "Ramesh" stays
"Ramesh".

Checklist before the run:
- three checkpoints present under `models/voice/`;
- `--health` shows no missing models;
- mic permission already granted in the demo Chrome profile;
- language selector set explicitly for each language moment — auto-detect
  is the fallback demo, run it separately and expect it to ask when it
  genuinely cannot tell.

## Pre-demo smoke test

```bash
python -m voicc_host.main --health            # backend + models
python -m pytest                              # 155 tests
python -m voicc_host.selftest                 # 11 scenarios
python bench/harness.py memory_ceiling        # everything fits (161)
```
