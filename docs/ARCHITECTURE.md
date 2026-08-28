# Architecture — SIH26171 Browser AI Agent

## Master Flow

```
User Command (text or voice)
        │
        ▼
┌─ Extension Popup ─────────────────────────────────────┐
│  Voice → Transcription (local Whisper) → Text         │
│  Text command → Background Service Worker              │
└──────────────────────┬────────────────────────────────┘
                       │
                       ▼
┌─ Content Script ─────────────────────────────────────┐
│  Semantic DOM Filter (2-pass):                        │
│    Pass 1: Remove non-visible, non-interactive nodes  │
│    Pass 2: Extract semantic attrs (tag, text, ARIA)   │
│  Output: Minified JSON tree (~90% payload reduction)  │
│  + chrome.tabs.captureVisibleTab → screenshot          │
└──────────────────────┬───────────────────────────────┘
                       │ Native Messaging (length-prefixed JSON)
                       ▼
┌─ Native Host (Python) ──────────────────────────────────────────┐
│                                                                  │
│  ┌─ Memory Retrieval ──┐   ┌─ Page Perception ──────────────┐  │
│  │ (runs in parallel)  │   │  DOM-vs-Vision Router:          │  │
│  │                     │   │    DOM clear? → use DOM/JSON    │  │
│  │ Query Chroma with   │   │    Ambiguous? → Foveated Vision │  │
│  │ command text         │   │      1. Locate sub-regions     │  │
│  │ Return top-3 facts  │   │      2. Crop patches            │  │
│  └─────────┬───────────┘   │      3. Numbered-tag overlay    │  │
│            │               │      4. Vision model inference  │  │
│            │               └──────────────┬──────────────────┘  │
│            │                              │                      │
│            └──────────┬───────────────────┘                      │
│                       ▼                                          │
│  ┌─ Draft Model (0.5B) ─────────────────────────────────────┐   │
│  │  Fast speculative plan on clear DOM layouts               │   │
│  │  → If confident: execute plan directly                    │   │
│  │  → If ambiguous: escalate to full vision model            │   │
│  └───────────────────────────┬───────────────────────────────┘   │
│                              ▼                                   │
│  ┌─ Agent Loop (Plan → Act → Verify) ───────────────────────┐   │
│  │  Plan: Ordered list of actions (multi-action schema)      │   │
│  │  Act:  Execute all steps deterministically, no model call │   │
│  │        Per-step element existence check before firing     │   │
│  │  Verify: Check end state once after full plan completes   │   │
│  │          Fall back to single-step if verification fails   │   │
│  └───────────────────────────┬───────────────────────────────┘   │
│                              ▼                                   │
│  ┌─ Guardrail Validation ────────────────────────────────────┐   │
│  │  For submit/delete/confirm: cross-check real label vs     │   │
│  │  stated intent before execution                           │   │
│  │  Below-threshold confidence → pause and ask user          │   │
│  └───────────────────────────┬───────────────────────────────┘   │
│                              ▼                                   │
│  ┌─ Proof-of-Perception ────────────────────────────────────┐   │
│  │  Capture: DOM element / vision crop that justified action │   │
│  │  Reason: One-line explanation                             │   │
│  │  Hash-chain: Each log entry hashes previous → tamper-evident│  │
│  └───────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘

        │ Action result + evidence
        ▼
┌─ Extension UI ──────────────────────────────────────┐
│  Execute action on DOM                               │
│  Show evidence panel (crop + reason per step)        │
│  Show confidence indicator                           │
│  Show cached-vs-fresh reasoning indicator            │
│  One-click hash-chain verification button            │
│  Resource usage dashboard (RAM, latency, model size) │
└──────────────────────────────────────────────────────┘
```

## Graceful Degradation Ladder

```
1. DOM/JSON clear → use filtered DOM directly (fastest)
        ↓ (DOM insufficient)
2. Numbered-tag vision on cropped patches (foveated)
        ↓ (foveation fails)
3. Full-page vision on full screenshot
        ↓ (vision fails)
4. Explained failure with reason to user
```

## Memory Architecture

```
Chroma PersistentClient (local folder, zero network)
├── session_memory     — current session context, cleared on restart
├── user_preferences   — learned user patterns, persisted
├── site_knowledge     — layout summaries per site, auto-populated
└── task_history       — past task outcomes, for learning

Versioning: Each fact has version + superseded fields.
Updates mark old facts as superseded → only latest returned.
```

## Model Stack

| Role | Model | Size | Quantization |
|------|-------|------|-------------|
| Text reasoning | qwen2.5-3b or llama3.2-3b | 3B | 4-bit (Q4_K_M) |
| Vision | moondream or qwen2-vl-2b | 2B | 4-bit |
| Draft (speculative) | TBD ~0.5B | 0.5B | 4-bit |
| Voice (Hindi) | AI4Bharat/IndicConformer | — | — |
| Voice (Kannada) | AI4Bharat/IndicConformer | — | — |
| Voice (English) | Whisper-small or distil-whisper | — | — |
| Embeddings | nomic-embed-text (local Ollama) | — | — |
