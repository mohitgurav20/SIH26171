# SIH26171 — On-device Visual Perception for Light-weight Browser Agents

> **Track:** Software · **Sponsor:** ISRO · **Team:** 4 members · **Window:** 6 days · **Phases:** 162 tasks

A fully on-device, zero-network browser AI agent that uses visual perception, numbered-tag grounding, versioned memory, and multi-action execution to automate browser tasks — with Hindi, Kannada & English voice support.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Chrome Extension (Manifest V3)                │
│  ┌──────────┐  ┌──────────────┐  ┌─────────────┐  ┌──────────┐ │
│  │ Popup UI │  │Content Script│  │  Background  │  │ Evidence │ │
│  │ + Voice  │  │ DOM Filter   │  │  Relay       │  │  Panel   │ │
│  └────┬─────┘  └──────┬───────┘  └──────┬───────┘  └──────────┘ │
└───────┼───────────────┼────────────────┼────────────────────────┘
        │               │                │
        └───────────────┼────────────────┘
                        │ Native Messaging (stdin/stdout JSON)
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Native Host (Python)                          │
│  ┌────────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │ Agent Loop │  │  Draft   │  │ Guardrail│  │    Voice      │  │
│  │ Plan→Act→  │  │  Model   │  │ Validate │  │ Transcription │  │
│  │  Verify    │  │ (0.5B)   │  │          │  │ (3 languages) │  │
│  └─────┬──────┘  └────┬─────┘  └──────────┘  └──────────────┘  │
│        │               │                                         │
│        ▼               ▼                                         │
│  ┌──────────────────────────┐   ┌────────────────────────────┐  │
│  │   Ollama Models (local)  │   │  Vision Pipeline           │  │
│  │   Text: qwen2.5-3b      │   │  Foveation → Crop →        │  │
│  │   Vision: moondream/     │   │  Numbered Tags → Model →   │  │
│  │     qwen2-vl-2b          │   │  Selection                 │  │
│  └──────────────────────────┘   └────────────────────────────┘  │
│                                                                  │
│  ┌──────────────────────────┐   ┌────────────────────────────┐  │
│  │   Versioned Memory       │   │  Proof-of-Perception       │  │
│  │   (Chroma + versioning)  │   │  Evidence + Hash-chain     │  │
│  │   4 collections          │   │  Audit Log                 │  │
│  └──────────────────────────┘   └────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Key Differentiators

| Feature | Description |
|---------|-------------|
| **100% On-device** | Zero network calls — memory, vision, reasoning, voice all local |
| **Versioned Memory** | Self-built Chroma + versioning, not Mem0/OpenClaw — updated facts replace old ones |
| **Foveated Vision** | Crop relevant sub-regions instead of full screenshots — faster inference |
| **Numbered-Tag Grounding** | Model outputs tag numbers, never raw coordinates — deterministic |
| **Multi-Action Execution** | Execute full action plans without model calls between steps |
| **Draft-Model Speculative Planning** | 0.5B model proposes fast plans; escalates to full model only when ambiguous |
| **Proof-of-Perception** | Every action has evidence (DOM/vision crop + reason) + hash-chain tamper-evident log |
| **3-Language Voice** | Hindi, Kannada, English via local AI4Bharat/Indic-tuned Whisper |
| **Guardrail Validation** | Cross-checks element labels against intent before destructive actions |
| **Graceful Degradation** | DOM → numbered-tag vision → full-page vision → explained failure |

## Project Structure

```
Browser-AI-agent/
├── extension/          # Chrome Extension (Mohit)
├── native-host/        # Native Messaging Host + Agent Loop (Omkar)
├── memory/             # Versioned Memory System (Siddu)
├── vision/             # Vision Pipeline + Grounding (Siddu)
├── dashboard/          # Mock ISRO Dashboard + Benchmarks (Chinmay)
└── docs/               # Architecture & contracts
```

## Branch Strategy

| Branch | Purpose | Owner |
|--------|---------|-------|
| `main` | Production / frozen demo | Siddu (gatekeeper) |
| `integration` | Active integration — **only Siddu merges here** | Siddu |
| `feature/extension` | Extension development | Mohit |
| `feature/native-host` | Native host + agent loop | Omkar |
| `feature/memory` | Memory system | Siddu |
| `feature/vision` | Vision pipeline | Siddu |
| `feature/dashboard` | Dashboard + QA | Chinmay |

## Team

| Member | Role | Owns |
|--------|------|------|
| **Siddu** | Integration Lead | Memory, Vision, Foveation, Proof-of-Perception, Hash-chain, Integration |
| **Mohit** | Extension Lead | Extension, DOM Filtering, Multi-Action UI, Evidence Panel, Overlays |
| **Omkar** | Agent & Voice Lead | Native Host, Agent Loop, Draft Model, Guardrails, Voice (3 languages) |
| **Chinmay** | QA & Benchmarks | Dashboard, Encryption, Adversarial Testing, Benchmark Harness |

## Quick Start

### Prerequisites
- Python 3.10+
- [Ollama](https://ollama.ai/) installed and running locally
- Google Chrome (for extension development)
- Node.js 18+ (optional, for extension build tooling)

### Setup
```bash
# Clone the repo
git clone https://github.com/siddubakka/Browser-AI-agent.git
cd Browser-AI-agent

# Switch to your feature branch
git checkout feature/<your-branch>

# Install Python dependencies (for native-host, memory, vision)
pip install -r native-host/requirements.txt
pip install -r memory/requirements.txt
pip install -r vision/requirements.txt

# Pull required Ollama models
ollama pull qwen2.5:3b
ollama pull moondream:latest

# Load extension in Chrome
# 1. Go to chrome://extensions
# 2. Enable Developer Mode
# 3. Click "Load unpacked" → select extension/ folder
```

## License

Internal SIH project — not for public distribution.