"""Prompt construction (phases 46, 66, 126, 136).

Three rules shape everything in this file:

  * The draft model's prompt is minimal (phase 31). Its entire value is
    speed; a bloated prompt defeats it. It gets the task and a bare element
    list -- no memory, no evidence rules, no examples.

  * The full model's prompt is memory-aware and evidence-aware (phase 66):
    retrieved memory goes in, and the model is told it must name the
    element text that justifies each action.

  * Prompts are split into a stable prefix and a volatile suffix (phase
    107). The prefix -- system rules, task, memory -- is byte-identical
    across the calls of one task, so the server can reuse its KV cache.
    Anything that changes per step (the element list, the last error) lives
    in the suffix. Putting a timestamp or a re-ordered memory list in the
    prefix silently destroys the reuse, which is why prefix assembly is a
    function rather than an f-string at each call site.

`docs/136-prompt-templates.md` is generated from this module, so the
written submission cannot drift from the frozen code.
"""
from __future__ import annotations

from dataclasses import dataclass

from .schemas import Element, PageState

#: Phase 150 -- hard cap on injected memory, enforced at the prompt layer
#: regardless of how many facts retrieval hands back.
MAX_MEMORY_FACTS = 3

#: Rough chars-per-token for local Qwen/Llama tokenizers. Only used for the
#: phase 126 before/after comparison, never for correctness.
_CHARS_PER_TOKEN = 3.6


def estimate_tokens(text: str) -> int:
    return int(len(text) / _CHARS_PER_TOKEN) + 1


# --------------------------------------------------------------------------
# System prompts
# --------------------------------------------------------------------------

#: Draft planner. Terse on purpose (phase 126 trimmed this hardest).
SYSTEM_DRAFT = (
    "You pick browser actions. Reply with JSON only.\n"
    'Schema: {"plan":{"actions":[{"type":"click|type|scroll|select|navigate'
    '|wait_for|done","tag_id":<int>,"value":"","intent":""}],'
    '"confidence":0.0-1.0,"reasoning":"","expected_outcome":""},'
    '"ambiguous":false}\n'
    "Use tag_id from the list. Never output coordinates.\n"
    "intent = the visible label of the element you chose.\n"
    "Set ambiguous=true and confidence low if the list does not clearly "
    "contain the target."
)

#: Full reasoner. Carries the evidence and grounding rules.
SYSTEM_TEXT = (
    "You are an on-device browser agent. You act only on what you can see "
    "in the supplied element list.\n"
    "Rules:\n"
    "1. Reference elements by tag_id only. Never output pixel coordinates.\n"
    "2. Never invent a tag_id. If the target is not listed, return a plan "
    'whose only action is {"type":"done"} with confidence below 0.3 and '
    "say what is missing in reasoning.\n"
    "3. intent must be the element's visible label, copied exactly. It is "
    "cross-checked against the real DOM label before the action runs.\n"
    "4. Order actions so each one is possible after the previous one.\n"
    "5. expected_outcome must be an observable change, since it is what "
    "verification checks.\n"
    'Reply with JSON only: {"actions":[...],"confidence":0.0-1.0,'
    '"reasoning":"","expected_outcome":""}'
)

#: Vision selection over a numbered overlay.
SYSTEM_VISION = (
    "You are looking at a screenshot with numbered tags drawn on the "
    "interactive elements.\n"
    "Return the number of the single element that matches the task.\n"
    "Rules:\n"
    "1. Output only a number that is actually drawn in the image.\n"
    "2. If no drawn number matches, return confidence below 0.3.\n"
    "3. List the numbers you considered and rejected.\n"
    'Reply with JSON only: {"tag_id":<int>,"confidence":0.0-1.0,'
    '"reasoning":"","rejected":[]}'
)

#: End-of-plan verification (phase 48).
SYSTEM_VERIFY = (
    "You check whether a browser task reached its expected end state.\n"
    "Compare the expected outcome against the page as it is now.\n"
    "Judge only what the element list shows. Do not assume success.\n"
    'Reply with JSON only: {"satisfied":true|false,"confidence":0.0-1.0,'
    '"reason":""}'
)


# --------------------------------------------------------------------------
# Rendering helpers
# --------------------------------------------------------------------------


def render_element(element: Element) -> str:
    """One line per element. Line-per-element beats JSON here.

    The element list is the largest part of every prompt, so its encoding
    is where phase 126's token savings actually came from: dropping JSON
    punctuation and empty fields cut roughly a fifth of the prompt on a
    data-dense page, with no change in selection accuracy.
    """
    parts = [f"[{element.tag_id}] {element.role}"]
    label = element.label()
    if label:
        parts.append(f'"{label[:80]}"')
    if element.value and element.value != label:
        parts.append(f"value={element.value[:40]}")
    if not element.enabled:
        parts.append("(disabled)")
    if element.region:
        parts.append(f"@{element.region}")
    return " ".join(parts)


