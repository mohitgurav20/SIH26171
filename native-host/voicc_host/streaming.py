"""Act on safe prefixes of a streaming response (phase 108).

A plan is a JSON list, and the first action is usually syntactically
complete long before the last one finishes generating. This module pulls
each action object out of the partial text the moment it closes, so
validation and guardrail work for step 1 overlaps with generation of the
rest of the plan.

The important boundary: this hides *latency*, not correctness. An action
surfaced here is validated immediately, but the agent loop still refuses to
execute anything until the complete plan has passed `parse_model_output`
and `validate_plan_against_page`. A truncated stream must never be able to
produce a half-plan that runs.
"""
from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from typing import Callable, Iterator

from .errors import InvalidModelOutput
from .schemas import Action


@dataclass
class PrefixEvent:
    """One action that became syntactically complete mid-stream."""

    index: int
    action: Action | None
    raw: str
    #: ms from stream start to this action closing.
    at_ms: float
    error: str = ""


class PartialPlanReader:
    """Feed it chunks; it yields complete action objects as they close.

    Written as an explicit scanner rather than repeated json.loads attempts
    on the whole buffer: at 5 actions that would be fine, but re-parsing the
    entire buffer on every token is quadratic, and the whole point here is
    to save milliseconds.
    """

    #: "actions" key, optional whitespace, colon, optional whitespace, "[".
    _ARRAY_START = re.compile(r'"actions"\s*:\s*\[')

    def __init__(self) -> None:
        self._buffer: list[str] = []
        self._text = ""
        self._cursor = 0          # how far we have scanned, inside the array
        self._in_actions = False
        self._done = False
        self._depth = 0
        self._object_start = -1
        self._in_string = False
        self._escaped = False
        self._found = 0

    def feed(self, chunk: str) -> list[str]:
        """Add a chunk, return any newly completed action objects (raw)."""
        if not chunk:
            return []
        self._buffer.append(chunk)
        self._text = "".join(self._buffer)
        return self._scan()

    def _scan(self) -> list[str]:
        """Two phases: locate the array, then walk objects inside it.

        Keeping them separate matters. Character-level string tracking must
        not run over the prelude, or the `"actions"` key itself is treated
        as string content and the marker is never recognised.
        """
        if self._done:
            return []
        text = self._text

        if not self._in_actions:
            match = self._ARRAY_START.search(text)
            if match is None:
                return []           # marker may still be split across chunks
            self._in_actions = True
            self._cursor = match.end()

        completed: list[str] = []
        index = self._cursor
        while index < len(text):
            char = text[index]

            if self._in_string:
                if self._escaped:
                    self._escaped = False
                elif char == "\\":
                    self._escaped = True
                elif char == '"':
                    self._in_string = False
            elif char == '"':
                self._in_string = True
            elif char == "{":
                if self._depth == 0:
                    self._object_start = index
                self._depth += 1
            elif char == "}":
                self._depth -= 1
                if self._depth == 0 and self._object_start >= 0:
                    completed.append(text[self._object_start:index + 1])
                    self._object_start = -1
                    self._found += 1
            elif char == "]" and self._depth == 0:
                self._done = True   # end of the actions array
                index += 1
                break
            index += 1

        self._cursor = index
        return completed

    @property
    def text(self) -> str:
        return self._text

    @property
    def count(self) -> int:
        return self._found


@dataclass
class StreamOutcome:
    """What a streamed plan run produced, plus the timing that proves it."""

    text: str = ""
    events: list[PrefixEvent] = field(default_factory=list)
    first_action_ms: float | None = None
    stream_end_ms: float = 0.0

    @property
    def head_start_ms(self) -> float | None:
        """How long before the end of the stream step 1 was ready.

        Phase 108's done-condition is this being positive: the first step
        began validation visibly before the full plan finished streaming.
        """
        if self.first_action_ms is None:
            return None
        return self.stream_end_ms - self.first_action_ms

    def first_action(self) -> Action | None:
        for event in self.events:
            if event.action is not None:
                return event.action
        return None


class StreamingPlanCollector:
    """Wires PartialPlanReader into the client's `on_token` callback."""

    def __init__(self,
                 on_prefix: Callable[[PrefixEvent], None] | None = None):
        self._reader = PartialPlanReader()
        self._on_prefix = on_prefix
        self._started = time.perf_counter()
        self.outcome = StreamOutcome()

    def reset(self) -> None:
        self._reader = PartialPlanReader()
        self._started = time.perf_counter()
        self.outcome = StreamOutcome()

    def on_token(self, piece: str) -> None:
        for raw in self._reader.feed(piece):
            at_ms = (time.perf_counter() - self._started) * 1000.0
            index = len(self.outcome.events)
            action: Action | None = None
            error = ""
            try:
                action = Action.model_validate(json.loads(raw))
            except Exception as exc:                       # noqa: BLE001
                # A malformed early action is not fatal here: the full-plan
                # parse downstream is the authority. Record and move on.
                error = str(exc)
            event = PrefixEvent(index=index, action=action, raw=raw,
                                at_ms=at_ms, error=error)
            self.outcome.events.append(event)
            if action is not None and self.outcome.first_action_ms is None:
                self.outcome.first_action_ms = at_ms
            if self._on_prefix is not None:
                self._on_prefix(event)

    def finish(self, text: str) -> StreamOutcome:
        self.outcome.text = text
        self.outcome.stream_end_ms = (
            time.perf_counter() - self._started) * 1000.0
        return self.outcome


def iter_complete_actions(chunks: Iterator[str]) -> Iterator[Action]:
    """Convenience wrapper for tests and the benchmark harness."""
    reader = PartialPlanReader()
    for chunk in chunks:
        for raw in reader.feed(chunk):
            try:
                yield Action.model_validate(json.loads(raw))
            except Exception as exc:                       # noqa: BLE001
                raise InvalidModelOutput(
                    f"streamed action was not valid: {exc}") from exc
