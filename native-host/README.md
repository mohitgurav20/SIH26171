# SIH26171 — Native host

Agent reasoning, draft-model speculative planning, guardrails and local
voice. Owner: **Omkar**.

Everything runs on-device. The only host this process will talk to is the
loopback Ollama server; `Config.assert_local_only()` refuses to start
otherwise, and `HttpBackend` disables proxy env vars so a corporate proxy
cannot quietly turn a local call into an outbound one.

## Quick start

```bash
pip install -r requirements.txt

python -m pytest                     # 155 tests, no Ollama needed
python -m voicc_host.selftest        # 11 end-to-end scenarios, offline
python -m voicc_host.main --health   # is the real backend reachable?

python install/register_host.py --extension-id <id>   # then restart Chrome
```

## Layout

| Path | Phase | What it is |
|---|---|---|
| `voicc_host/protocol.py` | 13, 28 | Chrome native-messaging framing |
| `voicc_host/schemas.py` | 30, 32 | wire contract + structured-output enforcement |
| `voicc_host/prompts.py` | 46, 66, 126 | prompt templates, prefix/suffix split |
| `voicc_host/ollama_client.py` | 29, 49, 107, 108, 109, 122, 123 | warm-kept, prefix-aware, streaming client |
| `voicc_host/streaming.py` | 108 | act on safe prefixes mid-stream |
| `voicc_host/draft_planner.py` | 31, 47, 80 | speculative planning + escalation |
| `voicc_host/perception.py` | 40, 55, 70, 143 | the ladder; boundary with Siddu's vision |
| `voicc_host/guardrails.py` | 39, 65, 144 | intent vs. real label cross-check |
| `voicc_host/verifier.py` | 48 | one end-state check per plan |
| `voicc_host/workflow_cache.py` | 79 | cache replay safety |
| `voicc_host/decision_log.py` | 81, 71 | structured log with hash chain |
| `voicc_host/request_queue.py` | 124 | bounded queue, double-submit collapsing |
| `voicc_host/dom_batch.py` | 155 | batch read-only DOM queries |
| `voicc_host/voice/` | 63, 64, 125 | three local checkpoints + routing |
| `voicc_host/agent_loop.py` | 14, 46–48, 57, 157 | plan → act → verify |
| `voicc_host/main.py` | 59, 123 | host entry, dispatch, threading |
| `voicc_host/selftest.py` | 95, 96 | offline scenarios |
| `bench/harness.py` | 49, 80, 107–109, 126–128, 143, 161 | measurement |

## Message contract (phase 5)

Extension → host:

| Type | Payload | Answered |
|---|---|---|
| `ping` | — | inline |
| `health` | — | inline |
| `command` | `task`, `page`, `memories[]`, `image_b64?`, `visible_tags[]?`, `crop_id?` | queued |
| `voice` | `audio_b64` (WAV), `language?`, + all `command` fields | queued |
| `confirm` | same as `command`, after a low-confidence pause | queued |
| `set_language` | `language` (`hi`/`kn`/`en`/null for auto) | inline |
| `set_model` | `role`, `model` | inline |
| `verify_log` / `log_summary` | — | inline |

Host → extension:

| Type | When |
|---|---|
| `ready` | on startup, carries a health report |
| `queued` | command accepted, with queue depth |
| `progress` | `plan`, `plan_prefix`, `escalation`, `cache`, `plan_capped`, `transcript`, `task_complete` |
| `execute_plan` | **needs a reply**: `{completed, failed_index, failure, executed[]}` |
| `read_page` | **needs a reply**: `{page}` |
| `result` | final `TaskOutcome` |
| `error` | `{code, message, detail, recoverable}` |

Replies to `execute_plan` / `read_page` must echo `in_reply_to:
<request_id>`.

## Notes for whoever picks this up

- `python -m pytest` and `python -m voicc_host.selftest` both run with **no
  Ollama and no models installed** — the scripted backend covers the whole
  loop. Use it before blaming a model.
- Never `print()` from anything importable. stdout *is* the protocol.
  `install_stdio_guard` rebinds `sys.stdout` to stderr to make an accidental
  print survivable, but the discipline still matters.
- Benchmarks run with `--scripted` produce **simulated** timings. Those are
  labelled `quotable: false` in `bench/results.json`. Only real-backend runs
  go in the pitch.
