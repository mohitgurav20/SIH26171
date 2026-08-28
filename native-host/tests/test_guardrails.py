"""Phase 144 -- guardrail validation against non-obvious mismatches.

The obvious cases ("Submit" vs "Export") were never the risk. These tests
are built around the shape that actually defeats a similarity threshold:
the stated intent is a *prefix or subset* of the real label, so the two
strings look almost identical while the click does something different.
"""
from __future__ import annotations

import pytest

from voicc_host.errors import GuardrailViolation
from voicc_host.guardrails import (check_action, check_plan,
                                   compare_intent_to_label, first_violation)
from voicc_host.schemas import Action, ActionType, Element, PageState


# -- the subtle cases ------------------------------------------------------

@pytest.mark.parametrize("intent,label", [
    ("Confirm", "Confirm Cancel"),
    ("Confirm", "Confirm and delete"),
    ("Save", "Save and delete drafts"),
    ("Delete", "Delete all"),
    ("Delete row", "Delete all rows"),
    ("Send message", "Send message to everyone"),
    ("Pay now", "Pay now and subscribe"),
    ("Submit", "Submit and close account"),
    ("Approve", "Approve permanently"),
    ("Share", "Share publicly"),
    ("Export", "Export and clear"),
    ("Cancel", "Cancel subscription"),
])
def test_subset_intent_with_added_consequence_is_blocked(intent, label):
    verdict = compare_intent_to_label(intent, label)
    assert not verdict.allowed, f"{intent!r} vs {label!r} should not pass"
    # Either blocking route is acceptable -- a diverging consequential word
    # ("subtle") or too little overlap to trust ("mismatch"). What is not
    # acceptable is a block whose reason does not name what differs.
    assert verdict.kind in {"subtle", "mismatch"}
    assert verdict.divergent, "the blocking word should be named"


@pytest.mark.parametrize("intent,label", [
    ("Confirm", "Cancel"),
    ("Approve request", "Reject request"),
    ("Enable alerts", "Disable alerts"),
    ("Accept terms", "Decline terms"),
])
def test_opposites_are_blocked(intent, label):
    assert not compare_intent_to_label(intent, label).allowed


# -- the benign cases that must still pass ---------------------------------

@pytest.mark.parametrize("intent,label", [
    ("Submit", "Submit"),
    ("Submit", "Submit form"),
    ("Save changes", "Save changes now"),
    ("Open settings", "Open settings page"),
    ("Download report", "Download report file"),
    ("Search", "Search"),
    ("  submit  ", "Submit"),
    ("SUBMIT", "submit"),
])
def test_benign_elaboration_is_allowed(intent, label):
    verdict = compare_intent_to_label(intent, label)
    assert verdict.allowed, f"{intent!r} vs {label!r} was blocked: " \
                            f"{verdict.reason}"


def test_a_guardrail_that_blocks_everything_would_be_useless() -> None:
    """Sanity floor: the rule must not simply reject all inexact matches."""
    allowed = sum(compare_intent_to_label(i, l).allowed for i, l in [
        ("Submit", "Submit form"), ("Save changes", "Save changes now"),
        ("Open settings", "Open settings page"), ("Search", "Search"),
    ])
    assert allowed == 4


# -- missing and unverifiable labels ---------------------------------------

def test_unlabelled_element_cannot_be_confirmed_safe() -> None:
    verdict = compare_intent_to_label("Submit", "")
    assert not verdict.allowed and verdict.kind == "unlabelled"


def test_action_without_intent_is_blocked() -> None:
    verdict = compare_intent_to_label("", "Delete all")
    assert not verdict.allowed and verdict.kind == "no_intent"


# -- against real page state -----------------------------------------------

@pytest.fixture()
def page() -> PageState:
    return PageState(elements=[
        Element(tag_id=1, role="button", text="Export CSV"),
        Element(tag_id=2, role="button", text="Delete all"),
        Element(tag_id=3, role="input", placeholder="Search"),
        Element(tag_id=4, role="button", text="Submit", enabled=False),
        Element(tag_id=5, role="button", aria_label="Confirm Cancel"),
    ])


def test_hallucinated_target_is_blocked(page: PageState) -> None:
    action = Action(type=ActionType.CLICK, tag_id=77, intent="Export CSV")
    verdict = check_action(action, page)
    assert not verdict.allowed and verdict.kind == "hallucinated"


def test_disabled_target_is_blocked(page: PageState) -> None:
    action = Action(type=ActionType.CLICK, tag_id=4, intent="Submit")
    verdict = check_action(action, page)
    assert not verdict.allowed and verdict.kind == "disabled"


def test_aria_label_is_used_for_the_cross_check(page: PageState) -> None:
    """A button whose only label is an aria-label is still checkable."""
    action = Action(type=ActionType.CLICK, tag_id=5, intent="Confirm")
    verdict = check_action(action, page)
    assert not verdict.allowed and verdict.kind == "subtle"


def test_typing_is_not_gated(page: PageState) -> None:
    """`type` commits nothing, so gating it would add risk-free friction."""
    action = Action(type=ActionType.TYPE, tag_id=3, value="orbit")
    assert check_action(action, page).allowed


def test_scroll_is_not_gated(page: PageState) -> None:
    assert check_action(Action(type=ActionType.SCROLL), page).allowed


def test_whole_plan_is_checked_before_step_one_runs(page: PageState) -> None:
    """A plan that would be blocked at step 3 must not half-execute."""
    actions = [
        Action(type=ActionType.TYPE, tag_id=3, value="orbit"),
        Action(type=ActionType.CLICK, tag_id=1, intent="Export CSV"),
        Action(type=ActionType.CLICK, tag_id=2, intent="Export CSV"),
    ]
    verdicts = check_plan(actions, page)
    violation = first_violation(verdicts)
    assert violation is not None
    assert verdicts[0].allowed and verdicts[1].allowed
    assert violation.label == "Delete all"


def test_violation_raises_a_message_a_human_can_act_on(page: PageState) -> None:
    action = Action(type=ActionType.CLICK, tag_id=2, intent="Export CSV")
    with pytest.raises(GuardrailViolation) as caught:
        check_action(action, page).raise_if_blocked()
    message = caught.value.user_message
    assert "Export CSV" in message and "Delete all" in message
