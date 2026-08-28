"""The perception boundary (phases 40, 47, 55, 70, 143).

Siddu owns the vision pipeline itself -- capture, foveated crop, numbered
overlay, model call, selection. This module is the contract the agent loop
talks to, so the loop never needs to know whether an answer came from the
DOM or from a cropped patch, and so the handoff can be timed (phase 143).

It also holds the two things the loop must not be allowed to skip:

  * the ladder (phase 70): DOM, then cropped vision, then full-page vision,
    then an explained failure. Each rung is tried only when the one above
    it could not ground the action.

  * evidence (phase 55): whatever rung answers must hand back an Evidence
    record naming what it actually perceived. A provider that returns a
    selection with no evidence is refused here rather than downstream --
    "no evidence, no action" is only true if something enforces it.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Protocol

from .errors import EvidenceMissing, VoiccError
from .ollama_client import OllamaClient
from .prompts import build_vision_prompt
from .schemas import (Evidence, PageState, PerceptionTier, VisionSelection,
                      json_schema_for, parse_model_output)


@dataclass
class PerceptionRequest:
    """What the loop asks the perception layer to resolve."""

    task: str
    page: PageState
    #: Base64 PNG of the numbered-overlay crop, supplied by the extension.
    image_b64: str = ""
    #: Numbers actually drawn on that image, from Siddu's grounding data.
    visible_tags: list[int] = field(default_factory=list)
    crop_id: str = ""
    memories: list[str] = field(default_factory=list)


@dataclass
class PerceptionResult:
    tier: PerceptionTier
    tag_id: int | None
    confidence: float
    evidence: Evidence | None
    reasoning: str = ""
    rejected: list[int] = field(default_factory=list)
    latency_ms: float = 0.0
    model: str = ""

    @property
    def grounded(self) -> bool:
        return self.tag_id is not None and self.evidence is not None


class PerceptionProvider(Protocol):
    """Implemented by Siddu's pipeline; stubbed in tests."""

    tier: PerceptionTier

    def resolve(self, request: PerceptionRequest) -> PerceptionResult: ...


class DomProvider:
    """Rung 1 -- pure DOM. No model call, no screenshot, no cost.

    This exists so the ladder has a uniform first rung: when the filtered
    DOM contains exactly one element whose label matches the task, there is
    nothing for a model to decide.
    """

    tier = PerceptionTier.DOM

    def resolve(self, request: PerceptionRequest) -> PerceptionResult:
        started = time.perf_counter()
        needle = request.task.strip().lower()
        matches = [e for e in request.page.elements
                   if e.enabled and e.label()
                   and e.label().lower() in needle]
        elapsed = (time.perf_counter() - started) * 1000.0
        if len(matches) != 1:
            return PerceptionResult(
                self.tier, None, 0.0, None,
                reasoning=f"{len(matches)} DOM labels matched the task",
                latency_ms=elapsed)
        element = matches[0]
        evidence = Evidence(
            tier=self.tier, tag_id=element.tag_id,
            source_ref=element.label(),
            reason=f"element {element.tag_id} is labelled "
                   f"{element.label()!r}, which the command names directly",
            dom_snippet=f"<{element.role}> {element.label()}")
        return PerceptionResult(self.tier, element.tag_id, 0.95, evidence,
                                reasoning="unique DOM label match",
                                latency_ms=elapsed)


