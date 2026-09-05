# Final Implementation Plan — Unified Vision, Privacy & Execution Architecture

> Fully integrating the **ISRO PS Privacy-Preserving Architecture** with the **Execution & Screen Perception Engine**, while preserving all previous work (autonomous compound flows, 1-click SSO, voice dictation, and hash-chain audit logging).

---

## 1. Root Cause Diagnosis: Why the System is Failing Right Now

| Component | Root Cause | Consequence |
|---|---|---|
| **Native Messaging Link** | `voicc_host.bat` has hardcoded paths to `C:\Users\Asus\...` and Python 3.11; registry points to an older folder name. | Chrome instantly disconnects from the Python host on launch (`offline`). |
| **Extension Execution Trap** | `background.js` has a regex `StepQueue` that intercepts queries; when DOM substring matching fails, it marks steps as `skipped` and declares fake completion, or falls into an unconditional Priority 6 Google search fallback. | Agent never executes real commands; Phase 3 native AI host forwarding is 100% unreachable dead code. |
| **Screen Perception Blindness** | Visual numbered overlays are explicitly disabled (`render_overlays: false`); screenshots lack visual tags; the standalone `vision/pipeline.py` is never imported by the host; and `agent_loop.py` restricts vision solely to opaque regions. | The agent cannot see what is happening on screen; vision models have no visual tags to ground against. |
| **Ollama Model Mismatch** | `config.py` requests `qwen2.5:3b-instruct-q4_K_M` and `qwen2-vl:2b-instruct-q4_K_M`. Your Ollama instance has `qwen2.5:3b` and `moondream:latest`. | Any model call to Ollama returns HTTP 404 (`ModelNotFound`). |
| **ISRO PS Compliance Gap** | PS requires a client-side Privacy-Preserving Filter (redacting passwords, PII, blurring faces) before sending visual context to a server (40% of evaluation marks), plus client-side screen evaluation. | Missing privacy filter = 0/40 on PII detection & redaction metrics. |

---

## 2. Target Unified Architecture