def render_elements(page: PageState, *, changed_only: bool = False) -> str:
    """Render the element list, optionally only what changed.

    `changed_only` pairs with Mohit's incremental DOM diffing (phase 104):
    on a re-read where only one field changed, there is no reason to spend
    tokens restating the other forty elements.
    """
    elements = page.elements
    if changed_only and page.changed_tag_ids:
        changed = set(page.changed_tag_ids)
        elements = [e for e in elements if e.tag_id in changed]
    if not elements:
        return "(no interactive elements found)"
    return "\n".join(render_element(e) for e in elements)


def render_memory(facts: list[str]) -> str:
    """Phase 66/150 -- injected memory, hard-capped and stably ordered.

    Ordering is caller-supplied (retrieval rank) and never re-sorted here,
    because a re-ordered list would break the shared prefix.
    """
    kept = [f.strip() for f in facts if f and f.strip()][:MAX_MEMORY_FACTS]
    if not kept:
        return ""
    lines = "\n".join(f"- {fact}" for fact in kept)
    return f"What you already know:\n{lines}"


# --------------------------------------------------------------------------
# Prompt assembly
# --------------------------------------------------------------------------


@dataclass
class BuiltPrompt:
    """A prompt split at the KV-cache boundary."""

    system: str
    prefix: str
    suffix: str

    @property
    def text(self) -> str:
        return f"{self.prefix}{self.suffix}"

    def tokens(self) -> int:
        return estimate_tokens(self.system) + estimate_tokens(self.text)


def build_draft_prompt(task: str, page: PageState) -> BuiltPrompt:
    """Phase 31 -- minimal by design. Task plus elements, nothing else."""
    prefix = f"Task: {task}\n"
    suffix = f"Elements:\n{render_elements(page)}\n"
    return BuiltPrompt(system=SYSTEM_DRAFT, prefix=prefix, suffix=suffix)


def build_reasoning_prompt(task: str, page: PageState, *,
                           memories: list[str] | None = None,
                           last_error: str = "",
                           changed_only: bool = False) -> BuiltPrompt:
    """Phase 46 + 66 -- the full text path, memory- and evidence-aware.

    Prefix (stable for the whole task): task, memory, evidence rule.
    Suffix (changes per step): url, element list, last error.
    """
    prefix_parts = [f"Task: {task}"]
    memory_block = render_memory(memories or [])
    if memory_block:
        prefix_parts.append(memory_block)
    prefix_parts.append(
        "Every action must be justified by an element in the list below. "
        "Copy that element's visible label into intent as your evidence.")
    prefix = "\n\n".join(prefix_parts) + "\n\n"

    suffix_parts = []
    if page.url:
        suffix_parts.append(f"Page: {page.title or page.url}")
    suffix_parts.append(
        ("Changed elements:\n" if changed_only and page.changed_tag_ids
         else "Elements:\n") + render_elements(page, changed_only=changed_only))
    if last_error:
        suffix_parts.append(
            f"The previous attempt failed: {last_error}\n"
            "Do not repeat the same action. If it cannot be done, say so.")
    suffix = "\n\n".join(suffix_parts) + "\n"
    return BuiltPrompt(system=SYSTEM_TEXT, prefix=prefix, suffix=suffix)


def build_vision_prompt(task: str, visible_tags: list[int],
                        *, memories: list[str] | None = None) -> BuiltPrompt:
    """Prompt for the numbered-overlay selection call."""
    prefix = f"Task: {task}\n"
    memory_block = render_memory(memories or [])
    if memory_block:
        prefix += f"\n{memory_block}\n"
    tags = ", ".join(str(t) for t in sorted(visible_tags)) or "none"
    suffix = f"\nNumbers drawn on the image: {tags}\n"
    return BuiltPrompt(system=SYSTEM_VISION, prefix=prefix, suffix=suffix)


def build_verification_prompt(task: str, expected_outcome: str,
                              page: PageState,
                              executed: list[str]) -> BuiltPrompt:
    """Phase 48 -- one check after the whole plan, not one per step."""
    prefix = (f"Task: {task}\n"
              f"Expected end state: {expected_outcome or 'the task is done'}\n")
    steps = "\n".join(f"{i + 1}. {s}" for i, s in enumerate(executed)) or "none"
    suffix = (f"\nActions that ran:\n{steps}\n\n"
              f"Page now:\n{render_elements(page)}\n")
    return BuiltPrompt(system=SYSTEM_VERIFY, prefix=prefix, suffix=suffix)


def stable_prefix(prompt: BuiltPrompt) -> str:
    """The bytes that must not change across one task's calls (phase 107)."""
    return f"{prompt.system}\n\n{prompt.prefix}"


ALL_SYSTEM_PROMPTS = {
    "draft": SYSTEM_DRAFT,
    "text": SYSTEM_TEXT,
    "vision": SYSTEM_VISION,
    "verify": SYSTEM_VERIFY,
}
