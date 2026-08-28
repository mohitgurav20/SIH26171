"""Draft-model speculative planning (phases 31, 47, 80, 143).

The bet, borrowed from speculative decoding: a ~0.5B model proposes a plan
in a fraction of the time the 3B model needs, and is right often enough
that the *average* cost per action drops -- even though an ambiguous page
costs more than it would have (draft attempt, then full escalation).

That bet only pays if two things hold, and both are enforced here:

  * The draft prompt stays minimal. `build_draft_prompt` gets the task and
    the element list, nothing else. Adding memory or evidence rules to it
    would make it a slightly cheaper full model, which is the failure mode.

  * Escalation is cheap and eager. A draft plan is accepted only when it
    parses, grounds against real page state, and clears the confidence bar.
    Anything else escalates immediately rather than being repaired -- a
    repair round-trip costs more than the escalation it is avoiding.

Acceptance rate is recorded because it is the number that decides whether
the draft model earns its place at all: below roughly 50%, the escalations
cost more than the fast path saves, and phase 82 should drop it.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum

from .config import CONFIG, Config
from .errors import InvalidModelOutput, VoiccError
from .ollama_client import Completion, OllamaClient, PrefixSession
from .prompts import build_draft_prompt
from .schemas import (DraftProposal, PageState, Plan, json_schema_for,
                      parse_model_output, validate_plan_against_page)


class EscalationReason(str, Enum):
    NONE = "none"
    LOW_CONFIDENCE = "low_confidence"
    SELF_REPORTED_AMBIGUOUS = "self_reported_ambiguous"
    INVALID_OUTPUT = "invalid_output"
    UNGROUNDED = "ungrounded"
    OPAQUE_REGION = "opaque_region"
    NO_ELEMENTS = "no_elements"
    BACKEND_ERROR = "backend_error"


@dataclass
class DraftResult:
    plan: Plan | None
    escalate: bool
    reason: EscalationReason
    detail: str = ""
    latency_ms: float = 0.0
    ttft_ms: float = 0.0
    confidence: float = 0.0
    model: str = ""

    @property
    def accepted(self) -> bool:
        return self.plan is not None and not self.escalate


@dataclass
class DraftStats:
    """Running acceptance/latency tally (feeds phases 80 and 143)."""

    attempts: int = 0
    accepted: int = 0
    escalations: dict[str, int] = field(default_factory=dict)
    draft_latencies_ms: list[float] = field(default_factory=list)

    def record(self, result: DraftResult) -> None:
        self.attempts += 1
        self.draft_latencies_ms.append(result.latency_ms)
        if result.accepted:
            self.accepted += 1
        else:
            key = result.reason.value
            self.escalations[key] = self.escalations.get(key, 0) + 1

    @property
    def acceptance_rate(self) -> float:
        return self.accepted / self.attempts if self.attempts else 0.0

    @property
    def mean_draft_ms(self) -> float:
        values = self.draft_latencies_ms
        return sum(values) / len(values) if values else 0.0

    def summary(self) -> dict:
        return {
            "attempts": self.attempts,
            "accepted": self.accepted,
            "acceptance_rate": round(self.acceptance_rate, 4),
            "mean_draft_ms": round(self.mean_draft_ms, 2),
            "escalations": dict(self.escalations),
        }


class DraftPlanner:
    def __init__(self, client: OllamaClient, config: Config | None = None):
        self.client = client
        self.config = config or CONFIG
        self.stats = DraftStats()
        self._schema = json_schema_for(DraftProposal)

    def propose(self, task: str, page: PageState, *,
                session: PrefixSession | None = None) -> DraftResult:
        """Run the fast first pass. Never raises for model-quality problems.

        A draft failure is a routing decision, not an error: the caller
        escalates. Only a dead backend propagates, because that is not
        something escalation can fix.
        """
        model = self.client.model_for("draft")

        if not page.elements:
            result = DraftResult(
                None, True, EscalationReason.NO_ELEMENTS,
                "no interactive elements in the filtered DOM", model=model)
            self.stats.record(result)
            return result

        prompt = build_draft_prompt(task, page)
        started = time.perf_counter()
        try:
            completion: Completion = self.client.generate(
                "draft", prompt.text, system=prompt.system,
                schema=self._schema, session=session)
        except VoiccError as exc:
            elapsed = (time.perf_counter() - started) * 1000.0
            result = DraftResult(
                None, True, EscalationReason.BACKEND_ERROR, str(exc),
                latency_ms=elapsed, model=model)
            self.stats.record(result)
            if exc.code == "backend_unavailable":
                raise            # escalation cannot fix a dead server
            return result

        latency_ms = completion.total_ms
        try:
            proposal: DraftProposal = parse_model_output(
                completion.text, DraftProposal)
        except InvalidModelOutput as exc:
            result = DraftResult(
                None, True, EscalationReason.INVALID_OUTPUT, str(exc),
                latency_ms=latency_ms, ttft_ms=completion.ttft_ms, model=model)
            self.stats.record(result)
            return result

        plan = proposal.plan
        try:
            validate_plan_against_page(plan, page)
        except InvalidModelOutput as exc:
            result = DraftResult(
                None, True, EscalationReason.UNGROUNDED, str(exc),
                latency_ms=latency_ms, ttft_ms=completion.ttft_ms,
                confidence=plan.confidence, model=model)
            self.stats.record(result)
            return result

        reason, detail = self._escalation_reason(proposal, page)
        result = DraftResult(
            plan=plan,
            escalate=reason is not EscalationReason.NONE,
            reason=reason, detail=detail, latency_ms=latency_ms,
            ttft_ms=completion.ttft_ms, confidence=plan.confidence,
            model=model)
        self.stats.record(result)
        return result

    def _escalation_reason(self, proposal: DraftProposal,
                           page: PageState) -> tuple[EscalationReason, str]:
        """Phase 47 -- the escalation trigger, in one readable place."""
        plan = proposal.plan

        if proposal.ambiguous:
            # The draft model saying it is unsure is the cheapest and most
            # reliable signal available; trust it over its own confidence.
            return (EscalationReason.SELF_REPORTED_AMBIGUOUS,
                    "draft model reported the layout as ambiguous")

        if plan.confidence < self.config.loop.draft_accept_confidence:
            return (EscalationReason.LOW_CONFIDENCE,
                    f"draft confidence {plan.confidence:.2f} below "
                    f"{self.config.loop.draft_accept_confidence:.2f}")

        if page.has_opaque_regions and not plan.references():
            # The page has content the DOM filter cannot describe and the
            # draft chose to act on nothing in it. That is exactly the
            # canvas-widget case vision exists for.
            return (EscalationReason.OPAQUE_REGION,
                    "page has non-DOM regions and the draft plan does not "
                    "target any element")

        return EscalationReason.NONE, ""


def average_cost_per_action(stats: DraftStats, *, draft_ms: float,
                            full_ms: float) -> dict:
    """Phase 80's arithmetic, made explicit rather than assumed.

    With acceptance rate p, the average cost per action is:

        p * draft_ms  +  (1 - p) * (draft_ms + full_ms)
        = draft_ms + (1 - p) * full_ms

    The draft model is worth keeping only while that is below full_ms,
    i.e. while p > draft_ms / full_ms.
    """
    p = stats.acceptance_rate
    with_draft = draft_ms + (1.0 - p) * full_ms
    breakeven = draft_ms / full_ms if full_ms else 1.0
    return {
        "acceptance_rate": round(p, 4),
        "mean_ms_with_draft": round(with_draft, 2),
        "mean_ms_without_draft": round(full_ms, 2),
        "saved_ms_per_action": round(full_ms - with_draft, 2),
        "breakeven_acceptance_rate": round(breakeven, 4),
        "worth_keeping": p > breakeven,
    }
