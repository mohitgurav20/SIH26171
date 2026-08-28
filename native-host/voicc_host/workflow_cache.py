"""Workflow-cache correctness (phase 79).

Siddu's phase 72 caches a successful multi-step flow so a repeat run skips
the model entirely. That is a large speed win and a large correctness risk:
replaying a cached plan against a page whose layout has changed is exactly
how an agent clicks the wrong thing at full speed.

This module is the safety half. A cached workflow is only replayed when the
page it is about to run against still matches the page it was recorded on,
checked three ways:

  1. the layout hash Mohit's extractor computes,
  2. every tag id the plan references still exists,
  3. and each of those elements still carries the label it had when the
     plan was recorded.

Check 3 is the one that matters most in practice. Tag ids are positional,
so a page that grows a row can keep every id valid while quietly moving
"Delete" onto the id that used to be "Edit". A hash-only check would
replay straight into it.
"""
from __future__ import annotations

import hashlib
import json
import time
from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path

from .schemas import PageState, Plan


class CacheOutcome(str, Enum):
    HIT = "hit"
    MISS = "miss"
    INVALIDATED_LAYOUT = "invalidated_layout"
    INVALIDATED_MISSING_ELEMENT = "invalidated_missing_element"
    INVALIDATED_LABEL_CHANGED = "invalidated_label_changed"
    INVALIDATED_DISABLED = "invalidated_disabled"

    @property
    def replayable(self) -> bool:
        return self is CacheOutcome.HIT


@dataclass
class CachedWorkflow:
    key: str
    task: str
    url: str
    layout_hash: str
    plan: dict
    #: tag_id -> label at record time, for the drift check.
    labels: dict[str, str] = field(default_factory=dict)
    recorded_at: float = field(default_factory=time.time)
    replays: int = 0

    def to_plan(self) -> Plan:
        return Plan.model_validate(self.plan)


@dataclass
class CacheDecision:
    outcome: CacheOutcome
    workflow: CachedWorkflow | None = None
    reason: str = ""

    @property
    def replayable(self) -> bool:
        return self.outcome.replayable and self.workflow is not None


def normalize_task(task: str) -> str:
    return " ".join(task.lower().split())


def workflow_key(task: str, url: str) -> str:
    digest = hashlib.sha256(
        f"{normalize_task(task)}\x00{url}".encode("utf-8")).hexdigest()
    return digest[:32]


def layout_fingerprint(page: PageState) -> str:
    """Fallback when the extension did not supply a layout hash.

    Structure only -- ids, roles and labels. Deliberately excludes values,
    so a form with text typed into it still matches the empty form.
    """
    parts = [f"{e.tag_id}:{e.role}:{e.label()}" for e in page.elements]
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:32]


class WorkflowCache:
    """Local, file-backed, no network. Safe-by-default on every check."""

    def __init__(self, path: Path | None = None):
        self.path = path
        self._entries: dict[str, CachedWorkflow] = {}
        if path is not None and path.exists():
            self.load()

    # -- persistence -------------------------------------------------------

    def load(self) -> None:
        if self.path is None or not self.path.exists():
            return
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return                      # a corrupt cache is simply no cache
        self._entries = {
            key: CachedWorkflow(**value) for key, value in raw.items()}

    def save(self) -> None:
        if self.path is None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {k: asdict(v) for k, v in self._entries.items()}
        self.path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    # -- recording ---------------------------------------------------------

    def record(self, task: str, page: PageState, plan: Plan) -> CachedWorkflow:
        """Store a plan that verified successfully."""
        key = workflow_key(task, page.url)
        labels = {}
        for tag_id in sorted(plan.references()):
            element = page.by_id(tag_id)
            if element is not None:
                labels[str(tag_id)] = element.label()
        workflow = CachedWorkflow(
            key=key, task=normalize_task(task), url=page.url,
            layout_hash=page.layout_hash or layout_fingerprint(page),
            plan=plan.model_dump(mode="json"), labels=labels)
        self._entries[key] = workflow
        self.save()
        return workflow

    # -- lookup ------------------------------------------------------------

    def lookup(self, task: str, page: PageState) -> CacheDecision:
        key = workflow_key(task, page.url)
        workflow = self._entries.get(key)
        if workflow is None:
            return CacheDecision(CacheOutcome.MISS,
                                 reason="no cached workflow for this task")

        current_hash = page.layout_hash or layout_fingerprint(page)
        if current_hash != workflow.layout_hash:
            return CacheDecision(
                CacheOutcome.INVALIDATED_LAYOUT, workflow,
                "page layout changed since this workflow was recorded")

        for tag_id_str, recorded_label in workflow.labels.items():
            element = page.by_id(int(tag_id_str))
            if element is None:
                return CacheDecision(
                    CacheOutcome.INVALIDATED_MISSING_ELEMENT, workflow,
                    f"element {tag_id_str} ({recorded_label!r}) is gone")
            if not element.enabled:
                return CacheDecision(
                    CacheOutcome.INVALIDATED_DISABLED, workflow,
                    f"element {tag_id_str} ({recorded_label!r}) is disabled")
            if element.label() != recorded_label:
                # The dangerous one: same id, different control.
                return CacheDecision(
                    CacheOutcome.INVALIDATED_LABEL_CHANGED, workflow,
                    f"element {tag_id_str} was {recorded_label!r} and is now "
                    f"{element.label()!r}")

        return CacheDecision(CacheOutcome.HIT, workflow,
                             "layout, elements and labels all unchanged")

    def note_replay(self, workflow: CachedWorkflow) -> None:
        workflow.replays += 1
        self.save()

    def invalidate(self, task: str, url: str) -> bool:
        return self._entries.pop(workflow_key(task, url), None) is not None

    def __len__(self) -> int:
        return len(self._entries)
