"""Central configuration for the SIH26171 native host.

Everything here is local-only by design (checklist item: zero network calls).
The only host the process is ever allowed to talk to is the loopback Ollama
server; `assert_local_only()` is the guard that enforces it.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

HOST_NAME = "com.sih26171.voicc"
HOST_VERSION = "1.0.0"

# Anything not on this list is treated as an outbound network call and refused.
ALLOWED_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})

_ROOT = Path(__file__).resolve().parent.parent


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ[name])
    except (KeyError, ValueError):
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ[name])
    except (KeyError, ValueError):
        return default


@dataclass(frozen=True)
class ModelConfig:
    """Frozen model choices (phase 82 writes the final values here)."""

    # Fast first-pass planner. Whole value proposition is speed.
    draft: str = _env("VOICC_DRAFT_MODEL", "qwen2.5:0.5b")
    # Full text reasoner, used when the draft model is not confident.
    text: str = _env("VOICC_TEXT_MODEL", "qwen2.5:3b")
    # Vision model: Moondream for local screen comprehension.
    vision: str = _env("VOICC_VISION_MODEL", "moondream:latest")
    # Optional larger vision model behind the high-accuracy toggle (117).
    vision_fallback: str = _env("VOICC_VISION_FALLBACK_MODEL", "")
    # Local embedding model used by Siddu's memory layer.
    embed: str = _env("VOICC_EMBED_MODEL", "nomic-embed-text:latest")

    def all_models(self) -> list[str]:
        return [m for m in (self.draft, self.text, self.vision,
                            self.vision_fallback, self.embed) if m]


@dataclass(frozen=True)
class SamplingConfig:
    """Phase 128 — locked sampling settings, tuned for repeatability.

    Determinism matters more than creativity here: the same command on the
    same page must produce the same plan during a live demo.
    """

    draft_temperature: float = _env_float("VOICC_DRAFT_TEMP", 0.0)
    text_temperature: float = _env_float("VOICC_TEXT_TEMP", 0.1)
    vision_temperature: float = _env_float("VOICC_VISION_TEMP", 0.1)
    top_p: float = _env_float("VOICC_TOP_P", 0.9)
    seed: int = _env_int("VOICC_SEED", 42)


@dataclass(frozen=True)
class VoiceConfig:
    """Phase 63 / 125 — three languages, three local checkpoints."""

    languages: tuple[str, ...] = ("hi", "kn", "en")
    model_dir: Path = field(default_factory=lambda: Path(
        _env("VOICC_VOICE_MODEL_DIR", str(_ROOT / "models" / "voice"))))
    # Per-language checkpoint directory names under model_dir.
    checkpoints: dict[str, str] = field(default_factory=lambda: {
        "hi": _env("VOICC_VOICE_HI", "indicconformer-hi"),
        "kn": _env("VOICC_VOICE_KN", "indicconformer-kn"),
        "en": _env("VOICC_VOICE_EN", "whisper-small-en"),
    })
    sample_rate: int = 16000
    # Below this the auto-detector refuses to guess and asks the user (125).
    detect_confidence_floor: float = _env_float("VOICC_LANG_FLOOR", 0.45)


@dataclass(frozen=True)
class LoopConfig:
    """Agent-loop behaviour knobs."""

    # Phase 157 — never let one reasoning call emit an enormous plan.
    max_plan_length: int = _env_int("VOICC_MAX_PLAN", 5)
    # Phase 48 — how many single-step retries after a failed plan.
    max_fallback_steps: int = _env_int("VOICC_MAX_FALLBACK", 4)
    # Phase 57 — below this the action pauses and asks instead of guessing.
    confidence_floor: float = _env_float("VOICC_CONFIDENCE_FLOOR", 0.55)
    # Phase 47 — draft plans below this escalate to the full pipeline.
    draft_accept_confidence: float = _env_float("VOICC_DRAFT_ACCEPT", 0.75)
    # Phase 124 — bound the request queue so double-submits cannot pile up.
    max_queue_depth: int = _env_int("VOICC_MAX_QUEUE", 8)
    # Hard ceiling on a single task, so the demo never hangs silently.
    task_timeout_s: float = _env_float("VOICC_TASK_TIMEOUT", 120.0)


@dataclass(frozen=True)
class Config:
    ollama_url: str = _env("VOICC_OLLAMA_URL", "http://127.0.0.1:11434")
    request_timeout_s: float = _env_float("VOICC_REQUEST_TIMEOUT", 90.0)
    # Ollama keep_alive: how long a model stays resident between calls (49).
    keep_alive: str = _env("VOICC_KEEP_ALIVE", "30m")
    log_dir: Path = field(default_factory=lambda: Path(
        _env("VOICC_LOG_DIR", str(_ROOT / "logs"))))
    models: ModelConfig = field(default_factory=ModelConfig)
    sampling: SamplingConfig = field(default_factory=SamplingConfig)
    voice: VoiceConfig = field(default_factory=VoiceConfig)
    loop: LoopConfig = field(default_factory=LoopConfig)

    def assert_local_only(self) -> None:
        """Refuse to start if the backend URL points off-machine."""
        host = urlparse(self.ollama_url).hostname or ""
        if host not in ALLOWED_HOSTS:
            raise ValueError(
                f"refusing non-local backend {self.ollama_url!r}: "
                f"host {host!r} is not one of {sorted(ALLOWED_HOSTS)}"
            )


CONFIG = Config()
