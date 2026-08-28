"""Wire schemas and structured-output enforcement (phases 30, 32, 142).

Two families live here:

  * The extension <-> host message contract (phase 5), including the
    multi-action plan shape agreed with Mohit (phase 32).
  * The model-output schemas. Every single model response is parsed through
    one of these before anything downstream touches it. A model that emits
    prose, a coordinate, or an out-of-range tag id is rejected here, not
    three layers later when something crashes.

Grounding rule (checklist): an action references a numbered tag id, never a
raw coordinate. `Action` has no x/y fields at all, so a coordinate-emitting
model fails validation by construction rather than by a runtime check.
"""
from __future__ import annotations

import json
import re
from enum import Enum
from typing import Annotated, Any

from pydantic import (BaseModel, ConfigDict, Field, ValidationError,
                      field_validator, model_validator)

from .errors import InvalidModelOutput

# --------------------------------------------------------------------------
# Shared enums
# --------------------------------------------------------------------------


class ActionType(str, Enum):
    CLICK = "click"
    TYPE = "type"
    SCROLL = "scroll"
    SELECT = "select"
    NAVIGATE = "navigate"
    WAIT_FOR = "wait_for"
    DONE = "done"


#: Actions that can destroy or commit data. Phase 39/65: these require the
#: chosen element's real label to be cross-checked against stated intent.
GUARDED_ACTIONS: frozenset[ActionType] = frozenset({
    ActionType.CLICK, ActionType.SELECT, ActionType.NAVIGATE,
})


class PerceptionTier(str, Enum):
    """Phase 70 -- the graceful-degradation ladder, in order."""

    DOM = "dom"
    CROPPED_VISION = "cropped_vision"
    FULL_PAGE_VISION = "full_page_vision"
    EXPLAINED_FAILURE = "explained_failure"


class Decision(str, Enum):
    ACCEPTED = "accepted"
    ESCALATED = "escalated"
    BLOCKED_GUARDRAIL = "blocked_guardrail"
    BLOCKED_NO_EVIDENCE = "blocked_no_evidence"
    PAUSED_LOW_CONFIDENCE = "paused_low_confidence"
    CACHE_HIT = "cache_hit"
    CACHE_INVALIDATED = "cache_invalidated"
    FAILED = "failed"


# --------------------------------------------------------------------------
# Page state (produced by Mohit's DOM filter, consumed here)
# --------------------------------------------------------------------------

TagId = Annotated[int, Field(ge=0, le=999)]


class Element(BaseModel):
    """One interactive element from the semantic DOM filter (phase 24/25)."""

    model_config = ConfigDict(extra="ignore")

    tag_id: TagId
    role: str = Field(default="", description="button, link, input, select")
    text: str = ""
    aria_label: str = ""
    name: str = ""
    value: str = ""
    placeholder: str = ""
    enabled: bool = True
    #: Coarse position bucket, not pixels -- the model must not learn to aim.
    region: str = ""

    def label(self) -> str:
        """The element's real, human-visible label.

        Guardrail validation compares stated intent against *this*, so the
        precedence order matters: visible text wins over aria-label, which
        wins over the accessible name, which wins over placeholder/value.
        """
        for candidate in (self.text, self.aria_label, self.name,
                          self.placeholder, self.value):
            cleaned = " ".join(candidate.split())
            if cleaned:
                return cleaned
        return ""


class PageState(BaseModel):
    """Compressed page snapshot the reasoning models actually see."""

    model_config = ConfigDict(extra="ignore")

    url: str = ""
    title: str = ""
    elements: list[Element] = Field(default_factory=list)
    #: Set by Mohit's diffing layer (phase 104): only these ids changed.
    changed_tag_ids: list[TagId] = Field(default_factory=list)
    #: True when the page has content the DOM filter cannot describe
    #: (canvas, image-only widgets) -- the vision router keys off this.
    has_opaque_regions: bool = False
    #: Structural fingerprint used for workflow-cache invalidation (79).
    layout_hash: str = ""
    dom_payload_bytes: int = 0
    raw_html_bytes: int = 0

    def by_id(self, tag_id: int) -> Element | None:
        for element in self.elements:
            if element.tag_id == tag_id:
                return element
        return None

    def tag_ids(self) -> set[int]:
        return {element.tag_id for element in self.elements}

    def payload_reduction(self) -> float | None:
        """Measured, not assumed (phase 24's done-condition)."""
        if not self.raw_html_bytes:
            return None
        return 1.0 - (self.dom_payload_bytes / self.raw_html_bytes)


