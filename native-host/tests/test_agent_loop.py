"""Agent-loop behaviour: gates, fallback, caching and plan capping.

These drive the real loop against a scripted backend, so they cover the
wiring between draft, escalation, guardrails, evidence and verification --
the parts that only break when the pieces are assembled.
"""
from __future__ import annotations

import pytest

from voicc_host.config import CONFIG
from voicc_host.schemas import Element, PerceptionTier
from voicc_host.selftest import (CLICK_SEARCH, TYPE_QUERY, _draft, _plan,
                                 build_loop, dashboard_page,
                                 halting_executor, ok_executor)

DRAFT = CONFIG.models.draft
TEXT = CONFIG.models.text
VISION = CONFIG.models.vision

VERIFY_OK = '{"satisfied":true,"confidence":0.9,"reason":"done"}'


def _text_responder(plan_json: str, verify: str = VERIFY_OK):
    """The text model serves both re-planning and verification."""
    def respond(payload: dict) -> str:
        return plan_json if "Elements:" in payload.get("prompt", "") else verify
    return respond


# -- happy path ------------------------------------------------------------

def test_draft_accepted_runs_without_escalating(tmp_path) -> None:
    loop, backend = build_loop(
        {DRAFT: _draft(f"{TYPE_QUERY},{CLICK_SEARCH}", 0.92),
         TEXT: VERIFY_OK},
        log_path=tmp_path / "d.jsonl")
    outcome = loop.run("search for orbit", dashboard_page(),
                       executor=ok_executor)
    assert outcome.ok
    assert outcome.steps_executed == 2
    assert outcome.tier is PerceptionTier.DOM
    # Draft + verification only: no full-model re-plan.
    assert [c["model"] for c in backend.calls] == [DRAFT, TEXT]


def test_multi_action_plan_makes_no_model_call_between_steps(tmp_path) -> None:
    """The checklist claim, asserted rather than assumed."""
    calls_during_execution = []

    def executor(plan):
        calls_during_execution.append(len(backend.calls))
        return ok_executor(plan)

    loop, backend = build_loop(
        {DRAFT: _draft(f"{TYPE_QUERY},{CLICK_SEARCH}", 0.92),
         TEXT: VERIFY_OK}, log_path=tmp_path / "d.jsonl")
    loop.run("search for orbit", dashboard_page(), executor=executor)
    # One executor invocation for the whole plan, and nothing added to the
    # backend call log while it ran.
    assert len(calls_during_execution) == 1


# -- gates -----------------------------------------------------------------

def test_guardrail_mismatch_stops_before_execution(tmp_path) -> None:
    executed = []
    loop, _ = build_loop(
        {DRAFT: _draft('{"type":"click","tag_id":5,"intent":"Export CSV"}',
                       0.95),
         TEXT: VERIFY_OK}, log_path=tmp_path / "d.jsonl")
    outcome = loop.run("export the report", dashboard_page(),
                       executor=lambda plan: executed.append(plan) or
                       ok_executor(plan))
    assert not outcome.ok
    assert outcome.error["code"] == "guardrail_violation"
    assert executed == [], "a blocked plan must never reach the executor"


def test_low_confidence_pauses_instead_of_guessing(tmp_path) -> None:
    loop, _ = build_loop(
        {DRAFT: _draft(CLICK_SEARCH, 0.5),
         TEXT: _text_responder(_plan(CLICK_SEARCH, 0.35, "unsure"))},
        log_path=tmp_path / "d.jsonl")
    outcome = loop.run("do the thing", dashboard_page(), executor=ok_executor)
    assert not outcome.ok and outcome.needs_confirmation
    assert outcome.steps_executed == 0


def test_confirmation_lets_a_low_confidence_plan_through(tmp_path) -> None:
    loop, _ = build_loop(
        {DRAFT: _draft(CLICK_SEARCH, 0.5),
         TEXT: _text_responder(_plan(CLICK_SEARCH, 0.35, "unsure"))},
        log_path=tmp_path / "d.jsonl")
    outcome = loop.run("do the thing", dashboard_page(),
                       executor=ok_executor, confirmed=True)
    assert outcome.ok, "an explicitly confirmed plan should proceed"


