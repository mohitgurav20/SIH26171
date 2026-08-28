# SIH26171 Chrome Extension — Manifest V3

> **Module Owner:** Mohit (Extension Lead)  
> **Status:** 100% Implemented & Verified (Days 0–5 + Advanced Speed Engineering)

## Overview
This Chrome Extension serves as the visual perception and interaction interface for the SIH26171 On-Device Browser AI Agent. It interfaces with the local Python Native Messaging Host over stdin/stdout length-prefixed JSON.

---

## Core Capabilities Implemented

1. **Two-Pass Semantic DOM Filter (`content.js`)**:
   - **Pass 1**: Strips non-visible nodes (`display: none`, `visibility: hidden`, `opacity: 0`, zero-dimension rects, `aria-hidden="true"`, script/style tags).
   - **Pass 2**: Extracts semantic attributes (`tag_id`, visible text, ARIA labels, interactive roles, bounding box coordinates `{x, y, w, h}`, center points).
   - **Payload Reduction**: Generates compact JSON payloads with **>90% structural reduction** vs raw HTML.
   - **Incremental Diffing**: `MutationObserver` dirty tracking for sub-millisecond cached responses (Task 104) and 150ms debounce (Task 152).

2. **Numbered-Tag Grounding Overlays (`content.js`)**:
   - Renders high-contrast `#facc15` floating Set-of-Marks badges (`tag_id`) on all interactive targets (Task 43).
   - Zoom-calibrated positioning accurately supporting 50% to 200% zoom levels (Task 139).
   - Toggle button in popup UI for instant on/off visualization.

3. **Deterministic Multi-Action Executor (`content.js`)**:
   - Executes multi-step `action_plan` sequences (`click`, `type`, `select`, `scroll`, `hover`, `press_key`, `wait`) without intermediate model calls (Task 44).
   - Immediate **per-step existence checks** before firing each action; halts safely and reports executed steps if a target element vanishes.
   - React/Vue/Angular property descriptor prototype setter bypass for guaranteed input event dispatch.
   - Visual execution pulse with smooth scrolling.

4. **Offscreen Canvas & Audio Processing (`offscreen.html`, `offscreen.js`)**:
   - Offscreen canvas sub-region cropping for foveated vision patches (Task 42).
   - 16kHz Mono PCM Web Audio recording and raw 16-bit WAV base64 encoder for local Whisper and AI4Bharat models (Task 60).

5. **Background Service Worker (`background.js`)**:
   - Native messaging bridge with auto-reconnect to `com.sih26171.browser_ai_agent`.
   - Full screenshot capture via `chrome.tabs.captureVisibleTab` (Task 26).
   - **Predictive Page State Prefetching** for navigation-triggering actions (Task 105).
   - Off-thread Web Worker offloading for JSON tree compression (`dom-worker.js`, Task 106).

6. **Glassmorphism UI Suite (`popup.html`, `popup.css`, `popup.js`)**:
   - Ultra-premium dark glassmorphic design system.
   - Multilingual voice selector chips (`EN`, `HI`, `KN`, `AUTO`) (Task 120).
   - Multi-Action plan progress visualizer (`Queued` → `Running` → `Done` / `Failed`) (Task 121).
   - Proof-of-Perception Evidence Panel with zoomable crops and SHA-256 hash badges (Task 61, 75).
   - Low-confidence Guardrail Confirmation Modal (`Approve Action` / `Abort`) (Task 62).
   - Real-time RAM (MB) & Latency (ms) resource dashboard (Task 77).
   - Cache Invalidation UI Feedback (`⚡ Cached Flow` / `⚠️ Cache Invalidated`) (Task 78).

---

## Testing & Packaging

### Run Automated Tests (13/13 Passed)
```powershell
node extension/test_runner.js
```

### Build Production Unpacked Bundle
```powershell
node extension/build_extension.js
```

### Load Unpacked in Chrome
1. Open `chrome://extensions/`
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked** (top-left) and select `extension/` (or `extension/dist/`).
