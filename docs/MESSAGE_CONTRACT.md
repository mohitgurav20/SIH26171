# Extension ↔ Native Host Message Contract

All messages between the Chrome extension and the native host use Chrome's Native Messaging protocol:
**length-prefixed JSON over stdin/stdout**.

## Message Format

Every message is a JSON object with a `type` field and a `payload` field:

```json
{
  "type": "<message_type>",
  "id": "<unique_request_id>",
  "timestamp": "<ISO8601>",
  "payload": { ... }
}
```

---

## Extension → Host Messages

### `command`
User-issued text command (from typing or voice transcription).
```json
{
  "type": "command",
  "id": "cmd-001",
  "timestamp": "2024-01-01T00:00:00Z",
  "payload": {
    "text": "Click the submit button",
    "source": "text|voice",
    "language": "en|hi|kn"
  }
}
```

### `dom_data`
Filtered DOM tree from content script.
```json
{
  "type": "dom_data",
  "id": "dom-001",
  "timestamp": "2024-01-01T00:00:00Z",
  "payload": {
    "url": "https://example.com",
    "title": "Page Title",
    "elements": [
      {
        "tag_id": 1,
        "tag": "button",
        "text": "Submit",
        "aria_label": "Submit form",
        "bbox": {"x": 100, "y": 200, "w": 80, "h": 30},
        "interactive": true,
        "type": "submit"
      }
    ],
    "element_count": 15,
    "raw_element_count": 450,
    "reduction_percent": 96.7
  }
}
```

### `screenshot`
Captured page screenshot.
```json
{
  "type": "screenshot",
  "id": "ss-001",
  "timestamp": "2024-01-01T00:00:00Z",
  "payload": {
    "image_base64": "<base64_png>",
    "width": 1920,
    "height": 1080,
    "url": "https://example.com"
  }
}
```

### `cropped_patch`
Cropped sub-region from foveation.
```json
{
  "type": "cropped_patch",
  "id": "crop-001",
  "timestamp": "2024-01-01T00:00:00Z",
  "payload": {
    "image_base64": "<base64_png>",
    "region": {"x": 100, "y": 200, "w": 400, "h": 300},
    "tag_ids_in_region": [3, 4, 5],
    "source_url": "https://example.com"
  }
}
```

### `audio`
Recorded voice audio for transcription.
```json
{
  "type": "audio",
  "id": "audio-001",
  "timestamp": "2024-01-01T00:00:00Z",
  "payload": {
    "audio_base64": "<base64_wav>",
    "sample_rate": 16000,
    "language_hint": "en|hi|kn|auto"
  }
}
```

### `action_result`
Result of executing an action on the page.
```json
{
  "type": "action_result",
  "id": "ar-001",
  "timestamp": "2024-01-01T00:00:00Z",
  "payload": {
    "plan_id": "plan-001",
    "step_index": 0,
    "success": true,
    "error": null,
    "page_changed": true
  }
}
```

---

## Host → Extension Messages

### `action_plan`
Multi-action plan for the extension to execute.
```json
{
  "type": "action_plan",
  "id": "plan-001",
  "timestamp": "2024-01-01T00:00:00Z",
  "payload": {
    "actions": [
      {
        "step": 0,
        "action": "click|type|scroll|select",
        "tag_id": 3,
        "value": null,
        "description": "Click the Submit button"
      },
      {
        "step": 1,
        "action": "type",
        "tag_id": 7,
        "value": "Hello World",
        "description": "Type 'Hello World' into the search box"
      }
    ],
    "reasoning": "User wants to submit the form after filling search",
    "confidence": 0.92,
    "source": "dom|vision|draft_model",
    "evidence": [
      {
        "step": 0,
        "element_text": "Submit",
        "dom_snippet": "<button id='submit'>Submit</button>",
        "vision_crop_base64": null,
        "reason": "Matched 'submit button' to element #3 (text: 'Submit')"
      }
    ]
  }
}
```

### `transcription`
Voice transcription result.
```json
{
  "type": "transcription",
  "id": "trans-001",
  "timestamp": "2024-01-01T00:00:00Z",
  "payload": {
    "text": "Click the submit button",
    "language": "en",
    "confidence": 0.95
  }
}
```

### `status`
Status/progress updates.
```json
{
  "type": "status",
  "id": "status-001",
  "timestamp": "2024-01-01T00:00:00Z",
  "payload": {
    "state": "thinking|acting|verifying|done|error|paused",
    "message": "Analyzing page layout...",
    "confidence": 0.85,
    "requires_confirmation": false
  }
}
```

### `confirmation_request`
Low-confidence pause asking for user approval.
```json
{
  "type": "confirmation_request",
  "id": "conf-001",
  "timestamp": "2024-01-01T00:00:00Z",
  "payload": {
    "action": "click",
    "tag_id": 5,
    "element_text": "Delete All",
    "reason": "This is a destructive action — confirming intent",
    "confidence": 0.45
  }
}
```

### `evidence`
Proof-of-Perception evidence for the UI panel.
```json
{
  "type": "evidence",
  "id": "ev-001",
  "timestamp": "2024-01-01T00:00:00Z",
  "payload": {
    "action_id": "plan-001-step-0",
    "element_text": "Submit",
    "dom_snippet": "<button>Submit</button>",
    "vision_crop_base64": "<base64_png_or_null>",
    "reason": "Matched intent 'submit form' to button labeled 'Submit'",
    "hash": "<sha256_of_this_entry>",
    "prev_hash": "<sha256_of_previous_entry>"
  }
}
```

### `resource_stats`
Live resource usage for the dashboard.
```json
{
  "type": "resource_stats",
  "id": "rs-001",
  "timestamp": "2024-01-01T00:00:00Z",
  "payload": {
    "ram_mb": 2048,
    "inference_time_ms": 350,
    "model_loaded": "qwen2.5:3b-q4",
    "vision_model_loaded": "moondream:latest"
  }
}
```