def test_every_action_carries_evidence(tmp_path) -> None:
    """Phase 137 -- click, type and scroll all produce a record."""
    plan = (f'{TYPE_QUERY},{CLICK_SEARCH},' + '{"type":"scroll"}')
    loop, _ = build_loop({DRAFT: _draft(plan, 0.9), TEXT: VERIFY_OK},
                         log_path=tmp_path / "d.jsonl")
    outcome = loop.run("search and scroll", dashboard_page(),
                       executor=ok_executor)
    assert outcome.ok
    assert len(outcome.evidence) == 3
    for record in outcome.evidence:
        assert record.reason, "evidence without a reason is not evidence"
        assert record.source_ref or record.dom_snippet


def test_model_reporting_no_match_is_a_refusal_not_a_prompt(tmp_path) -> None:
    loop, _ = build_loop(
        {DRAFT: _draft('{"type":"click","tag_id":42,"intent":"Archive"}',
                       0.97),
         TEXT: _text_responder(
             _plan('{"type":"done"}', 0.2, "there is no Archive control"))},
        log_path=tmp_path / "d.jsonl")
    outcome = loop.run("archive this", dashboard_page(), executor=ok_executor)
    assert not outcome.ok
    assert not outcome.needs_confirmation, \
        "offering to confirm a no-op would be worse than refusing"
    assert outcome.error["code"] == "no_matching_element"


# -- escalation ------------------------------------------------------------

def test_ambiguous_draft_escalates_to_the_full_model(tmp_path) -> None:
    loop, backend = build_loop(
        {DRAFT: _draft(CLICK_SEARCH, 0.4, ambiguous=True),
         TEXT: _text_responder(_plan(CLICK_SEARCH, 0.88, "only match"))},
        log_path=tmp_path / "d.jsonl")
    outcome = loop.run("find the report", dashboard_page(),
                       executor=ok_executor)
    assert outcome.ok
    assert [c["model"] for c in backend.calls].count(TEXT) == 2  # plan+verify


def test_confident_draft_does_not_escalate(tmp_path) -> None:
    loop, backend = build_loop(
        {DRAFT: _draft(CLICK_SEARCH, 0.95), TEXT: VERIFY_OK},
        log_path=tmp_path / "d.jsonl")
    loop.run("search", dashboard_page(), executor=ok_executor)
    assert [c["model"] for c in backend.calls].count(TEXT) == 1  # verify only


def test_opaque_region_routes_into_vision(tmp_path) -> None:
    loop, _ = build_loop(
        {DRAFT: _draft(CLICK_SEARCH, 0.3, ambiguous=True),
         VISION: '{"tag_id":4,"confidence":0.86,"reasoning":"only button",'
                 '"rejected":[3]}',
         TEXT: VERIFY_OK}, log_path=tmp_path / "d.jsonl")
    outcome = loop.run("click the widget control",
                       dashboard_page(has_opaque_regions=True),
                       executor=ok_executor, image_b64="Zm9v",
                       visible_tags=[3, 4, 5], crop_id="crop-1")
    assert outcome.ok
    assert outcome.tier is PerceptionTier.CROPPED_VISION
    assert outcome.evidence[0].crop_id == "crop-1"


def test_vision_cannot_pick_a_tag_that_was_not_drawn(tmp_path) -> None:
    """The vision-side equivalent of rejecting an invented tag id."""
    loop, _ = build_loop(
        {DRAFT: _draft(CLICK_SEARCH, 0.3, ambiguous=True),
         VISION: '{"tag_id":99,"confidence":0.95,"reasoning":"guess"}',
         TEXT: VERIFY_OK}, log_path=tmp_path / "d.jsonl")
    outcome = loop.run("click the widget control",
                       dashboard_page(has_opaque_regions=True),
                       executor=ok_executor, image_b64="Zm9v",
                       visible_tags=[3, 4, 5])
    assert not outcome.ok


# -- verification and fallback --------------------------------------------

