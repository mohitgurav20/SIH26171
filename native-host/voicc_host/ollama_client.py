"""Local inference client (phases 29, 49, 107, 108, 109, 118, 122, 123, 156).

Everything the agent knows about running a model goes through here. The
class is deliberately transport-agnostic: `HttpBackend` talks to a loopback
Ollama server, `ScriptedBackend` replays canned responses so the whole agent
loop is testable on a machine with no models installed.

The speed-relevant behaviour, in one place so it can be benchmarked:

  keep-alive (49)   models stay resident between calls instead of being
                    reloaded per request.
  prefix reuse(107) a PrefixSession keeps the system+task prefix byte-identical
                    across the calls of one task, which is the precondition
                    for the server reusing its KV cache. Reported TTFT per
                    call is what proves the win, so it is measured here.
  streaming (108)   token-level streaming with time-to-first-token recorded,
                    so downstream code can start validating a prefix early.
  warm swap (109)   `warm_async` loads the next likely model in the
                    background while the current step is still running.
"""
from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator, Protocol
from urllib.parse import urlparse

from .config import ALLOWED_HOSTS, CONFIG, Config
from .errors import (BackendTimeout, BackendUnavailable, ModelNotFound,
                     NetworkPolicyViolation, VoiccError)


@dataclass
class Completion:
    """One model response plus the timings the benchmarks need."""

    text: str
    model: str
    #: Wall time from request start to the first token (phase 107/108).
    ttft_ms: float = 0.0
    #: Wall time from request start to the last token.
    total_ms: float = 0.0
    prompt_eval_count: int = 0
    eval_count: int = 0
    #: Tokens the server reported as already cached, when it tells us.
    prompt_cached_count: int = 0
    #: True when this call reused a warm, already-resident model.
    warm: bool = True

    @property
    def tokens_per_second(self) -> float:
        generate_ms = max(self.total_ms - self.ttft_ms, 1e-6)
        return self.eval_count / (generate_ms / 1000.0)


class Backend(Protocol):
    """Minimal transport surface the client needs."""

    def stream(self, endpoint: str, payload: dict) -> Iterator[dict]: ...

    def post(self, endpoint: str, payload: dict) -> dict: ...

    def get(self, endpoint: str) -> dict: ...


class HttpBackend:
    """Loopback HTTP to Ollama. Refuses any non-local URL."""

    def __init__(self, base_url: str, timeout_s: float):
        host = urlparse(base_url).hostname or ""
        if host not in ALLOWED_HOSTS:
            raise NetworkPolicyViolation(
                f"backend host {host!r} is not loopback")
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s
        self._session = None

    def _get_session(self):
        if self._session is None:
            import requests                      # imported lazily: offline ok
            session = requests.Session()
            # No proxies, ever. A corporate proxy env var would otherwise
            # turn a "local" call into an outbound one.
            session.trust_env = False
            self._session = session
        return self._session

    def _url(self, endpoint: str) -> str:
        return f"{self.base_url}{endpoint}"

    def stream(self, endpoint: str, payload: dict) -> Iterator[dict]:
        import requests
        try:
            response = self._get_session().post(
                self._url(endpoint), json=payload,
                stream=True, timeout=self.timeout_s)
        except requests.exceptions.ConnectionError as exc:
            raise BackendUnavailable(str(exc)) from exc
        except requests.exceptions.Timeout as exc:
            raise BackendTimeout(str(exc)) from exc
        _raise_for_status(response)
        try:
            for line in response.iter_lines(decode_unicode=False):
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue                      # keep-alive noise, skip
        except requests.exceptions.Timeout as exc:
            raise BackendTimeout(str(exc)) from exc
        finally:
            response.close()

    def post(self, endpoint: str, payload: dict) -> dict:
        import requests
        try:
            response = self._get_session().post(
                self._url(endpoint), json=payload, timeout=self.timeout_s)
        except requests.exceptions.ConnectionError as exc:
            raise BackendUnavailable(str(exc)) from exc
        except requests.exceptions.Timeout as exc:
            raise BackendTimeout(str(exc)) from exc
        _raise_for_status(response)
        return response.json()

    def get(self, endpoint: str) -> dict:
        import requests
        try:
            response = self._get_session().get(
                self._url(endpoint), timeout=min(self.timeout_s, 5.0))
        except requests.exceptions.ConnectionError as exc:
            raise BackendUnavailable(str(exc)) from exc
        except requests.exceptions.Timeout as exc:
            raise BackendTimeout(str(exc)) from exc
        _raise_for_status(response)
        return response.json()


