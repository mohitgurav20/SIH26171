"""The agent loop: plan, act, verify (phases 14, 46-48, 57, 66, 79, 95, 157).

One turn of the loop, in order:

    0. workflow cache   a previously verified plan for this exact task and
                        an unchanged page replays with no model call at all
                        (phase 72), but only after the cache's own safety
                        checks pass (phase 79).
    1. draft            the 0.5B model proposes a plan from the filtered
                        element list (phase 31).
    2. escalate         if the draft is unsure, ungrounded or invalid, the
                        3B model re-plans; if the page has regions the DOM
                        cannot describe, perception climbs the ladder into
                        vision (phases 47, 70).
    3. gate             evidence must exist (55), guardrails must pass (65),
                        confidence must clear the floor (57). Any of these
                        stops the action rather than degrading it.
    4. act              the whole plan goes to the extension and runs with
                        no model call between steps (phase 44).
    5. verify           one end-state check (phase 48). On failure the loop
                        falls back to single-step reasoning from the first
                        step that did not run.

The loop never executes anything itself. It emits a plan for Mohit's native
executor and consumes the report that comes back, which keeps the DOM-facing
side in one place and makes this module testable without a browser.
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Callable

from .config import CONFIG, Config
from .decision_log import DecisionLogger
from .draft_planner import DraftPlanner, DraftResult, EscalationReason
from .errors import (EvidenceMissing, GuardrailViolation, InvalidModelOutput,
                     LowConfidence, VoiccError)
from .guardrails import GuardrailVerdict, check_plan, first_violation
from .ollama_client import OllamaClient, PrefixSession
from .perception import (LadderOutcome, PerceptionLadder, PerceptionRequest,
                         require_evidence)
from .prompts import build_reasoning_prompt, stable_prefix
from .schemas import (Action, ActionType, Decision, Evidence, PageState,
                      PerceptionTier, Plan, json_schema_for,
                      parse_model_output, validate_plan_against_page)
from .streaming import StreamingPlanCollector
from .verifier import ExecutionReport, Verifier
from .workflow_cache import CacheOutcome, WorkflowCache

#: Called by the loop to run a plan in the browser and report back.
Executor = Callable[[Plan], ExecutionReport]
#: Called by the loop to fetch current page state from the extension.
PageReader = Callable[[], PageState]
#: Called to stream progress frames to the UI.
Emitter = Callable[[dict], None]


@dataclass
class TaskOutcome:
    task_id: str
    ok: bool
    summary: str
    plan: Plan | None = None
    evidence: list[Evidence] = field(default_factory=list)
    #: What the user sees in the why-panel (phase 56).
    why: str = ""
    tier: PerceptionTier = PerceptionTier.DOM
    steps_executed: int = 0
    model_calls: int = 0
    cache: str = "miss"
    #: Set when the loop stopped for confirmation rather than failing.
    needs_confirmation: bool = False
    error: dict | None = None
    timings_ms: dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "task_id": self.task_id,
            "ok": self.ok,
            "summary": self.summary,
            "why": self.why,
            "tier": self.tier.value,
            "plan": self.plan.model_dump(mode="json") if self.plan else None,
            "evidence": [e.model_dump(mode="json") for e in self.evidence],
            "steps_executed": self.steps_executed,
            "model_calls": self.model_calls,
            "cache": self.cache,
            "needs_confirmation": self.needs_confirmation,
            "error": self.error,
            "timings_ms": {k: round(v, 2) for k, v in self.timings_ms.items()},
        }


class AgentLoop:
    def __init__(self, client: OllamaClient, *,
                 ladder: PerceptionLadder,
                 logger: DecisionLogger,
                 cache: WorkflowCache | None = None,
                 config: Config | None = None,
                 emit: Emitter | None = None):
        self.client = client
        self.config = config or CONFIG
        self.ladder = ladder
        self.logger = logger
        self.cache = cache or WorkflowCache()
        self.draft = DraftPlanner(client, self.config)
        self.verifier = Verifier(client)
        self.emit = emit or (lambda payload: None)
        self._plan_schema = json_schema_for(Plan)

    # ---------------------------------------------------------------- run

    def run(self, task: str, page: PageState, *,
            executor: Executor,
            read_page: PageReader | None = None,
            memories: list[str] | None = None,
            image_b64: str = "",
            visible_tags: list[int] | None = None,
            crop_id: str = "",
            confirmed: bool = False) -> TaskOutcome:
        """Run one command to completion. Never raises for expected failures.

        Everything the user could plausibly hit -- a blocked guardrail, a
        low-confidence pause, a dead backend -- comes back as a TaskOutcome
        with a readable summary. Phase 95's requirement is that no error
        path reaches the UI as a stack trace, and the way to guarantee that
        is to have exactly one place that converts exceptions into outcomes.
        """
        task_id = uuid.uuid4().hex[:12]
        started = time.perf_counter()
        timings: dict[str, float] = {}
        read_page = read_page or (lambda: page)

        try:
            outcome = self._run_inner(
                task_id, task, page, executor, read_page,
                memories or [], image_b64, visible_tags or [], crop_id,
                confirmed, timings)
        except LowConfidence as exc:
            outcome = self._paused(task_id, exc, timings)
        except (GuardrailViolation, EvidenceMissing) as exc:
            self.logger.event(
                "gate",
                Decision.BLOCKED_GUARDRAIL if isinstance(exc, GuardrailViolation)
                else Decision.BLOCKED_NO_EVIDENCE,
                task_id=task_id, detail=exc.detail)
            outcome = TaskOutcome(
                task_id, False, exc.user_message, why=exc.detail,
                error=exc.to_dict(), timings_ms=timings)
        except VoiccError as exc:
            self.logger.event("error", Decision.FAILED, task_id=task_id,
                              detail=f"{exc.code}: {exc.detail}")
            outcome = TaskOutcome(task_id, False, exc.user_message,
                                  why=exc.detail, error=exc.to_dict(),
                                  timings_ms=timings)
        except Exception as exc:                               # noqa: BLE001
            # Truly unexpected. Still not a stack trace in the UI.
            self.logger.event("error", Decision.FAILED, task_id=task_id,
                              detail=f"unhandled {type(exc).__name__}: {exc}")
            outcome = TaskOutcome(
                task_id, False,
                "Something went wrong inside the agent.",
                why=f"{type(exc).__name__}: {exc}",
                error={"code": "internal_error", "message": str(exc)},
                timings_ms=timings)

        timings["total"] = (time.perf_counter() - started) * 1000.0
        outcome.timings_ms = timings
        self.emit({"type": "task_complete", "task_id": task_id,
                   "outcome": outcome.to_dict()})
        return outcome

    def _paused(self, task_id: str, exc: LowConfidence,
                timings: dict) -> TaskOutcome:
        self.logger.event("gate", Decision.PAUSED_LOW_CONFIDENCE,
                          task_id=task_id, detail=exc.detail)
        return TaskOutcome(task_id, False, exc.user_message, why=exc.detail,
                           needs_confirmation=True, error=exc.to_dict(),
                           timings_ms=timings)

    # -------------------------------------------------------------- inner

    def _run_inner(self, task_id: str, task: str, page: PageState,
                   executor: Executor, read_page: PageReader,
                   memories: list[str], image_b64: str,
                   visible_tags: list[int], crop_id: str,
                   confirmed: bool, timings: dict) -> TaskOutcome:
        model_calls = 0
        tier = PerceptionTier.DOM
        evidence: list[Evidence] = []

        # -- 0. cached workflow -------------------------------------------
        decision = self.cache.lookup(task, page)
        if decision.replayable and decision.workflow is not None:
            plan = decision.workflow.to_plan()
            # A replay skips the model but not the gates: guardrails and
            # evidence still apply, because a cache hit is a claim about
            # the *page*, not a licence to click unchecked.
            verdicts = check_plan(plan.actions, page)
            violation = first_violation(verdicts)
            if violation is None:
                self.logger.event("cache", Decision.CACHE_HIT, task_id=task_id,
                                  detail=decision.reason)
                self.emit({"type": "cache", "task_id": task_id,
                           "state": "replaying", "reason": decision.reason})
                self.cache.note_replay(decision.workflow)
                evidence = [self._cache_evidence(action, page)
                            for action in plan.actions]
                return self._execute_and_verify(
                    task_id, task, plan, page, executor, read_page,
                    evidence, tier, model_calls, timings, cache="hit")
            self.cache.invalidate(task, page.url)
            self.logger.event("cache", Decision.CACHE_INVALIDATED,
                              task_id=task_id,
                              detail=f"guardrail rejected replay: "
                                     f"{violation.reason}")
        elif decision.outcome is not CacheOutcome.MISS:
            self.logger.event("cache", Decision.CACHE_INVALIDATED,
                              task_id=task_id, detail=decision.reason)
            self.emit({"type": "cache", "task_id": task_id,
                       "state": "invalidated", "reason": decision.reason})

        # -- 1. draft -----------------------------------------------------
        # Speculatively warm the full model now: if the draft escalates, its
        # load is already underway; if it does not, a background load was
        # the whole cost of being wrong (phase 109).
        self.client.warm_async(self.client.model_for("text"))

        draft_started = time.perf_counter()
        draft: DraftResult = self.draft.propose(task, page)
        timings["draft"] = draft.latency_ms
        model_calls += 1
        self.logger.event(
            "draft",
            Decision.ACCEPTED if draft.accepted else Decision.ESCALATED,
            task_id=task_id, model=draft.model, confidence=draft.confidence,
            latency_ms=draft.latency_ms,
            detail=draft.detail or draft.reason.value)

        plan = draft.plan
        if draft.accepted and plan is not None:
            why = f"draft model planned this directly ({draft.confidence:.2f})"
        else:
            # -- 2. escalate ----------------------------------------------
            self.emit({"type": "escalation", "task_id": task_id,
                       "reason": draft.reason.value})
            plan, tier, evidence, calls = self._escalate(
                task_id, task, page, memories, image_b64, visible_tags,
                crop_id, draft, timings)
            model_calls += calls
            why = (f"escalated from the draft model "
                   f"({draft.reason.value}); resolved by {tier.value}")
            timings["draft_to_full_handoff"] = (
                (time.perf_counter() - draft_started) * 1000.0
                - draft.latency_ms)

        if plan is None:
            raise InvalidModelOutput("no usable plan was produced")

        # -- 3. gates -----------------------------------------------------
        plan = self._cap_plan(task_id, plan)
        validate_plan_against_page(plan, page)

        if not evidence:
            evidence = [self._dom_evidence(action, page)
                        for action in plan.actions]
        for record in evidence:
            if record is None:
                raise EvidenceMissing("an action had no evidence record")

        # The prompts tell the model to answer "target not on this page" as
        # a lone `done` with low confidence. That is a refusal, not a
        # borderline action: asking "go ahead?" would offer to confirm a
        # no-op, so it is reported as an explained failure instead.
        if len(plan) == 1 and plan.actions[0].type is ActionType.DONE \
                and plan.confidence < self.config.loop.confidence_floor:
            self.logger.event("gate", Decision.BLOCKED_NO_EVIDENCE,
                              task_id=task_id, confidence=plan.confidence,
                              detail=plan.reasoning)
            return TaskOutcome(
                task_id, False,
                plan.reasoning or "I couldn't find that on this page.",
                plan=plan, evidence=evidence, tier=tier,
                model_calls=model_calls, cache="miss",
                why=f"the model reported no matching element "
                    f"({plan.confidence:.2f} confidence)",
                timings_ms=timings,
                error={"code": "no_matching_element",
                       "message": plan.reasoning
                       or "nothing on this page matches that command"})

        verdicts: list[GuardrailVerdict] = check_plan(plan.actions, page)
        violation = first_violation(verdicts)
        if violation is not None:
            violation.raise_if_blocked()

        if plan.confidence < self.config.loop.confidence_floor and not confirmed:
            raise LowConfidence(
                f"plan confidence {plan.confidence:.2f} is below the floor "
                f"{self.config.loop.confidence_floor:.2f}: {plan.reasoning}",
                user_message=(
                    f"I'm only {plan.confidence:.0%} sure about "
                    f"{plan.actions[0].intent or plan.actions[0].type.value}. "
                    f"Go ahead?"))

        self.logger.event("gate", Decision.ACCEPTED, task_id=task_id,
                          tier=tier, confidence=plan.confidence,
                          detail=why, evidence=evidence[0] if evidence else None)

        # -- 4 & 5. act and verify ----------------------------------------
        outcome = self._execute_and_verify(
            task_id, task, plan, page, executor, read_page, evidence, tier,
            model_calls, timings, cache="miss")
        outcome.why = why
        return outcome

    # ---------------------------------------------------------- escalation

    def _escalate(self, task_id: str, task: str, page: PageState,
                  memories: list[str], image_b64: str,
                  visible_tags: list[int], crop_id: str,
                  draft: DraftResult,
                  timings: dict) -> tuple[Plan | None, PerceptionTier,
                                          list[Evidence], int]:
        """Full-model re-plan, climbing into vision only when needed."""
        calls = 0
        needs_vision = draft.reason in (
            EscalationReason.OPAQUE_REGION, EscalationReason.NO_ELEMENTS
        ) or page.has_opaque_regions

        if needs_vision:
            self.client.warm_async(self.client.model_for("vision"))
            request = PerceptionRequest(
                task=task, page=page, image_b64=image_b64,
                visible_tags=visible_tags, crop_id=crop_id, memories=memories)
            ladder: LadderOutcome = self.ladder.resolve(
                request,
                start_tier=(PerceptionTier.CROPPED_VISION if image_b64
                            else None))
            timings["perception"] = ladder.total_ms
            timings["perception_handoff"] = ladder.handoff_ms
            calls += 1
            result = ladder.result
            self.logger.event(
                "perception",
                Decision.ACCEPTED if result.grounded else Decision.FAILED,
                task_id=task_id, tier=result.tier, model=result.model,
                confidence=result.confidence, latency_ms=result.latency_ms,
                detail=result.reasoning)

            if result.grounded and result.tag_id is not None:
                element = page.by_id(result.tag_id)
                evidence = require_evidence(result)
                plan = Plan(
                    actions=[Action(
                        type=ActionType.CLICK, tag_id=result.tag_id,
                        intent=element.label() if element else "")],
                    confidence=result.confidence,
                    reasoning=result.reasoning,
                    expected_outcome=f"the page responds to "
                                     f"{element.label() if element else 'it'}")
                return plan, result.tier, [evidence], calls

            if result.tier is PerceptionTier.EXPLAINED_FAILURE:
                raise EvidenceMissing(
                    result.reasoning or "nothing on the page grounds this",
                    user_message=(
                        "I couldn't find anything on this page that matches "
                        "that. Can you rephrase it?"))

        # Text re-plan with memory and evidence rules, streamed so step 1
        # can start validating before the tail finishes generating (108).
        prompt = build_reasoning_prompt(
            task, page, memories=memories,
            last_error=draft.detail if draft.reason in (
                EscalationReason.INVALID_OUTPUT,
                EscalationReason.UNGROUNDED) else "")
        session: PrefixSession = self.client.start_session(
            task_id, "text", stable_prefix(prompt))
        collector = StreamingPlanCollector(
            on_prefix=lambda event: self.emit({
                "type": "plan_prefix", "task_id": task_id,
                "index": event.index,
                "action": event.action.model_dump(mode="json")
                if event.action else None}))
        completion = self.client.generate(
            "text", prompt.text, system=prompt.system,
            schema=self._plan_schema, session=session,
            on_token=collector.on_token)
        stream = collector.finish(completion.text)
        calls += 1
        timings["full_text"] = completion.total_ms
        if stream.head_start_ms is not None:
            timings["stream_head_start"] = stream.head_start_ms

        plan: Plan = parse_model_output(completion.text, Plan)
        self.logger.event("replan", Decision.ACCEPTED, task_id=task_id,
                          model=completion.model, confidence=plan.confidence,
                          latency_ms=completion.total_ms,
                          detail=plan.reasoning,
                          stream_head_start_ms=stream.head_start_ms)
        return plan, PerceptionTier.DOM, [], calls

    # ------------------------------------------------------------- helpers

    def _cap_plan(self, task_id: str, plan: Plan) -> Plan:
        """Phase 157 -- split rather than trust an over-long speculative plan."""
        cap = self.config.loop.max_plan_length
        head, tail = plan.split_at(cap)
        if tail is not None:
            self.logger.event(
                "plan_cap", Decision.ACCEPTED, task_id=task_id,
                detail=f"plan of {len(plan)} actions capped at {cap}; "
                       f"{len(tail)} deferred to a re-verified batch")
            self.emit({"type": "plan_capped", "task_id": task_id,
                       "kept": len(head), "deferred": len(tail)})
        return head

    def _dom_evidence(self, action: Action, page: PageState) -> Evidence:
        """Phase 55/137 -- every action type gets a record, not just clicks."""
        if action.tag_id is None:
            return Evidence(
                tier=PerceptionTier.DOM,
                source_ref=f"page:{page.url or 'current'}",
                reason=f"{action.type.value} does not target a specific "
                       f"element",
                dom_snippet=page.title or page.url)
        element = page.by_id(action.tag_id)
        if element is None:
            raise EvidenceMissing(
                f"no element {action.tag_id} to justify {action.type.value}")
        return Evidence(
            tier=PerceptionTier.DOM, tag_id=action.tag_id,
            source_ref=element.label(),
            reason=f"{action.type.value} on element {action.tag_id}, "
                   f"labelled {element.label()!r} in the filtered DOM",
            dom_snippet=f"<{element.role}> {element.label()}")

    def _cache_evidence(self, action: Action, page: PageState) -> Evidence:
        evidence = self._dom_evidence(action, page)
        return evidence.model_copy(update={
            "reason": f"{evidence.reason} (replayed from a cached workflow "
                      f"whose layout and labels still match)"})

    def _execute_and_verify(self, task_id: str, task: str, plan: Plan,
                            page: PageState, executor: Executor,
                            read_page: PageReader, evidence: list[Evidence],
                            tier: PerceptionTier, model_calls: int,
                            timings: dict, *, cache: str) -> TaskOutcome:
        self.emit({"type": "plan", "task_id": task_id,
                   "plan": plan.model_dump(mode="json"), "cache": cache})

        act_started = time.perf_counter()
        report = executor(plan)
        timings["execute"] = (time.perf_counter() - act_started) * 1000.0
        self.logger.event(
            "execute",
            Decision.FAILED if report.halted else Decision.ACCEPTED,
            task_id=task_id, latency_ms=timings["execute"],
            detail=(f"{report.completed}/{len(plan)} steps"
                    + (f", halted: {report.failure}" if report.halted else "")))

        page_after = read_page()
        verification = self.verifier.verify(task, plan, page_after, report)
        timings["verify"] = verification.latency_ms
        if not verification.deterministic:
            model_calls += 1
        self.logger.event(
            "verify",
            Decision.ACCEPTED if verification.result.satisfied else Decision.FAILED,
            task_id=task_id, confidence=verification.result.confidence,
            latency_ms=verification.latency_ms,
            detail=verification.result.reason)

        if verification.result.satisfied:
            if cache != "hit":
                self.cache.record(task, page, plan)
            return TaskOutcome(
                task_id, True,
                plan.expected_outcome or "Done.",
                plan=plan, evidence=evidence, tier=tier,
                steps_executed=report.completed, model_calls=model_calls,
                cache=cache, timings_ms=timings)

        # Verification failed. The cached plan is now suspect: drop it
        # rather than letting the next run replay a flow that did not work.
        if cache == "hit":
            self.cache.invalidate(task, page.url)

        return TaskOutcome(
            task_id, False,
            f"That didn't complete: {verification.result.reason}",
            plan=plan, evidence=evidence, tier=tier,
            steps_executed=report.completed, model_calls=model_calls,
            cache=cache, why=verification.result.reason, timings_ms=timings,
            error={"code": "verification_failed",
                   "message": verification.result.reason,
                   "resume_from": report.completed})