# --------------------------------------------------------------------------
# Model output schemas
# --------------------------------------------------------------------------

_COORD_PATTERN = re.compile(
    r"\b(?:x|y|left|top|px|coordinate)s?\s*[=:]\s*-?\d", re.IGNORECASE)


class Action(BaseModel):
    """A single grounded action. Deliberately has no coordinate fields."""

    model_config = ConfigDict(extra="forbid")

    type: ActionType
    #: Which numbered tag this acts on. Absent only for scroll/navigate/done.
    tag_id: TagId | None = None
    #: Text to enter, for `type`; option label, for `select`.
    value: str = ""
    #: What the model believes it is acting on. Cross-checked by guardrails.
    intent: str = ""

    @field_validator("value", "intent")
    @classmethod
    def _no_coordinates(cls, v: str) -> str:
        if _COORD_PATTERN.search(v):
            raise ValueError(
                "coordinates are not a valid grounding, use a tag id")
        return v

    @model_validator(mode="after")
    def _target_required(self) -> "Action":
        needs_target = {ActionType.CLICK, ActionType.TYPE,
                        ActionType.SELECT, ActionType.WAIT_FOR}
        if self.type in needs_target and self.tag_id is None:
            raise ValueError(f"{self.type.value} requires a tag_id")
        if self.type is ActionType.TYPE and not self.value:
            raise ValueError("type action requires a value")
        if self.type in GUARDED_ACTIONS and self.tag_id is not None \
                and not self.intent:
            raise ValueError(
                f"{self.type.value} requires a stated intent for guardrails")
        return self


class Plan(BaseModel):
    """An ordered batch of actions executed with no model call between steps.

    Phase 44 executes this natively; phase 48 verifies once at the end;
    phase 157 caps its length.
    """

    model_config = ConfigDict(extra="forbid")

    actions: list[Action] = Field(min_length=1)
    #: The model's own confidence. Phase 47 escalates below the draft
    #: threshold; phase 57 pauses below the confidence floor.
    confidence: float = Field(ge=0.0, le=1.0)
    #: One line of why, shown in the why-panel (phase 56).
    reasoning: str = ""
    #: How the agent will know the plan worked (phase 48).
    expected_outcome: str = ""

    def __len__(self) -> int:
        return len(self.actions)

    def references(self) -> set[int]:
        return {a.tag_id for a in self.actions if a.tag_id is not None}

    def split_at(self, cap: int) -> tuple["Plan", "Plan | None"]:
        """Phase 157 -- split an over-long plan instead of refusing it.

        The head keeps the original confidence; the tail is re-planned
        against fresh page state before it runs, which is the whole point
        of capping.
        """
        if cap < 1:
            raise ValueError("cap must be at least 1")
        if len(self.actions) <= cap:
            return self, None
        head = self.model_copy(update={"actions": self.actions[:cap]})
        tail = self.model_copy(update={"actions": self.actions[cap:]})
        return head, tail


class DraftProposal(BaseModel):
    """What the ~0.5B draft model returns (phase 31).

    Its prompt is minimal on purpose, so its output schema is too -- a
    bloated schema costs tokens and defeats the speed win.
    """

    model_config = ConfigDict(extra="forbid")

    plan: Plan
    #: The draft model's own admission that the page is ambiguous. Phase 47
    #: escalates on this OR on low confidence, whichever fires first.
    ambiguous: bool = False


class VisionSelection(BaseModel):
    """What the vision model returns after seeing a numbered overlay."""

    model_config = ConfigDict(extra="forbid")

    tag_id: TagId
    confidence: float = Field(ge=0.0, le=1.0)
    reasoning: str = ""
    #: Which numbered tags were considered and rejected, for the why-panel.
    rejected: list[TagId] = Field(default_factory=list)


class VerificationResult(BaseModel):
    """Phase 48 -- one end-state check after a whole plan."""

    model_config = ConfigDict(extra="forbid")

    satisfied: bool
    confidence: float = Field(ge=0.0, le=1.0, default=1.0)
    reason: str = ""


# --------------------------------------------------------------------------
# Evidence and audit records
# --------------------------------------------------------------------------


