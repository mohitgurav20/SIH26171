"""Serialized request handling (phase 124).

Local inference is effectively single-threaded: two concurrent generations
on one machine do not run twice as fast, they thrash the same weights and
make both slower. So commands are queued and run one at a time, and the
queue is bounded so a jammed mic button or an impatient double-click
cannot pile up twenty tasks that all still execute minutes later.

Double-submission gets its own treatment. An identical command arriving
while the same command is still running is almost never a request to do it
twice -- it is the user not seeing a response yet. Those are collapsed onto
the in-flight task rather than queued, so the second click does not click
Submit a second time.
"""
from __future__ import annotations

import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable

from .errors import QueueOverflow


@dataclass
class QueuedRequest:
    request_id: str
    kind: str
    payload: dict
    #: Identity used for double-submit collapsing.
    fingerprint: str
    enqueued_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    result: Any = None
    error: Exception | None = None
    #: Request ids collapsed onto this one.
    duplicates: list[str] = field(default_factory=list)
    _done: threading.Event = field(default_factory=threading.Event,
                                   repr=False)

    @property
    def wait_ms(self) -> float:
        if self.started_at is None:
            return (time.time() - self.enqueued_at) * 1000.0
        return (self.started_at - self.enqueued_at) * 1000.0

    def wait(self, timeout: float | None = None) -> bool:
        return self._done.wait(timeout)


def fingerprint(kind: str, payload: dict) -> str:
    """What counts as 'the same command again'."""
    if kind == "command":
        text = str(payload.get("task") or payload.get("text") or "").strip()
        return f"command:{text.lower()}:{payload.get('url', '')}"
    return f"{kind}:{uuid.uuid4().hex}"      # non-commands never collapse


class RequestQueue:
    """One worker, bounded backlog, duplicate collapsing."""

    def __init__(self, handler: Callable[[QueuedRequest], Any], *,
                 max_depth: int = 8):
        self.handler = handler
        self.max_depth = max_depth
        self._pending: deque[QueuedRequest] = deque()
        self._lock = threading.Lock()
        self._wake = threading.Condition(self._lock)
        self._current: QueuedRequest | None = None
        self._by_fingerprint: dict[str, QueuedRequest] = {}
        self._worker: threading.Thread | None = None
        self._stopping = False
        self.completed = 0
        self.collapsed = 0
        self.rejected = 0

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        if self._worker is not None:
            return
        self._stopping = False
        self._worker = threading.Thread(target=self._run, name="voicc-worker",
                                        daemon=True)
        self._worker.start()

    def stop(self, timeout: float = 5.0) -> None:
        with self._wake:
            self._stopping = True
            self._wake.notify_all()
        if self._worker is not None:
            self._worker.join(timeout)
            self._worker = None

    # -- submission --------------------------------------------------------

    def submit(self, kind: str, payload: dict) -> QueuedRequest:
        request = QueuedRequest(
            request_id=uuid.uuid4().hex[:12], kind=kind, payload=payload,
            fingerprint=fingerprint(kind, payload))
        with self._wake:
            existing = self._by_fingerprint.get(request.fingerprint)
            if existing is not None and not existing._done.is_set():
                # Same command, already in flight or queued: ride along.
                existing.duplicates.append(request.request_id)
                self.collapsed += 1
                return existing

            if len(self._pending) >= self.max_depth:
                self.rejected += 1
                raise QueueOverflow(
                    f"{len(self._pending)} requests already queued "
                    f"(cap {self.max_depth})")

            self._pending.append(request)
            self._by_fingerprint[request.fingerprint] = request
            self._wake.notify()
        return request

    # -- worker ------------------------------------------------------------

    def _run(self) -> None:
        while True:
            with self._wake:
                while not self._pending and not self._stopping:
                    self._wake.wait(0.25)
                if self._stopping and not self._pending:
                    return
                request = self._pending.popleft()
                self._current = request
                request.started_at = time.time()

            try:
                request.result = self.handler(request)
            except Exception as exc:                           # noqa: BLE001
                request.error = exc
            finally:
                request.finished_at = time.time()
                with self._wake:
                    self._current = None
                    self.completed += 1
                    if self._by_fingerprint.get(request.fingerprint) is request:
                        self._by_fingerprint.pop(request.fingerprint, None)
                request._done.set()

    # -- introspection -----------------------------------------------------

    def depth(self) -> int:
        with self._lock:
            return len(self._pending)

    def busy(self) -> bool:
        with self._lock:
            return self._current is not None

    def stats(self) -> dict:
        with self._lock:
            return {
                "depth": len(self._pending),
                "busy": self._current is not None,
                "completed": self.completed,
                "collapsed_duplicates": self.collapsed,
                "rejected_overflow": self.rejected,
                "max_depth": self.max_depth,
            }