def _raise_for_status(response) -> None:
    """Turn HTTP failures into the host's own error taxonomy (phase 118)."""
    if response.status_code == 404:
        body = ""
        try:
            body = response.text[:200]
        except Exception:                                  # noqa: BLE001
            pass
        raise ModelNotFound(f"404 from Ollama: {body}")
    if response.status_code >= 500:
        raise BackendUnavailable(f"Ollama returned {response.status_code}")
    if response.status_code >= 400:
        raise VoiccError(f"Ollama returned {response.status_code}")


class ScriptedBackend:
    """Deterministic offline backend used by the tests and dry runs.

    `responses` maps a model name to either a fixed string or a callable
    taking the request payload and returning the response text. Latency can
    be simulated per model so the benchmark harnesses can be exercised
    without any model installed.
    """

    def __init__(self, responses: dict[str, Any] | None = None,
                 latency_ms: dict[str, float] | None = None):
        self.responses = responses or {}
        self.latency_ms = latency_ms or {}
        #: Generation requests only. Speculative warms are recorded
        #: separately: they carry no prompt, they land on a background
        #: thread, and counting them as model calls would make both the
        #: tests and the benchmark numbers wrong.
        self.calls: list[dict] = []
        self.warms: list[dict] = []
        self.loaded: set[str] = set()
        self.available: set[str] = set(self.responses)

    def _text_for(self, payload: dict) -> str:
        model = payload.get("model", "")
        if model not in self.responses:
            raise ModelNotFound(f"scripted backend has no model {model!r}")
        entry = self.responses[model]
        return entry(payload) if callable(entry) else str(entry)

    def stream(self, endpoint: str, payload: dict) -> Iterator[dict]:
        self.calls.append(payload)
        model = payload.get("model", "")
        delay = self.latency_ms.get(model, 0.0) / 1000.0
        cold = model not in self.loaded
        if cold:
            time.sleep(delay)                    # simulated load cost
            self.loaded.add(model)
        text = self._text_for(payload)
        # Emit in chunks so streaming consumers have something to chew on.
        chunk = max(len(text) // 8, 1)
        for index in range(0, len(text), chunk):
            time.sleep(delay / 8)
            yield {"response": text[index:index + chunk], "done": False}
        yield {
            "response": "", "done": True,
            "prompt_eval_count": len(payload.get("prompt", "")) // 4,
            "eval_count": max(len(text) // 4, 1),
        }

    def post(self, endpoint: str, payload: dict) -> dict:
        if endpoint == "/api/generate" and payload.get("stream") is False:
            if payload.get("prompt"):
                self.calls.append(payload)
                text = self._text_for(payload)
            else:
                self.warms.append(payload)       # keep-alive load, no output
                text = ""
            self.loaded.add(payload.get("model", ""))
            return {"response": text, "done": True,
                    "prompt_eval_count": 0, "eval_count": 0}
        return {}

    def get(self, endpoint: str) -> dict:
        if endpoint == "/api/tags":
            return {"models": [{"name": m} for m in sorted(self.available)]}
        if endpoint == "/api/ps":
            return {"models": [{"name": m, "size_vram": 0}
                               for m in sorted(self.loaded)]}
        return {}


# --------------------------------------------------------------------------
# Prefix sessions -- phase 107
# --------------------------------------------------------------------------


@dataclass
class PrefixSession:
    """Keeps one task's shared prompt prefix byte-identical across calls.

    Ollama reuses the KV cache for the longest common prefix of consecutive
    requests to the same resident model. That only helps if the prefix
    really is identical -- a timestamp, a re-ordered memory list, or a
    re-rendered element list silently defeats it. This class freezes the
    prefix at task start and refuses to let callers mutate it mid-task.
    """

    task_id: str
    model: str
    prefix: str
    calls: int = 0
    ttft_ms: list[float] = field(default_factory=list)

    def compose(self, suffix: str) -> str:
        return f"{self.prefix}{suffix}"

    def record(self, completion: Completion) -> None:
        self.calls += 1
        self.ttft_ms.append(completion.ttft_ms)

    def cache_benefit_ms(self) -> float | None:
        """First-call TTFT minus the mean of the later ones.

        Positive means later same-task calls really were cheaper to start,
        which is exactly phase 107's done-condition.
        """
        if len(self.ttft_ms) < 2:
            return None
        later = self.ttft_ms[1:]
        return self.ttft_ms[0] - (sum(later) / len(later))


# --------------------------------------------------------------------------
# The client
# --------------------------------------------------------------------------


class OllamaClient:
    """Warm-kept, prefix-aware, streaming-capable local inference client."""

    def __init__(self, config: Config | None = None,
                 backend: Backend | None = None):
        self.config = config or CONFIG
        self.config.assert_local_only()
        self.backend = backend or HttpBackend(
            self.config.ollama_url, self.config.request_timeout_s)
        self._resident: set[str] = set()
        self._resident_lock = threading.Lock()
        self._warming: dict[str, threading.Thread] = {}
        #: Phase 122 -- role -> model name, swappable at runtime.
        self._roles: dict[str, str] = {
            "draft": self.config.models.draft,
            "text": self.config.models.text,
            "vision": self.config.models.vision,
            "embed": self.config.models.embed,
        }

    # -- role management (phase 122) ---------------------------------------

    def model_for(self, role: str) -> str:
        try:
            return self._roles[role]
        except KeyError:
            raise VoiccError(f"unknown model role {role!r}") from None

    def swap_role(self, role: str, model: str) -> str:
        """Point a role at a different model without restarting the host.

        Returns the previous model so the caller can swap back. The new
        model is warmed in the background so the swap does not stall the
        next request.
        """
        previous = self.model_for(role)
        if previous == model:
            return previous
        self._roles[role] = model
        self.warm_async(model)
        return previous

    def roles(self) -> dict[str, str]:
        return dict(self._roles)

    # -- warm keeping (phases 49, 109, 156) --------------------------------

    def is_resident(self, model: str) -> bool:
        with self._resident_lock:
            return model in self._resident

    def warm(self, model: str) -> float:
        """Load a model without generating anything. Returns ms spent."""
        started = time.perf_counter()
        try:
            self.backend.post("/api/generate", {
                "model": model, "prompt": "", "stream": False,
                "keep_alive": self.config.keep_alive,
            })
        except VoiccError:
            raise
        elapsed = (time.perf_counter() - started) * 1000.0
        with self._resident_lock:
            self._resident.add(model)
        return elapsed

    def warm_async(self, model: str) -> None:
        """Phase 109/156 -- speculatively load the next likely model.

        Wrong guesses cost a background load we discard; right guesses
        remove the cold-start from the critical path. Failures are
        swallowed on purpose: a speculative warm must never surface an
        error to the user.
        """
        if self.is_resident(model):
            return
        existing = self._warming.get(model)
        if existing is not None and existing.is_alive():
            return

        def _run() -> None:
            try:
                self.warm(model)
            except Exception:                              # noqa: BLE001
                pass                     # speculative: silence is correct

        thread = threading.Thread(target=_run, name=f"warm-{model}",
                                  daemon=True)
        self._warming[model] = thread
        thread.start()

    def await_warm(self, model: str, timeout_s: float = 30.0) -> None:
        thread = self._warming.get(model)
        if thread is not None:
            thread.join(timeout_s)

    # -- generation --------------------------------------------------------

    def _options(self, role: str, overrides: dict | None = None) -> dict:
        sampling = self.config.sampling
        temperature = {
            "draft": sampling.draft_temperature,
            "text": sampling.text_temperature,
            "vision": sampling.vision_temperature,
        }.get(role, sampling.text_temperature)
        options = {
            "temperature": temperature,
            "top_p": sampling.top_p,
            "seed": sampling.seed,
        }
        options.update(overrides or {})
        return options

    def generate(self, role: str, prompt: str, *,
                 model: str | None = None,
                 system: str = "",
                 images: list[str] | None = None,
                 schema: dict | None = None,
                 options: dict | None = None,
                 session: PrefixSession | None = None,
                 on_token: Callable[[str], None] | None = None) -> Completion:
        """Run one completion, streaming under the hood.

        Streaming is always on internally even when the caller wants the
        whole string: it is the only way to measure time-to-first-token,
        and TTFT is the number the KV-cache and warm-keeping work is
        judged by.
        """
        model_name = model or self.model_for(role)
        cold = not self.is_resident(model_name)
        payload: dict[str, Any] = {
            "model": model_name,
            "prompt": prompt,
            "stream": True,
            "keep_alive": self.config.keep_alive,
            "options": self._options(role, options),
        }
        if system:
            payload["system"] = system
        if images:
            payload["images"] = images
        if schema:
            # Ollama's structured-output mode. Belt and braces: the response
            # still goes through parse_model_output afterwards.
            payload["format"] = schema

        started = time.perf_counter()
        ttft_ms = 0.0
        parts: list[str] = []
        prompt_eval = eval_count = cached = 0
        for chunk in self.backend.stream("/api/generate", payload):
            piece = chunk.get("response", "")
            if piece:
                if not parts:
                    ttft_ms = (time.perf_counter() - started) * 1000.0
                parts.append(piece)
                if on_token is not None:
                    on_token(piece)
            if chunk.get("done"):
                prompt_eval = int(chunk.get("prompt_eval_count") or 0)
                eval_count = int(chunk.get("eval_count") or 0)
                cached = int(chunk.get("prompt_cache_hit_tokens") or 0)
        total_ms = (time.perf_counter() - started) * 1000.0
        with self._resident_lock:
            self._resident.add(model_name)

        completion = Completion(
            text="".join(parts), model=model_name, ttft_ms=ttft_ms,
            total_ms=total_ms, prompt_eval_count=prompt_eval,
            eval_count=eval_count, prompt_cached_count=cached, warm=not cold)
        if session is not None:
            session.record(completion)
        return completion

    def start_session(self, task_id: str, role: str, prefix: str) -> PrefixSession:
        """Open a KV-cache-friendly session for one task (phase 107)."""
        return PrefixSession(task_id=task_id, model=self.model_for(role),
                             prefix=prefix)

    def embed(self, texts: list[str]) -> list[list[float]]:
        """Batched embedding call (supports Siddu's phase 102).

        One request for N texts, not N requests -- the per-call overhead is
        the thing being amortized.
        """
        if not texts:
            return []
        response = self.backend.post("/api/embed", {
            "model": self.model_for("embed"),
            "input": texts,
            "keep_alive": self.config.keep_alive,
        })
        vectors = response.get("embeddings")
        if vectors is None:
            single = response.get("embedding")
            vectors = [single] if single else []
        return vectors

    # -- health (phase 123) ------------------------------------------------

    def health(self) -> dict:
        """What the UI's 'backend connected' indicator reads.

        Never raises: an unreachable backend is a *reported* state, not an
        exception, because the indicator has to render either way.
        """
        report: dict[str, Any] = {
            "connected": False,
            "url": self.config.ollama_url,
            "installed_models": [],
            "loaded_models": [],
            "roles": self.roles(),
            "missing_models": [],
            "error": None,
        }
        try:
            tags = self.backend.get("/api/tags")
            installed = [m.get("name", "") for m in tags.get("models", [])]
            report["connected"] = True
            report["installed_models"] = installed
            loaded = self.backend.get("/api/ps")
            report["loaded_models"] = [m.get("name", "")
                                       for m in loaded.get("models", [])]
            wanted = set(self._roles.values())
            # Ollama reports "name:tag"; a role may be written without a tag.
            report["missing_models"] = sorted(
                w for w in wanted
                if w and not any(i == w or i.startswith(f"{w}:")
                                 for i in installed))
        except VoiccError as exc:
            report["error"] = exc.to_dict()
        except Exception as exc:                           # noqa: BLE001
            report["error"] = {"code": "unknown", "message": str(exc)}
        return report

    def preflight(self) -> None:
        """Fail fast at startup if the backend cannot serve the demo."""
        report = self.health()
        if not report["connected"]:
            raise BackendUnavailable(
                str(report.get("error") or "no response from Ollama"))
        if report["missing_models"]:
            raise ModelNotFound(
                "not installed: " + ", ".join(report["missing_models"]))