class Evidence(BaseModel):
    """Proof-of-Perception (phase 55). No evidence, no action.

    Phase 137 requires this to be complete for click, type *and* scroll, so
    `source_ref` is whatever grounded the decision: a DOM element label or a
    vision crop id.
    """

    model_config = ConfigDict(extra="ignore")

    tier: PerceptionTier
    tag_id: TagId | None = None
    #: The element label or crop identifier that justified the action.
    source_ref: str = ""
    #: One-line human reason (phase 55/56).
    reason: str = ""
    crop_id: str = ""
    dom_snippet: str = ""

    @model_validator(mode="after")
    def _must_actually_prove_something(self) -> "Evidence":
        if self.tier is PerceptionTier.EXPLAINED_FAILURE:
            return self          # A failure explanation needs no source ref.
        if not (self.source_ref or self.crop_id or self.dom_snippet):
            raise ValueError("evidence record has no perceptual source")
        if not self.reason.strip():
            raise ValueError("evidence record has no stated reason")
        return self


class DecisionRecord(BaseModel):
    """Phase 81 -- one structured entry per agent decision point.

    Feeds Chinmay's hash-chained audit log (phase 51/71); the hash fields
    are added by the log writer, not by the reasoning code.
    """

    model_config = ConfigDict(extra="allow")

    task_id: str
    step: int
    stage: str
    decision: Decision
    model: str = ""
    tier: PerceptionTier | None = None
    confidence: float | None = None
    latency_ms: float | None = None
    detail: str = ""
    evidence: Evidence | None = None


# --------------------------------------------------------------------------
# Structured-output enforcement (phase 30)
# --------------------------------------------------------------------------

_FENCE = re.compile(r"`{3}(?:json)?\s*(.*?)\s*`{3}", re.DOTALL)


def extract_json_object(raw: str) -> str:
    """Pull the JSON object out of a model response.

    Small local models wrap JSON in prose or code fences far more often than
    hosted ones do. Being tolerant *here* -- at the single parse boundary --
    is what lets everything downstream be strict.
    """
    text = (raw or "").strip()
    if not text:
        raise InvalidModelOutput("model returned an empty response")
    fenced = _FENCE.search(text)
    if fenced:
        text = fenced.group(1).strip()
    if text.startswith("{") and text.endswith("}"):
        return text
    # Fall back to the first balanced object span, respecting string literals.
    start = text.find("{")
    if start == -1:
        raise InvalidModelOutput(f"no JSON object in response: {raw[:200]!r}")
    depth, in_string, escaped = 0, False, False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start:index + 1]
    raise InvalidModelOutput(f"unbalanced JSON in response: {raw[:200]!r}")


def parse_model_output(raw: str, model_cls: type[BaseModel]) -> Any:
    """Parse and validate one model response, or raise InvalidModelOutput.

    This is the only place model text becomes a typed object. Phase 142
    tests drive malformed input straight at this function.
    """
    payload = extract_json_object(raw)
    try:
        data = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise InvalidModelOutput(
            f"invalid JSON ({exc.msg} at char {exc.pos}): {payload[:200]!r}"
        ) from exc
    if not isinstance(data, dict):
        raise InvalidModelOutput(
            f"expected a JSON object, got {type(data).__name__}")
    try:
        return model_cls.model_validate(data)
    except ValidationError as exc:
        problems = "; ".join(
            f"{'.'.join(str(p) for p in e['loc']) or '<root>'}: {e['msg']}"
            for e in exc.errors()[:5]
        )
        raise InvalidModelOutput(
            f"{model_cls.__name__} validation failed: {problems}") from exc


def validate_plan_against_page(plan: Plan, page: PageState) -> None:
    """Reject plans that reference elements the page does not contain.

    This is the anti-hallucination check Chinmay's adversarial list (phase
    83/84) is designed to probe: a model that invents tag 47 on a page with
    12 elements is caught here, before anything is executed.
    """
    available = page.tag_ids()
    invented = sorted(plan.references() - available)
    if invented:
        raise InvalidModelOutput(
            f"plan references tag ids that are not on the page: {invented} "
            f"(page has {sorted(available)})")
    for action in plan.actions:
        if action.tag_id is None:
            continue
        element = page.by_id(action.tag_id)
        if element is not None and not element.enabled:
            raise InvalidModelOutput(
                f"plan targets disabled element {action.tag_id} "
                f"({element.label()!r})")


def json_schema_for(model_cls: type[BaseModel]) -> dict:
    """Schema handed to Ollama's structured-output `format` parameter."""
    return model_cls.model_json_schema()
