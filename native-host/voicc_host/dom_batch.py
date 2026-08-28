"""Batch read-only DOM queries into fewer round trips (phase 155).

Each native-host round trip to the content script costs a message hop, a
serialization pass, and a scheduling wait -- small individually, but the
loop asks several read-only questions per step ("does tag 7 still exist",
"what is tag 7's label now", "is the spinner gone"), and paying that cost
once per question is waste.

This collects read-only queries raised during one reasoning step and sends
them as a single `dom.query` message. Writes are never batched: an action
that changes the page must be observed before the next one is planned.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

#: Sends one batched query message and returns the answers, in order.
Transport = Callable[[list[dict]], list[Any]]


@dataclass
class Query:
    op: str
    args: dict = field(default_factory=dict)

    def key(self) -> str:
        items = ",".join(f"{k}={self.args[k]!r}" for k in sorted(self.args))
        return f"{self.op}({items})"


class DomBatch:
    """Collect, deduplicate, then send once."""

    def __init__(self, transport: Transport):
        self.transport = transport
        self._queries: list[Query] = []
        self._index: dict[str, int] = {}
        self.round_trips = 0
        self.queries_issued = 0
        self.queries_deduplicated = 0

    def add(self, op: str, **args: Any) -> int:
        """Queue a read-only query; returns its slot in the result list."""
        query = Query(op, args)
        key = query.key()
        if key in self._index:
            self.queries_deduplicated += 1
            return self._index[key]
        slot = len(self._queries)
        self._queries.append(query)
        self._index[key] = slot
        return slot

    def flush(self) -> list[Any]:
        """Send everything queued as one message."""
        if not self._queries:
            return []
        payload = [{"op": q.op, **q.args} for q in self._queries]
        self.queries_issued += len(payload)
        self.round_trips += 1
        results = self.transport(payload)
        self._queries.clear()
        self._index.clear()
        return list(results)

    def stats(self) -> dict:
        naive = self.queries_issued + self.queries_deduplicated
        return {
            "round_trips": self.round_trips,
            "queries_sent": self.queries_issued,
            "queries_deduplicated": self.queries_deduplicated,
            "round_trips_without_batching": naive,
            "reduction": (round(1 - self.round_trips / naive, 4)
                          if naive else 0.0),
        }


def exists(batch: DomBatch, tag_id: int) -> int:
    return batch.add("exists", tag_id=tag_id)


def label_of(batch: DomBatch, tag_id: int) -> int:
    return batch.add("label", tag_id=tag_id)


def is_enabled(batch: DomBatch, tag_id: int) -> int:
    return batch.add("enabled", tag_id=tag_id)