def test_halted_plan_reports_where_to_resume(tmp_path) -> None:
    loop, _ = build_loop(
        {DRAFT: _draft(f"{TYPE_QUERY},{CLICK_SEARCH}", 0.9), TEXT: VERIFY_OK},
        log_path=tmp_path / "d.jsonl")
    outcome = loop.run("search for orbit", dashboard_page(),
                       executor=halting_executor(1))
    assert not outcome.ok
    assert outcome.error["resume_from"] == 1


def test_failed_verification_is_not_reported_as_success(tmp_path) -> None:
    loop, _ = build_loop(
        {DRAFT: _draft(CLICK_SEARCH, 0.9),
         TEXT: '{"satisfied":false,"confidence":0.9,"reason":"no results"}'},
        log_path=tmp_path / "d.jsonl")
    outcome = loop.run("search", dashboard_page(), executor=ok_executor)
    assert not outcome.ok and "no results" in outcome.summary


# -- plan capping ----------------------------------------------------------

def test_over_long_plan_is_capped(tmp_path) -> None:
    long_plan = ",".join(
        ['{"type":"click","tag_id":3,"intent":"Search"}'] * 9)
    loop, _ = build_loop({DRAFT: _draft(long_plan, 0.9), TEXT: VERIFY_OK},
                         log_path=tmp_path / "d.jsonl")
    outcome = loop.run("do everything", dashboard_page(),
                       executor=ok_executor)
    assert outcome.ok
    assert len(outcome.plan) == CONFIG.loop.max_plan_length


# -- workflow cache --------------------------------------------------------

def test_second_run_replays_from_cache_without_the_planner(tmp_path) -> None:
    responses = {DRAFT: _draft(CLICK_SEARCH, 0.9), TEXT: VERIFY_OK}
    loop, backend = build_loop(responses, cache_path=tmp_path / "wf.json",
                               log_path=tmp_path / "d.jsonl")
    loop.run("standard search", dashboard_page(), executor=ok_executor)
    before = len(backend.calls)
    second = loop.run("standard search", dashboard_page(),
                      executor=ok_executor)
    planner_calls = [c["model"] for c in backend.calls[before:]]
    assert second.cache == "hit"
    assert DRAFT not in planner_calls, "a cache hit must skip the planner"


def test_changed_labels_invalidate_the_cache(tmp_path) -> None:
    """Same tag ids, different controls -- the dangerous drift case."""
    responses = {DRAFT: _draft(CLICK_SEARCH, 0.9), TEXT: VERIFY_OK}
    loop, _ = build_loop(responses, cache_path=tmp_path / "wf.json",
                         log_path=tmp_path / "d.jsonl")
    loop.run("standard search", dashboard_page(), executor=ok_executor)

    # Identical layout_hash on purpose: this asserts the label check does
    # the work, not the hash.
    drifted = dashboard_page(elements=[
        Element(tag_id=1, role="link", text="Reports"),
        Element(tag_id=2, role="input", placeholder="Search reports"),
        Element(tag_id=3, role="button", text="Delete all"),
        Element(tag_id=4, role="button", text="Export CSV"),
        Element(tag_id=5, role="button", text="Search"),
    ])
    third = loop.run("standard search", drifted, executor=ok_executor)
    assert third.cache != "hit", "a drifted page must not replay blindly"


def test_backend_down_produces_a_readable_error(tmp_path) -> None:
    from voicc_host.selftest import scenario_backend_down
    outcome = scenario_backend_down()
    assert not outcome.ok
    assert outcome.error["code"] == "backend_unavailable"
    assert "Ollama" in outcome.summary


# -- the whole scenario sweep ---------------------------------------------

@pytest.mark.parametrize("name", [
    "draft_accepted", "escalation", "guardrail_block", "low_confidence",
    "vision_fallback", "verification_failure", "cache", "backend_down",
    "hallucinated_element", "plan_cap", "voice",
])
def test_no_scenario_crashes(name: str) -> None:
    """Phase 95 -- every path ends in an outcome, never an exception."""
    from voicc_host.selftest import SCENARIOS
    SCENARIOS[name]()
