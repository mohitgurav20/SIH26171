# SIH26171 — Activity & Security Audit Log Schema Specification
**Author:** Chinmay (Independent Track — Security, QA & Benchmarking)  
**Date:** 2026-08-28  
**Tasks:** #51 (Day 2 — Audit Log Schema Design), #69 (Day 3 Verification), #71 & #75 (Hash-Chain Proof of Integrity)

---

## 1. Executive Summary & Objective
In mission-critical aerospace and satellite telemetry operations (ISRO MOS), autonomous web agent actions must be 100% accountable, immutable, and tamper-evident.

The **SIH26171 Cryptographic Audit Log Engine** implements a continuous, zero-network, local SHA-256 hash chain (Merkle/blockchain-style linkage) binding every perception tier, LLM decision, user instruction, and executed browser action to an immutable cryptographic ledger.

---

## 2. Cryptographic Hash-Chain Schema

Each log entry is represented as a structured JSON object with the following fields:

| Field Name | Type | Description |
|---|---|---|
| `entry_id` | `string` | Unique UUIDv4 identifier for the log entry |
| `timestamp_iso` | `string` | UTC timestamp in ISO 8601 format (`YYYY-MM-DDTHH:MM:SS.sssZ`) |
| `unix_timestamp_ms` | `integer` | High-resolution epoch timestamp in milliseconds |
| `session_id` | `string` | Unique identifier of the current mission control session |
| `step_index` | `integer` | Monotonically increasing sequence number (0, 1, 2, ...) |
| `user_intent` | `string` | Natural language prompt or voice command issued by the operator |
| `language` | `string` | Operator language code (`en`, `hi`, `kn`) |
| `perception_tier` | `string` | Perception mode used: `dom_filtered`, `cropped_vision`, or `full_vision` |
| `action_type` | `string` | Action performed: `click`, `type`, `select`, `scroll`, `pause_confirm`, `refusal` |
| `target_element` | `object` | Bounding box coordinates, Set-of-Marks tag ID (`[1]`, `[2]`), and DOM text |
| `proof_of_perception`| `object` | Crop digest, DOM snapshot hash, and reason string |
| `guardrail_status` | `string` | `PASSED`, `TRIGGERED_REFUSAL`, or `TRIGGERED_CONFIRMATION` |
| `prev_entry_hash` | `string` | SHA-256 hex digest of the preceding log entry (`GENESIS_0000000000000000` for step 0) |
| `entry_hash` | `string` | SHA-256 hex digest of the canonicalized payload + `prev_entry_hash` |

---

## 3. Hash Calculation Algorithm

The `entry_hash` is computed over the normalized, sorted canonical JSON payload combined with `prev_entry_hash`:

$$\text{CanonicalString} = \text{SortJSON}(\text{fields} \setminus \{\text{entry\_hash}\})$$
$$\text{entry\_hash} = \text{SHA256}(\text{prev\_entry\_hash} \parallel \text{CanonicalString})$$

### Python Reference Implementation:
```python
import hashlib
import json

GENESIS_HASH = "0" * 64

def compute_entry_hash(entry_dict: dict, prev_hash: str) -> str:
    # Exclude entry_hash itself during hashing
    payload = {k: v for k, v in entry_dict.items() if k != "entry_hash"}
    canonical_repr = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    hasher = hashlib.sha256()
    hasher.update((prev_hash + canonical_repr).encode("utf-8"))
    return hasher.hexdigest()
```

---

## 4. Example Structured Log Entry

```json
{
  "entry_id": "c7a8b9f1-4e2a-4b92-91ef-3d5f81a70921",
  "timestamp_iso": "2026-08-28T21:40:15.120Z",
  "unix_timestamp_ms": 1787943615120,
  "session_id": "ISRO-SESSION-CARTOSAT-3A-09",
  "step_index": 1,
  "user_intent": "Calibrate Cartosat-3A PAN-3 sensor gain to 1.2x",
  "language": "en",
  "perception_tier": "dom_filtered",
  "action_type": "click",
  "target_element": {
    "tag_id": 1,
    "html_tag": "button",
    "text": "Calibrate Gain",
    "bounding_box": {"x": 680, "y": 245, "w": 95, "h": 28}
  },
  "proof_of_perception": {
    "evidence_type": "dom_node_and_crop",
    "evidence_hash": "a4f890c48e89bb0c7493a7c64c718360d8a571732598379201a0bcdeff5012e8",
    "reasoning": "Operator requested calibration for Cartosat-3A PAN-3. Element [1] matched data-sensor='PAN-3'."
  },
  "guardrail_status": "PASSED",
  "prev_entry_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "entry_hash": "5d41402abc4b2a76b9719d911017c59223e7f47493649666f272a2754668b577"
}
```

---

## 5. One-Click Hash Chain Verification Algorithm

When the operator or judge clicks the **"Verify Audit Log Integrity"** button in the UI (Task #75):
1. Load all log records ordered by `step_index`.
2. Verify `entry[0].prev_entry_hash == GENESIS_HASH`.
3. For $i = 0$ to $N-1$:
   - Recompute expected hash: $H_{\text{expected}} = \text{SHA256}(\text{entry}[i].\text{prev\_entry\_hash} \parallel \text{CanonicalString}(\text{entry}[i]))$.
   - Assert $H_{\text{expected}} == \text{entry}[i].\text{entry\_hash}$.
   - If $i < N - 1$, assert $\text{entry}[i+1].\text{prev\_entry\_hash} == \text{entry}[i].\text{entry\_hash}$.
4. If all assertions pass, return `VERIFIED_INTACT (100% Tamper Proof)`.
5. If any hash mismatches, report `CORRUPTION_DETECTED` with the exact broken `step_index`.
