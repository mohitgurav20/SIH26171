"""Per-plan verification and fallback (phase 48).

The point of multi-action plans is that no model call happens *between*
steps. Verification therefore happens once, after the whole plan, against
the end state -- not once per step, which would give back everything the
batching won.

When verification fails, the loop does not retry the same plan. It falls
back to single-step reasoning starting from the first step that did not
execute, which is why Mohit's executor reports exactly how far it got.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

from .errors import VoiccError
from .ollama_client import OllamaClient
from .prompts import build_verification_prompt
from .schemas import (PageState, Plan, VerificationResult, json_schema_for,
                      parse_model_output)


@dataclass
class ExecutionReport:
    """What Mohit's native executor sends back after running a plan.

    `completed` is the count of steps that actually fired. A plan that
    halted at step 2 reports completed=1, and the fallback resumes from
    index 1 rather than replaying the whole thing.
    """

    completed: int = 0
    failed_index: int | None = None
    failure: str = ""
    #: Human-readable description of each step that ran, for verification.
    executed: list[str] = field(default_factory=list)

    @property
    def halted(self) -> bool:
        return self.failed_index is not None

    @classmethod
    def from_message(cls, payload: dict) -> "ExecutionReport":
        return cls(
            completed=int(payload.get("completed", 0)),
            failed_index=payload.get("failed_index"),
            failure=str(payload.get("failure", "")),
            executed=[str(s) for s in payload.get("executed", [])],
        )


@dataclass
class Verification:
    result: VerificationResult
    latency_ms: float = 0.0
    #: True when the answer came from the deterministic check rather than
    #: from a model call -- worth knowing when reading the timing logs.
    deterministic: bool = False


class Verifier:
    def __init__(self, client: OllamaClient):
        self.client = client
        self._schema = json_schema_for(VerificationResult)

    def verify(self, task: str, plan: Plan, page_after: PageState,
               report: ExecutionReport) -> Verification:
        """Check the end state once.

        Two cheap deterministic answers come first, because a model call
        that can only confirm what is already certain is wasted latency.
        """
        started = time.perf_counter()

        if report.halted:
            return Verification(
                VerificationResult(
                    satisfied=False, confidence=1.0,
                    reason=f"execution halted at step "
                           f"{report.failed_index + 1}: {report.failure}"),
                latency_ms=(time.perf_counter() - started) * 1000.0,
                deterministic=True)

        if report.completed < len(plan):
            return Verification(
                VerificationResult(
                    satisfied=False, confidence=1.0,
                    reason=f"only {report.completed} of {len(plan)} steps ran"),
                latency_ms=(time.perf_counter() - started) * 1000.0,
                deterministic=True)

        prompt = build_verification_prompt(
            task, plan.expected_outcome, page_after, report.executed)
        try:
            completion = self.client.generate(
                "text", prompt.text, system=prompt.system,
                schema=self._schema)
            result: VerificationResult = parse_model_output(
                completion.text, VerificationResult)
            latency = completion.total_ms
        except VoiccError as exc:
            # An unverifiable outcome is treated as unverified, never as
            # success. Silent optimism here would be the worst possible
            # failure mode for an agent that clicks things.
            return Verification(
                VerificationResult(
                    satisfied=False, confidence=0.0,
                    reason=f"could not verify the end state: {exc}"),
                latency_ms=(time.perf_counter() - started) * 1000.0,
                deterministic=True)
        return Verification(result, latency_ms=latency)


def remaining_actions(plan: Plan, report: ExecutionReport) -> list:
    """The steps still owed after a partial execution."""
    return plan.actions[report.completed:]
