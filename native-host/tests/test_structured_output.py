"""Phase 142 -- structured-output validation against malformed edge cases.

The schema validator is the single boundary where model text becomes a
typed object, so it is the single place where a broken local model can be
stopped. These cases are the ways small quantized models actually fail in
practice, not hypothetical ones.
"""
from __future__ import annotations

import pytest

from voicc_host.errors import InvalidModelOutput
from voicc_host.schemas import (Action, ActionType, DraftProposal, Element,
                                PageState, Plan, VisionSelection,
                                extract_json_object, parse_model_output,
                                validate_plan_against_page)

GOOD = ('{"actions":[{"type":"click","tag_id":3,"intent":"Submit"}],'
        '"confidence":0.9}')


# -- malformed input -------------------------------------------------------

@pytest.mark.parametrize("raw,why", [
    ("", "empty response"),
    ("   \n  ", "whitespace only"),
    ("I think you should click Submit.", "prose with no JSON"),
    ("{", "unterminated object"),
    ('{"actions":[{"type":"click","tag_id":3}', "truncated mid-stream"),
    ('{"actions":[{"type":"click","tag_id":3,}],"confidence":0.9}',
     "trailing comma"),
    ("[1,2,3]", "array instead of object"),
    ('"just a string"', "bare JSON string"),
    ("null", "JSON null"),
    ('{"actions":[],"confidence":0.9}', "empty action list"),
    ('{"confidence":0.9}', "missing actions"),
    ('{"actions":[{"type":"click","tag_id":3,"intent":"Go"}]}',
     "missing confidence"),
    ('{"actions":[{"type":"teleport","tag_id":3}],"confidence":0.9}',
     "unknown action type"),
    ('{"actions":[{"type":"click","tag_id":3,"intent":"Go"}],'
     '"confidence":1.7}', "confidence above 1"),
    ('{"actions":[{"type":"click","tag_id":3,"intent":"Go"}],'
     '"confidence":-0.2}', "negative confidence"),
    ('{"actions":[{"type":"click","tag_id":-1,"intent":"Go"}],'
     '"confidence":0.9}', "negative tag id"),
    ('{"actions":[{"type":"click","tag_id":99999,"intent":"Go"}],'
     '"confidence":0.9}', "tag id out of range"),
    ('{"actions":[{"type":"click","intent":"Go"}],"confidence":0.9}',
     "click with no target"),
    ('{"actions":[{"type":"type","tag_id":3}],"confidence":0.9}',
     "type with no value"),
    ('{"actions":[{"type":"click","tag_id":3}],"confidence":0.9}',
     "guarded action with no stated intent"),
    ('{"actions":[{"type":"click","tag_id":3,"intent":"Go","x":40,"y":12}],'
     '"confidence":0.9}', "extra coordinate fields"),
    ('{"actions":[{"type":"click","tag_id":3,"intent":"click at x=440"}],'
     '"confidence":0.9}', "coordinates smuggled into intent"),
    ('{"actions":[{"type":"click","tag_id":"three","intent":"Go"}],'
     '"confidence":0.9}', "tag id as a word"),
])
def test_malformed_output_is_rejected(raw: str, why: str) -> None:
    with pytest.raises(InvalidModelOutput):
        parse_model_output(raw, Plan)


def test_every_rejection_explains_itself() -> None:
    """A rejection the operator cannot read is a rejection they cannot fix."""
    with pytest.raises(InvalidModelOutput) as caught:
        parse_model_output('{"actions":[{"type":"click"}],"confidence":0.9}',
                           Plan)
    detail = str(caught.value)
    assert "Plan" in detail and "tag_id" in detail


# -- tolerated wrapping ----------------------------------------------------

@pytest.mark.parametrize("raw", [
    GOOD,
    f"```json\n{GOOD}\n```",
    f"```\n{GOOD}\n```",
    f"Here is the plan:\n{GOOD}",
    f"{GOOD}\n\nLet me know if that works!",
    f"Sure.\n```json\n{GOOD}\n```\nThat clicks Submit.",
    f"  \n {GOOD} \n ",
])
def test_prose_and_fences_are_tolerated(raw: str) -> None:
    plan = parse_model_output(raw, Plan)
    assert plan.actions[0].tag_id == 3


def test_nested_braces_inside_strings_do_not_confuse_the_extractor() -> None:
    raw = ('{"actions":[{"type":"type","tag_id":2,"value":"{\\"a\\":1}"}],'
           '"confidence":0.8}')
    plan = parse_model_output(raw, Plan)
    assert plan.actions[0].value == '{"a":1}'


def test_extractor_finds_the_first_complete_object() -> None:
    assert extract_json_object('noise {"a":{"b":2}} tail') == '{"a":{"b":2}}'


# -- grounding -------------------------------------------------------------

@pytest.fixture()
def page() -> PageState:
    return PageState(elements=[
        Element(tag_id=1, role="button", text="Submit"),
        Element(tag_id=2, role="input", placeholder="Name"),
        Element(tag_id=3, role="button", text="Cancel", enabled=False),
    ])


def test_invented_tag_id_is_rejected(page: PageState) -> None:
    plan = parse_model_output(
        '{"actions":[{"type":"click","tag_id":9,"intent":"Submit"}],'
        '"confidence":0.95}', Plan)
    with pytest.raises(InvalidModelOutput, match="not on the page"):
        validate_plan_against_page(plan, page)


def test_disabled_element_is_rejected(page: PageState) -> None:
    plan = parse_model_output(
        '{"actions":[{"type":"click","tag_id":3,"intent":"Cancel"}],'
        '"confidence":0.95}', Plan)
    with pytest.raises(InvalidModelOutput, match="disabled"):
        validate_plan_against_page(plan, page)


def test_valid_plan_passes_grounding(page: PageState) -> None:
    plan = parse_model_output(
        '{"actions":[{"type":"type","tag_id":2,"value":"Ramesh"},'
        '{"type":"click","tag_id":1,"intent":"Submit"}],'
        '"confidence":0.9}', Plan)
    validate_plan_against_page(plan, page)      # must not raise


# -- the other schemas -----------------------------------------------------

def test_draft_proposal_requires_a_plan() -> None:
    with pytest.raises(InvalidModelOutput):
        parse_model_output('{"ambiguous":true}', DraftProposal)


def test_vision_selection_rejects_prose_confidence() -> None:
    with pytest.raises(InvalidModelOutput):
        parse_model_output('{"tag_id":2,"confidence":"high"}',
                           VisionSelection)


def test_scroll_and_done_need_no_target() -> None:
    assert Action(type=ActionType.SCROLL).tag_id is None
    assert Action(type=ActionType.DONE).tag_id is None


def test_plan_split_caps_length_and_keeps_the_tail() -> None:
    plan = parse_model_output(
        '{"actions":[' + ",".join(
            f'{{"type":"click","tag_id":{i},"intent":"Submit"}}'
            for i in range(1, 8)) + '],"confidence":0.9}', Plan)
    head, tail = plan.split_at(5)
    assert len(head) == 5 and tail is not None and len(tail) == 2
    assert head.actions[0].tag_id == 1 and tail.actions[0].tag_id == 6


def test_split_below_cap_returns_no_tail() -> None:
    head, tail = parse_model_output(GOOD, Plan).split_at(5)
    assert len(head) == 1 and tail is None
