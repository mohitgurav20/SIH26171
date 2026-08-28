# Team Roles — SIH26171

## Siddu — Integration Lead — Memory, Vision & Foveation

**Owns:**
- Repository integration (only Siddu merges into `integration` branch)
- Self-built versioned memory system (Chroma + versioning)
- Full vision/foveation pipeline
- Numbered-tag grounding
- DOM-vs-vision decision router
- Proof-of-Perception evidence capture
- Hash-chain audit log
- Workflow-schema caching
- Master architecture diagram
- Extension↔Host message contract design
- Final code freeze and integration passes

**Branch:** `feature/memory`, `feature/vision`, `integration`

---

## Mohit — Extension, DOM Filtering & Multi-Action UI

**Owns:**
- Chrome extension (Manifest V3, permissions, popup, background worker)
- Semantic DOM-filtering content script (2-pass)
- Minified JSON tree output
- Screenshot capture wiring
- Offscreen canvas cropping
- Numbered-tag overlay renderer
- Native multi-action executor
- Evidence panel UI
- Confidence + refusal UI state
- Mic button + audio recording
- Resource-usage dashboard UI
- One-click log-verification button
- Cache-invalidation UI feedback
- Language-selector UI for voice
- Multi-action plan visualization
- Final UI polish + clean-install flow

**Branch:** `feature/extension`

---

## Omkar — Agent Reasoning, Draft Model & Voice

**Owns:**
- Native messaging host (Python, registration, ping-pong)
- Ollama client wrapper
- Structured JSON output enforcement (Pydantic)
- Draft-model speculative planner
- Multi-action plan schema definition
- Agent loop (plan→act→verify)
- DOM-based reasoning prompt templates
- Draft-model escalation trigger
- Verification loop (per-plan, not per-step)
- Model warm-keeping + quantization benchmarking
- Voice transcription (Hindi, Kannada, English — AI4Bharat/IndicConformer/Whisper)
- Guardrail validation (live implementation)
- Memory-aware + evidence-aware prompt construction
- Runtime model switching, health-check, request queueing
- KV-cache reuse, streaming partial output, model warm-swap

**Branch:** `feature/native-host`

---

## Chinmay — Independent Track — Dashboard, QA, Benchmarking & Security (night shift)

**Owns:**
- Mock ISRO-style dashboard (login, data table, canvas widget)
- Fully standalone — no dependency on others' code
- Local encryption (SQLCipher/file-level) for memory DB
- Activity/audit-log schema design
- Independent nightly QA on merged code
- Adversarial hallucination test list + execution
- Full regression QA passes
- Speed/accuracy benchmark harness
- Independent voice-command testing (all 3 languages)
- Independent workflow-caching verification
- Final benchmark-harness cross-check
- Per-phase latency breakdown
- Race condition stress-testing
- Final independent full-system regression

**Branch:** `feature/dashboard`

---

## Merge Rules

1. **Only Siddu merges into `integration`** — everyone else opens pull requests
2. Feature branches are created from `integration`
3. `main` is frozen demo code — merged from `integration` only at code-freeze
4. Every PR requires the respective module owner's sign-off
