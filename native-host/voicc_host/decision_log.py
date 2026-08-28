"""Structured decision logging (phase 81).

Every decision point in the agent loop writes one record here: which model
ran, which tier answered, what it decided, how long it took, and the
evidence behind it. Two consumers depend on this being complete rather than
merely present:

  * the why-panel, which shows the user why an element was chosen;
  * Chinmay's tamper-evident audit log (phases 51, 71), which chains
    entries by hash.

The chaining is done here, at write time, because a hash chain computed
after the fact proves nothing. Each entry carries the hash of the previous
one, so editing any past entry breaks verification from that point on --
which is exactly what Mohit's one-click verify button (phase 75)
demonstrates, passing on an untouched log and failing on a tampered one.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from .schemas import Decision, DecisionRecord, Evidence, PerceptionTier

GENESIS = "0" * 64


def _canonical(payload: dict[str, Any]) -> str:
    """Stable serialization: the hash must not depend on key order."""
    return json.dumps(payload, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False)


def entry_hash(payload: dict[str, Any], prev_hash: str) -> str:
    body = f"{prev_hash}\x00{_canonical(payload)}"
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


@dataclass
class ChainVerification:
    valid: bool
    entries: int
    broken_at: int | None = None
    reason: str = ""


class DecisionLogger:
    """Append-only JSONL with a hash chain. Local file, no network."""

    def __init__(self, path: Path, *, task_id: str = ""):
        self.path = Path(path)
        self.task_id = task_id
        self._lock = threading.Lock()
        self._prev_hash = GENESIS
        self._sequence = 0
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.exists():
            self._resume()

    def _resume(self) -> None:
        """Continue an existing chain rather than starting a new one."""
        last = None
        for entry in read_entries(self.path):
            last = entry
        if last is not None:
            self._prev_hash = last.get("hash", GENESIS)
            self._sequence = int(last.get("seq", 0)) + 1

    def log(self, record: DecisionRecord, **extra: Any) -> dict:
        payload = record.model_dump(mode="json", exclude_none=True)
        payload.update(extra)
        return self._append(payload)

    def event(self, stage: str, decision: Decision, *, step: int = 0,
              task_id: str = "", model: str = "",
              tier: PerceptionTier | None = None,
              confidence: float | None = None,
              latency_ms: float | None = None, detail: str = "",
              evidence: Evidence | None = None, **extra: Any) -> dict:
        """Convenience wrapper so call sites stay one line."""
        record = DecisionRecord(
            task_id=task_id or self.task_id, step=step, stage=stage,
            decision=decision, model=model, tier=tier, confidence=confidence,
            latency_ms=latency_ms, detail=detail, evidence=evidence)
        return self.log(record, **extra)

    def _append(self, payload: dict) -> dict:
        with self._lock:
            payload = dict(payload)
            payload["seq"] = self._sequence
            payload["ts"] = time.time()
            payload["prev_hash"] = self._prev_hash
            digest = entry_hash(payload, self._prev_hash)
            payload["hash"] = digest
            line = json.dumps(payload, ensure_ascii=False,
                              separators=(",", ":"))
            # Flush and fsync: a crash mid-demo must not lose the record of
            # what the agent had already done.
            with open(self.path, "a", encoding="utf-8") as handle:
                handle.write(line + "\n")
                handle.flush()
                os.fsync(handle.fileno())
            self._prev_hash = digest
            self._sequence += 1
            return payload


def read_entries(path: Path) -> Iterator[dict]:
    if not Path(path).exists():
        return
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                yield {"__malformed__": line}


def verify_chain(path: Path) -> ChainVerification:
    """Re-walk the chain. Any edit to any past entry fails from there on."""
    prev = GENESIS
    count = 0
    for index, entry in enumerate(read_entries(path)):
        if "__malformed__" in entry:
            return ChainVerification(False, count, index,
                                     "entry is not valid JSON")
        stored = entry.get("hash")
        if not stored:
            return ChainVerification(False, count, index, "entry has no hash")
        if entry.get("prev_hash") != prev:
            return ChainVerification(
                False, count, index,
                f"prev_hash mismatch: entry claims "
                f"{entry.get('prev_hash', '')[:12]}, chain is at {prev[:12]}")
        payload = {k: v for k, v in entry.items() if k != "hash"}
        recomputed = entry_hash(payload, prev)
        if recomputed != stored:
            return ChainVerification(
                False, count, index,
                "entry contents do not match its hash (edited after write)")
        prev = stored
        count += 1
    return ChainVerification(True, count, None, "chain intact")


def summarize(path: Path) -> dict:
    """Roll-up used by the resource panel and the post-run report."""
    stages: dict[str, int] = {}
    decisions: dict[str, int] = {}
    latency = 0.0
    count = 0
    for entry in read_entries(path):
        if "__malformed__" in entry:
            continue
        count += 1
        stage = entry.get("stage", "?")
        decision = entry.get("decision", "?")
        stages[stage] = stages.get(stage, 0) + 1
        decisions[decision] = decisions.get(decision, 0) + 1
        latency += float(entry.get("latency_ms") or 0.0)
    return {
        "entries": count,
        "stages": stages,
        "decisions": decisions,
        "total_logged_latency_ms": round(latency, 2),
        "chain": verify_chain(path).__dict__,
    }
