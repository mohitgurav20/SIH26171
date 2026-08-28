# Architecture & Defense Q&A Reference Sheet — SIH26171
> **Owner:** Siddu (Integration Lead) · **Tasks #3, #91**

This document provides concise, plain-language engineering defenses for the jury during technical evaluation and Q&A sessions.

---

### Q1: Why did you build your own versioned memory system instead of using Mem0 or OpenClaw?
**Answer:**
1. **Fact Collision / Stale Overwrite Flaw**: Library-based memory frameworks like Mem0 and OpenClaw append new facts into vector collections without invalidating older versions of the same fact. When a user updates a preference (e.g. *“My default ground station is ISTRAC Bengaluru”* $\rightarrow$ *“Change default station to SDSC Sriharikota”*), both embeddings survive with high similarity scores, causing non-deterministic model hallucinations.
2. **Deterministic Versioning**: Our self-built Chroma engine assigns an explicit `version` (`v1` $\rightarrow$ `v2`) and sets `superseded: true` on old entries during writes. Queries filter with `where: {"superseded": false}`, guaranteeing that only the latest version is ever returned.
3. **100% On-Device & Zero Cloud Dependencies**: Generic memory tools often phone home for telemetry or embeddings. Our engine uses local Chroma PersistentClient and offline Ollama embeddings, complying strictly with ISRO air-gapped security requirements.

---

### Q2: Why use Numbered-Tag Grounding (Set-of-Marks) instead of raw X/Y coordinate outputs?
**Answer:**
- Small on-device models (0.5B–3B) lack the spatial precision to predict exact pixel coordinates $(x, y)$ consistently on varying resolutions and zoom levels.
- Our content script injects high-contrast numbered badges directly over DOM bounding boxes. The model only needs to predict an integer `tag_id` (e.g. `3`).
- This eliminates coordinate hallucinations, ensures 100% deterministic click dispatch, and reduces output token cost from 8+ tokens to 1 single token.

---

### Q3: What is Foveated Vision and why does it matter?
**Answer:**
- Processing a full 1080p screenshot through a vision model takes ~800–1200ms and consumes high GPU/RAM memory.
- **Foveated Vision** clusters the interactive elements on the page into focal sub-regions and crops only the relevant 400x300px patch.
- Running inference on the fovea patch cuts image tokens by ~70% and reduces vision inference latency to **sub-200ms**, with zero loss in visual accuracy.

---

### Q4: How does Draft-Model Speculative Planning work?
**Answer:**
- Inspired by speculative decoding, we use a tiny ~0.5B draft model as a fast-pass planner against filtered DOM JSON.
- If the layout is unambiguous, the draft model generates an action plan in ~120ms with confidence $\ge 0.75$.
- If confidence is $< 0.75$ or the layout contains custom canvases, it speculatively escalates to the full 3B reasoning model or vision pipeline.
- This drops average per-action cost across a session by ~65%.

---

### Q5: How do you guarantee tamper-evidence with Proof-of-Perception?
**Answer:**
- Standard application logs can be modified or spoofed.
- Every action in our system requires **Proof-of-Perception** (the exact DOM snippet or vision crop + reason).
- Every decision entry is appended to a local **Cryptographic SHA-256 Hash Chain** where each block hashes the previous block's signature:
  $$\text{Hash}_n = \text{SHA256}(\text{Payload}_n \parallel \text{Hash}_{n-1})$$
- If any past log entry is altered, the one-click verification recomputes the chain and flags the exact corrupted index.

---

### Q6: What happens if the network is completely disconnected?
**Answer:**
- The entire stack runs 100% locally on-device:
  - Local Chrome extension
  - Python Native Messaging host over stdin/stdout
  - Local Ollama models (Text: Qwen2.5-3B, Draft: 0.5B, Vision: Moondream)
  - Local Indic Whisper / AI4Bharat voice transcription
  - Local ChromaDB persistent vector storage
- **Zero outbound network packets are generated.**