class VisionProvider:
    """Rungs 2 and 3 -- numbered-overlay selection over an image.

    Cropped and full-page differ only in which image the extension supplies,
    so one class serves both rungs; `tier` is set at construction.
    """

    def __init__(self, client: OllamaClient,
                 tier: PerceptionTier = PerceptionTier.CROPPED_VISION):
        self.client = client
        self.tier = tier
        self._schema = json_schema_for(VisionSelection)

    def resolve(self, request: PerceptionRequest) -> PerceptionResult:
        if not request.image_b64:
            return PerceptionResult(
                self.tier, None, 0.0, None,
                reasoning="no image supplied for this rung")

        prompt = build_vision_prompt(request.task, request.visible_tags,
                                     memories=request.memories)
        started = time.perf_counter()
        try:
            completion = self.client.generate(
                "vision", prompt.text, system=prompt.system,
                images=[request.image_b64], schema=self._schema)
        except VoiccError as exc:
            return PerceptionResult(
                self.tier, None, 0.0, None,
                reasoning=f"vision call failed: {exc}",
                latency_ms=(time.perf_counter() - started) * 1000.0)

        try:
            selection: VisionSelection = parse_model_output(
                completion.text, VisionSelection)
        except VoiccError as exc:
            return PerceptionResult(
                self.tier, None, 0.0, None,
                reasoning=f"vision output rejected: {exc}",
                latency_ms=completion.total_ms, model=completion.model)

        # The model may only pick a number that was actually drawn. This is
        # the vision-side equivalent of validate_plan_against_page.
        if request.visible_tags and selection.tag_id not in request.visible_tags:
            return PerceptionResult(
                self.tier, None, 0.0, None,
                reasoning=f"model chose tag {selection.tag_id}, which is not "
                          f"drawn on the image {request.visible_tags}",
                latency_ms=completion.total_ms, model=completion.model)

        element = request.page.by_id(selection.tag_id)
        label = element.label() if element else ""
        evidence = Evidence(
            tier=self.tier, tag_id=selection.tag_id,
            source_ref=label or f"crop:{request.crop_id or 'full-page'}",
            reason=(selection.reasoning
                    or f"numbered tag {selection.tag_id} was selected from "
                       f"the {self.tier.value} image"),
            crop_id=request.crop_id)
        return PerceptionResult(
            self.tier, selection.tag_id, selection.confidence, evidence,
            reasoning=selection.reasoning, rejected=selection.rejected,
            latency_ms=completion.total_ms, model=completion.model)


@dataclass
class LadderOutcome:
    result: PerceptionResult
    #: Every rung that was attempted, in order, with its latency.
    attempts: list[tuple[str, float, bool]] = field(default_factory=list)
    #: Wall time across the whole ladder, including handoffs (phase 143).
    total_ms: float = 0.0

    @property
    def handoff_ms(self) -> float:
        """Time spent on rungs that did not produce the answer.

        Phase 143 asks whether escalation introduces a visible stall; this
        is the number that answers it.
        """
        failed = sum(ms for _, ms, ok in self.attempts if not ok)
        return failed


class PerceptionLadder:
    """Phase 70 -- the four rungs, tried in order, exactly once each."""

    def __init__(self, providers: list[PerceptionProvider]):
        if not providers:
            raise ValueError("the ladder needs at least one rung")
        self.providers = providers

    def resolve(self, request: PerceptionRequest, *,
                start_tier: PerceptionTier | None = None) -> LadderOutcome:
        """Walk down the ladder until a rung grounds the action.

        `start_tier` lets the router skip rungs it knows cannot help -- the
        DOM rung is pointless on a canvas widget (phase 40).
        """
        started = time.perf_counter()
        outcome = LadderOutcome(result=PerceptionResult(
            PerceptionTier.EXPLAINED_FAILURE, None, 0.0, None))
        skipping = start_tier is not None
        last_reason = "no perception rung was attempted"

        for provider in self.providers:
            if skipping:
                if provider.tier is not start_tier:
                    continue
                skipping = False
            result = provider.resolve(request)
            grounded = result.grounded
            outcome.attempts.append(
                (provider.tier.value, result.latency_ms, grounded))
            if grounded:
                outcome.result = result
                outcome.total_ms = (time.perf_counter() - started) * 1000.0
                return outcome
            last_reason = result.reasoning or last_reason

        # Rung 4: an explained failure, which is still an answer the UI can
        # render and the audit log can record.
        outcome.result = PerceptionResult(
            PerceptionTier.EXPLAINED_FAILURE, None, 0.0,
            Evidence(tier=PerceptionTier.EXPLAINED_FAILURE,
                     reason=f"could not ground this action: {last_reason}"),
            reasoning=last_reason)
        outcome.total_ms = (time.perf_counter() - started) * 1000.0
        return outcome


def require_evidence(result: PerceptionResult) -> Evidence:
    """Phase 55 -- the enforcement point. No evidence, no action."""
    if result.evidence is None:
        raise EvidenceMissing(
            f"{result.tier.value} produced a selection with no evidence "
            f"record; refusing to act")
    return result.evidence