```
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│                               CHROME EXTENSION (CLIENT-SIDE)                              │
│                                                                                           │
│   1. USER INPUT                                                                           │
│      ├── Voice (Hindi / Kannada / English Web Speech API + Offscreen PCM)                 │
│      └── Text Input & Dynamic Suggestion Chips                                            │
│                                                                                           │
│   2. SCREEN PERCEPTION & VISUAL GROUNDING (Task #43, #139)                                │
│      ├── High-contrast Numbered-Tag Badges rendered directly over interactive DOM nodes   │
│      │   (#1, #2, #3... pink pill badges with bounding boxes)                            │
│      └── Local Canvas Screenshot Capture (includes visual numbered tags)                  │
│                                                                                           │
│   3. PRIVACY-PRESERVING PII REDACTION FILTER (ISRO PS Requirement — 40% Evaluation Score)│
│      ├── DOM + Regex PII Detector (passwords, emails, phone, Aadhaar, PAN, credit cards)  │
│      ├── Face Detector (Lightweight in-browser ViT / MobileNet via Transformers.js)       │
│      └── Visual Redactor (Blacks out passwords, blurs faces, masks text with [REDACTED])  │
│                                                                                           │
│   4. CLIENT-SIDE VISION EVALUATOR (ISRO PS WebGPU / ONNX)                                 │
│      └── In-browser ViT classifies page type (login form, dashboard, catalog, blank)      │
│                                                                                           │
│   5. LOCAL HTTP RELAY                                                                     │
│      └── Sends sanitized screenshot + cleaned DOM + task via HTTP fetch()                │
└─────────────────────────────────────────────┬─────────────────────────────────────────────┘
                                              │ HTTP POST /api/plan (JSON + base64)
                                              ▼
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│                               LOCAL AGENT SERVER (Python 3.13)                            │
│                                                                                           │
│   1. API Gateway (`server/app.py` — Flask / FastAPI at http://127.0.0.1:5000)             │
│      └── Eliminates fragile Windows Registry / Native Messaging .bat shim failures        │
│                                                                                           │
│   2. Agent Loop (`agent_loop.py` & `perception.py`)                                       │
│      ├── Draft Model (0.5B) for rapid reflex planning (<250ms)                            │
│      ├── Vision Perception (Moondream:latest / Qwen2-VL) on sanitized numbered-tag image   │
│      ├── Full Text Reasoner (Qwen2.5:3b) for compound logic                               │
│      ├── Guardrail Validation (Destructive action check, label consistency)               │
│      └── Proof-of-Perception (Tamper-evident SHA-256 Hash Chain Audit Log)                │
└─────────────────────────────────────────────┬─────────────────────────────────────────────┘
                                              │ HTTP Response: Verified Action Plan
                                              ▼
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│                           DETERMINISTIC MULTI-ACTION EXECUTOR                             │
│                                                                                           │
│   - Executes action sequence on active tab (click #tag, type into #tag, select, scroll)  │
│   - Dynamic SPA Retry Engine (waits up to 2.5s for React/Vue DOM hydration)              │
│   - Autonomous 1-Click SSO & Credential Login Workflow                                    │
│   - Dispatches trusted pointer & input events                                             │
│   - Real-time step progress broadcast to Extension UI                                     │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Detailed Implementation Phases

### Phase 1: Local HTTP API Server (`server/app.py`)
*Replaces brittle Native Messaging with a robust local HTTP server while reusing 100% of existing agent code.*

- **[NEW] `server/app.py`**:
  - Exposes `GET /api/health` (checks Ollama connectivity, resident models, agent status).
  - Exposes `POST /api/plan` (accepts sanitized DOM, screenshot, task description, returns structured `Plan`).
  - Exposes `POST /api/voice` (processes audio PCM, returns 3-language transcript via Whisper/IndicConformer).
  - Exposes `GET /api/audit_log` and `POST /api/verify_log` (returns tamper-evident hash-chain).
  - Imports directly from `native-host/voicc_host/` (`AgentLoop`, `OllamaClient`, `PerceptionLadder`, `DecisionLogger`, `check_plan`).
- **[NEW] `server/run.py`**:
  - Clean server startup script with auto-detection of local Python 3.13 environment.
- **[MODIFY] `native-host/voicc_host/config.py`**:
  - Align default models with Ollama on this machine:
    - `text`: `"qwen2.5:3b"`
    - `vision`: `"moondream:latest"`
    - `draft`: `"qwen2.5:0.5b-instruct-q4_K_M"`
  - Configure `ALLOWED_HOSTS` to support local HTTP origins (`127.0.0.1`, `localhost`).
- **[MODIFY] `native-host/install/voicc_host.bat` & `com.sih26171.voicc.json`**:
  - Update paths dynamically to `C:\Users\mayab\...` and register the registry key so Native Messaging remains operational as a dual-mode fallback.

---

### Phase 2: Client-Side Privacy-Preserving Redaction Filter (ISRO PS — 40% Marks)
*Ensures sensitive data (passwords, PII, faces) is detected and redacted inside the browser before leaving the client.*

- **[NEW] `extension/pii_detector.js`**:
  - **DOM-based detection**:
    - `input[type="password"]` → Passwords
    - `input[type="email"]`, `input[type="tel"]` → Contact info
    - `input[name*="aadhaar"]`, `input[name*="pan"]`, `input[name*="ssn"]` → National IDs
    - `input[name*="card"]`, `input[name*="cvv"]` → Payment info
  - **Regex-based detection**:
    - Aadhaar (`/\b\d{4}\s?\d{4}\s?\d{4}\b/`)
    - PAN card (`/\b[A-Z]{5}\d{4}[A-Z]\b/`)
    - Email addresses & Indian phone numbers (`/(\+91[\s-]?)?[6-9]\d{9}/`)
  - **Visual Face Detection**:
    - Uses in-browser lightweight model or skin/face Haar cascade in canvas to locate face bounding boxes.
- **[NEW] `extension/pii_redactor.js`**:
  - Canvas-based image redaction:
    - Draws solid black privacy boxes over password fields and credit card CVVs.
    - Applies a Gaussian blur (radius 12px) over detected faces.
  - DOM text sanitization:
    - Replaces actual sensitive values with token placeholders: `[REDACTED_EMAIL]`, `[REDACTED_PHONE]`, `●●●●●●`.
  - Produces a **Redaction Audit Report** (`total_pii_detected`, `regions_masked`, `timestamp`).

---

### Phase 3: Screen Perception & Numbered-Tag Grounding
*Enables the agent to truly "see" what is happening on the screen with numbered visual tags.*

- **[MODIFY] `extension/content.js`**:
  - Enhance `renderOverlayBadges()`:
    - Injects high-visibility numbered badges (`#1`, `#2`, `#3`...) over every interactive element.
    - Badges styled with high contrast (bright pink background `#f43f5e`, white bold font, solid border, z-index 2147483647).
  - Ensure overlays are rendered **before** screenshot capture when visual perception is required.
  - Automatically clear overlays after screenshot or execution so the user's browsing experience remains clean.
