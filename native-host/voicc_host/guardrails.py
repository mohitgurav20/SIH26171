"""Guardrail validation (phases 39, 65, 144).

Before a committing action runs, the element the model chose is looked up in
the *real* page state and its real label is compared against the intent the
model stated. If those two disagree, the action is blocked.

The interesting cases are not the obvious ones. "Submit" against a button
labelled "Export" is easy. The ones that matter are:

    intent "Confirm"  vs  label "Confirm Cancel"
    intent "Save"     vs  label "Save and delete drafts"
    intent "Delete"   vs  label "Delete all"

In each of those the intent is a *prefix or subset* of the real label, so
any similarity score high enough to tolerate "Submit" vs "Submit form" also
waves these through. The rule that separates them is not similarity at all:
it is that the two strings must contain the same set of consequential
words. An extra "cancel", "delete", or "all" in the real label changes what
the click does, so it blocks; an extra "form" does not, so it passes.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .errors import GuardrailViolation
from .schemas import GUARDED_ACTIONS, Action, ActionType, PageState

#: Words that change what an action *does*. A difference in this set between
#: stated intent and real label is always a block, however similar the rest
#: of the strings are.
CONSEQUENTIAL = frozenset({
    "submit", "send", "delete", "remove", "erase", "destroy", "drop",
    "confirm", "cancel", "discard", "reject", "decline", "approve",
    "pay", "purchase", "buy", "checkout", "order", "transfer", "withdraw",
    "save", "publish", "deploy", "reset", "clear", "revoke", "disable",
    "enable", "archive", "restore", "overwrite", "replace", "merge",
    "sign", "logout", "signout", "unsubscribe", "deactivate", "close",
    "all", "everything", "permanently", "forever", "everyone",
    # Commitments that ride along on an otherwise innocent label:
    # "Pay now" vs "Pay now and subscribe" is the same trap as
    # "Save" vs "Save and delete drafts".
    "subscribe", "renew", "recurring", "monthly", "yearly", "trial",
    "upgrade", "downgrade", "share", "invite", "notify", "email",
    "public", "publicly", "private", "grant", "revoke", "force",
    "skip", "bypass", "subscription", "billing", "anyone",
})

#: Words that describe *what kind of thing* is being acted on rather than
#: what happens to it. An extra one of these on either side is benign, which
#: is what separates "Submit" vs "Submit form" from "Confirm" vs
#: "Confirm Cancel".
STRUCTURAL = frozenset({
    "form", "page", "item", "row", "entry", "record", "field", "list",
    "table", "dialog", "modal", "panel", "menu", "tab", "section",
    "changes", "change", "details", "detail", "settings", "options",
    "data", "file", "files", "document", "report", "here", "now",
    "again", "above", "below", "selected", "current", "new",
})

#: Pairs that mean opposite things. Either one appearing on only one side is
#: already caught by CONSEQUENTIAL; this catches both appearing but swapped.
OPPOSITES = (
    frozenset({"confirm", "cancel"}),
    frozenset({"approve", "reject"}),
    frozenset({"accept", "decline"}),
    frozenset({"enable", "disable"}),
    frozenset({"save", "discard"}),
    frozenset({"yes", "no"}),
)

#: Action types that must pass the label cross-check (phase 39).
#: `type` and `scroll` are excluded: they do not commit anything, and
#: gating them would add a model-visible failure mode for no safety gain.
CHECKED_ACTIONS = GUARDED_ACTIONS

_WORD = re.compile(r"[a-z0-9]+")
_NOISE = frozenset({"the", "a", "an", "to", "of", "and", "or", "this",
                    "that", "your", "my", "please", "button", "link",
                    "click", "on", "in", "for", "it", "now"})


def normalize(text: str) -> str:
    return " ".join(_WORD.findall((text or "").lower()))


def tokens(text: str) -> set[str]:
    return set(_WORD.findall((text or "").lower()))


def meaningful(text: str) -> set[str]:
    return tokens(text) - _NOISE


def consequential(text: str) -> set[str]:
    return tokens(text) & CONSEQUENTIAL


@dataclass
class GuardrailVerdict:
    allowed: bool
    reason: str
    intent: str = ""
    label: str = ""
    #: Words present on one side only that changed the verdict.
    divergent: list[str] = field(default_factory=list)
    #: "subtle" when the strings look similar but mean different things --
    #: this is the case phase 144 exists to prove is caught.
    kind: str = ""

    def raise_if_blocked(self) -> None:
        if not self.allowed:
            raise GuardrailViolation(
                self.reason,
                user_message=(
                    f"Blocked: you asked for {self.intent!r} but that "
                    f"element is {self.label!r}."))


def check_action(action: Action, page: PageState) -> GuardrailVerdict:
    """Validate one action against real page state."""
    if action.type in (ActionType.DONE, ActionType.SCROLL):
        return GuardrailVerdict(True, "no target to cross-check")

    if action.tag_id is None:
        if action.type is ActionType.NAVIGATE:
            return GuardrailVerdict(True, "navigation without a target tag")
        return GuardrailVerdict(False, f"{action.type.value} has no tag_id")

    element = page.by_id(action.tag_id)
    if element is None:
        # The model referenced something that is not on the page. This is
        # the hallucination case, and it is a block regardless of type.
        return GuardrailVerdict(
            False, f"tag {action.tag_id} is not on the page",
            intent=action.intent, kind="hallucinated")

    if not element.enabled:
        return GuardrailVerdict(
            False, f"tag {action.tag_id} ({element.label()!r}) is disabled",
            intent=action.intent, label=element.label(), kind="disabled")

    if action.type not in CHECKED_ACTIONS:
        return GuardrailVerdict(
            True, f"{action.type.value} does not commit anything",
            intent=action.intent, label=element.label())

    return compare_intent_to_label(action.intent, element.label())


def compare_intent_to_label(intent: str, label: str) -> GuardrailVerdict:
    """The cross-check itself, split out so phase 144 can drive it directly."""
    verdict_base = {"intent": intent, "label": label}

    if not label:
        # An unlabelled control cannot be cross-checked, so it cannot be
        # confirmed safe. Refusing beats guessing.
        return GuardrailVerdict(
            False, "element has no readable label to verify against",
            kind="unlabelled", **verdict_base)

    if not intent:
        return GuardrailVerdict(
            False, "action stated no intent to verify against",
            kind="no_intent", **verdict_base)

    norm_intent, norm_label = normalize(intent), normalize(label)
    if norm_intent == norm_label:
        return GuardrailVerdict(True, "intent matches the element label",
                                **verdict_base)

    intent_risk, label_risk = consequential(intent), consequential(label)

    # The subtle case. One side carries a consequential word the other does
    # not: "Confirm" vs "Confirm Cancel", "Save" vs "Save and delete drafts".
    divergent = sorted(intent_risk ^ label_risk)
    if divergent:
        return GuardrailVerdict(
            False,
            f"label and intent differ on {', '.join(divergent)} -- "
            f"clicking {label!r} does not do {intent!r}",
            divergent=divergent, kind="subtle", **verdict_base)

    # Both sides carry opposite halves of the same pair.
    for pair in OPPOSITES:
        if (intent_risk & pair) and (label_risk & pair) \
                and (intent_risk & pair) != (label_risk & pair):
            return GuardrailVerdict(
                False, f"intent and label are opposites: {sorted(pair)}",
                divergent=sorted(pair), kind="opposite", **verdict_base)

    intent_words, label_words = meaningful(intent), meaningful(label)
    if not intent_words:
        return GuardrailVerdict(
            False, "intent carries no meaningful words", kind="empty_intent",
            **verdict_base)

    # Benign elaboration: "Submit" vs "Submit form". Containment alone is
    # not enough to allow it -- that is exactly the shape of the subtle
    # attacks above. The extra words must also be purely structural.
    extras = intent_words ^ label_words
    if (intent_words <= label_words or label_words <= intent_words) \
            and extras <= STRUCTURAL:
        return GuardrailVerdict(
            True, "intent is contained in the label and the extra words "
                  f"are structural ({', '.join(sorted(extras)) or 'none'})",
            **verdict_base)

    overlap = len(intent_words & label_words) / len(intent_words | label_words)
    if overlap >= 0.6:
        return GuardrailVerdict(
            True, f"intent and label agree (overlap {overlap:.2f})",
            **verdict_base)

    return GuardrailVerdict(
        False,
        f"intent {intent!r} does not match label {label!r} "
        f"(overlap {overlap:.2f})",
        divergent=sorted(intent_words ^ label_words), kind="mismatch",
        **verdict_base)


def check_plan(plan_actions: list[Action],
               page: PageState) -> list[GuardrailVerdict]:
    """Cross-check every action in a plan up front.

    The whole plan is checked before step 1 runs, so a plan that would be
    blocked at step 3 never half-executes. Mohit's executor still re-checks
    element existence immediately before each individual step, since the
    page can change mid-plan -- these two checks answer different questions.
    """
    return [check_action(action, page) for action in plan_actions]


def first_violation(verdicts: list[GuardrailVerdict]) -> GuardrailVerdict | None:
    for verdict in verdicts:
        if not verdict.allowed:
            return verdict
    return None