- **[MODIFY] `native-host/voicc_host/perception.py` & `vision/pipeline.py`**:
  - Wire `VisionProvider` to format prompts tailored for `moondream:latest`:
    - E.g.: *"Looking at this webpage with numbered pink tags, which tag number should be clicked to [task]? Answer with only the tag number."*
  - Connect `vision/foveation.py` to crop clusters of interactive elements when full-page resolution is high.

---

### Phase 4: Extension Pipeline Rewire & Autonomous Flow Preservation
*Stops fake regex skipping, preserves all autonomous multi-action features, and routes commands through real AI reasoning.*

- **[MODIFY] `extension/background.js`**:
  - Update `handleUserCommand`:
    - **Step 1**: Render visual tags on active tab and capture sanitized screenshot via `pii_redactor.js`.
    - **Step 2**: Check local server (`http://127.0.0.1:5000/api/plan`). If server is running, forward sanitized screenshot + DOM.
    - **Step 3**: If server returns compound action plan, pass it to `executeActionPlan` on the active tab.
    - **Step 4**: Retain the fast reflex rules for instant operations (e.g. "go back", "scroll down", direct domain navigation) without falling into the broken Google search trap.
  - Preserve all existing capabilities:
    - Autonomous 1-click SSO (Google/OAuth One-Tap detection).
    - Dynamic SPA retry logic (waiting for React/Vue hydration).
    - Cross-page step queue state persistence (`activeTask`).
    - Multi-word phonetic website extraction ("try hack me" → "tryhackme", "git hub" → "github").
- **[MODIFY] `extension/popup.js` & `popup.html`**:
  - Add a **"Privacy Shield" badge** to the UI indicating active PII redaction (e.g., `🛡️ Privacy Filter: Active`).
  - Add a server connection indicator (`● Server Connected: 127.0.0.1:5000`).
  - Keep live voice transcription, speech silence auto-submit, always-on mode, and audit log verification button.

---

### Phase 5: Server-Side Redaction Protocol & Prompts
*Teaches the Ollama models to understand sanitized data without breaking action planning.*

- **[MODIFY] `native-host/voicc_host/prompts.py`**:
  - Add awareness for `[REDACTED]` markers:
    - *"Fields labeled [REDACTED_*] represent privacy-masked user inputs (passwords, emails, phone numbers). Plan actions around them normally (e.g. Click the submit button after the masked field)."*
- **[MODIFY] `native-host/voicc_host/verifier.py`**:
  - Verify that actions targeting masked fields succeed without requiring access to the unredacted values.

---

## 4. Verification & Testing Plan

### Automated Tests
1. **Server API Verification**:
   ```powershell
   python server/run.py
   curl http://127.0.0.1:5000/api/health
   ```
2. **Ollama Model Integration**:
   ```powershell
   python -c "import requests; print(requests.post('http://127.0.0.1:11434/api/generate', json={'model':'moondream:latest','prompt':'Hi','stream':False}).json())"
   ```
3. **Core Host Unit Tests**:
   ```powershell
   python -m pytest native-host/tests/
   ```

### Manual & PS Demonstration Checklist
1. **Screen Perception Verification**:
   - Give command: `"Click on [specific link/button]"`.
   - Verify visual numbered tags appear on the screen.
   - Verify the agent correctly identifies the matching tag number and clicks it.
2. **Privacy Redaction Verification**:
   - Navigate to a page with login/passwords/email fields.
   - Trigger screenshot capture.
   - Inspect captured image in server log: verify passwords are blacked out and faces/emails are masked.
   - Verify server reasons on the sanitized data and successfully submits the form.
3. **Cross-Page Autonomous Flow**:
   - Give compound command: `"Open github and search for SIH"`.
   - Verify navigation, SPA wait, and search execution complete seamlessly.
4. **Voice Command Verification**:
   - Test speech recognition in English, Hindi, or Kannada.
   - Verify transcription auto-submits and executes the expected browser action.
