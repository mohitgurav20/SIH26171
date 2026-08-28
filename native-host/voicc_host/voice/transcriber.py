"""Local voice transcription for Hindi, Kannada and English (63, 125).

Three separate checkpoints, all local, all loaded from disk:

    hi -> AI4Bharat IndicConformer (Hindi)
    kn -> AI4Bharat IndicConformer (Kannada)
    en -> Whisper small.en

Why three rather than one multilingual Whisper: on the 2-3B-class hardware
this demo runs on, multilingual Whisper's Kannada word error rate is poor
enough to make the Kannada demo moment unreliable, and unreliable is worse
than absent. Per-language Indic checkpoints are smaller *and* better on the
two Indic languages, at the cost of needing a language decision up front --
which is what the selector UI (phase 120) and the detector below provide.

Nothing here touches the network. Checkpoints are read from a local
directory and the loader refuses to fall back to a hub download, because a
silent download would break the zero-network guarantee at the worst
possible moment.
"""
from __future__ import annotations

import base64
import io
import math
import os
import time
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from ..config import CONFIG, VoiceConfig
from ..errors import TranscriptionError

#: Set before importing any HF library: no hub calls, ever.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

LANGUAGE_NAMES = {"hi": "Hindi", "kn": "Kannada", "en": "English"}


@dataclass
class AudioClip:
    """16 kHz mono float PCM -- what every checkpoint here expects."""

    samples: list[float]
    sample_rate: int = 16000

    @property
    def duration_s(self) -> float:
        return len(self.samples) / self.sample_rate if self.sample_rate else 0.0

    def head(self, seconds: float) -> "AudioClip":
        return AudioClip(self.samples[:int(seconds * self.sample_rate)],
                         self.sample_rate)

    def rms(self) -> float:
        if not self.samples:
            return 0.0
        return math.sqrt(sum(s * s for s in self.samples) / len(self.samples))


def decode_wav_base64(payload: str) -> AudioClip:
    """Decode the base64 WAV the extension records into mono 16 kHz floats.

    MediaRecorder hands back webm/opus by default, which needs ffmpeg to
    decode. The extension is configured to send WAV instead so the host
    stays dependency-free; anything else is rejected with a clear message
    rather than a codec stack trace.
    """
    try:
        raw = base64.b64decode(payload, validate=True)
    except Exception as exc:                                   # noqa: BLE001
        raise TranscriptionError(f"audio payload is not valid base64: {exc}")

    if raw[:4] != b"RIFF":
        raise TranscriptionError(
            "audio must be WAV; the extension should record with "
            "mimeType audio/wav (webm/opus needs ffmpeg, which the host "
            "deliberately does not depend on)")

    try:
        with wave.open(io.BytesIO(raw), "rb") as handle:
            channels = handle.getnchannels()
            width = handle.getsampwidth()
            rate = handle.getframerate()
            frames = handle.readframes(handle.getnframes())
    except wave.Error as exc:
        raise TranscriptionError(f"unreadable WAV: {exc}") from exc

    if width != 2:
        raise TranscriptionError(
            f"expected 16-bit PCM, got {width * 8}-bit")

    import array
    pcm = array.array("h")
    pcm.frombytes(frames)
    samples = [s / 32768.0 for s in pcm]

    if channels > 1:                       # average down to mono
        samples = [sum(samples[i:i + channels]) / channels
                   for i in range(0, len(samples) - channels + 1, channels)]

    if rate != 16000:
        samples = _resample_linear(samples, rate, 16000)
    return AudioClip(samples, 16000)


def _resample_linear(samples: list[float], src: int, dst: int) -> list[float]:
    """Linear resample. Adequate for speech at these rates."""
    if src == dst or not samples:
        return samples
    ratio = dst / src
    out_len = int(len(samples) * ratio)
    out: list[float] = []
    for i in range(out_len):
        position = i / ratio
        left = int(position)
        right = min(left + 1, len(samples) - 1)
        frac = position - left
        out.append(samples[left] * (1 - frac) + samples[right] * frac)
    return out


@dataclass
class Transcript:
    text: str
    language: str
    confidence: float = 0.0
    latency_ms: float = 0.0
    model: str = ""
    #: True when the language was guessed rather than chosen by the user.
    auto_detected: bool = False
    alternatives: list[tuple[str, float]] = field(default_factory=list)


class TranscriberBackend(Protocol):
    def transcribe(self, clip: AudioClip, language: str) -> tuple[str, float]:
        ...

    def loaded_languages(self) -> list[str]: ...


class ScriptedTranscriberBackend:
    """Offline stand-in used by tests and rehearsal dry runs."""

    def __init__(self, responses: dict[str, tuple[str, float]] | None = None):
        self.responses = responses or {}
        self.calls: list[tuple[str, float]] = []

    def transcribe(self, clip: AudioClip, language: str) -> tuple[str, float]:
        self.calls.append((language, clip.duration_s))
        if language not in self.responses:
            raise TranscriptionError(f"no scripted audio for {language!r}")
        return self.responses[language]

    def loaded_languages(self) -> list[str]:
        return sorted(self.responses)


class LocalCheckpointBackend:
    """Loads the three checkpoints from disk, lazily and once each.

    Lazy matters: loading all three at import time would add seconds to
    host startup for a session that may never use voice, and phase 161
    cares about how much sits in memory at once.
    """

    def __init__(self, config: VoiceConfig | None = None):
        self.config = config or CONFIG.voice
        self._pipelines: dict[str, object] = {}

    def _checkpoint_path(self, language: str) -> Path:
        name = self.config.checkpoints.get(language)
        if not name:
            raise TranscriptionError(f"no checkpoint configured for {language}")
        path = self.config.model_dir / name
        if not path.exists():
            raise TranscriptionError(
                f"{LANGUAGE_NAMES.get(language, language)} checkpoint is not "
                f"installed at {path} (offline mode: it will not be "
                f"downloaded)")
        return path

    def _pipeline(self, language: str):
        if language in self._pipelines:
            return self._pipelines[language]
        path = self._checkpoint_path(language)
        try:
            from transformers import pipeline           # imported lazily
        except ImportError as exc:
            raise TranscriptionError(
                "transformers is not installed; voice is unavailable"
            ) from exc
        asr = pipeline("automatic-speech-recognition", model=str(path),
                       local_files_only=True)
        self._pipelines[language] = asr
        return asr

    def transcribe(self, clip: AudioClip, language: str) -> tuple[str, float]:
        asr = self._pipeline(language)
        result = asr({"raw": clip.samples, "sampling_rate": clip.sample_rate},
                     return_timestamps=False)
        text = (result or {}).get("text", "").strip()
        # Most ASR pipelines do not return a usable probability. Length
        # relative to audio duration is a crude but honest proxy: silence
        # transcribed as a long sentence is the failure we care about.
        confidence = _plausibility(text, clip.duration_s)
        return text, confidence

    def loaded_languages(self) -> list[str]:
        return sorted(self._pipelines)

    def unload(self, language: str) -> None:
        """Free a checkpoint. Used by the phase 161 memory ceiling check."""
        self._pipelines.pop(language, None)


def _plausibility(text: str, duration_s: float) -> float:
    """How believable is this transcript for audio of this length."""
    words = len(text.split())
    if not words or duration_s <= 0:
        return 0.0
    per_second = words / duration_s
    # Natural speech sits around 2-4 words/second in all three languages.
    if 0.8 <= per_second <= 5.0:
        return 0.9
    if per_second > 8.0:
        return 0.25                        # hallucinated filler
    return 0.5


class VoiceTranscriber:
    """The API the agent loop calls: one method, three languages."""

    def __init__(self, backend: TranscriberBackend | None = None,
                 config: VoiceConfig | None = None):
        self.config = config or CONFIG.voice
        self.backend = backend or LocalCheckpointBackend(self.config)

    def transcribe(self, clip: AudioClip, *,
                   language: str | None = None) -> Transcript:
        """Transcribe, detecting the language first if none was selected."""
        if clip.duration_s < 0.2 or clip.rms() < 1e-4:
            raise TranscriptionError(
                "the recording is silent or too short",
                user_message="I didn't hear anything -- try again.")

        auto = language is None
        alternatives: list[tuple[str, float]] = []
        if auto:
            language, detect_confidence, alternatives = self.detect_language(clip)
            if detect_confidence < self.config.detect_confidence_floor:
                raise TranscriptionError(
                    f"language detection was inconclusive "
                    f"({detect_confidence:.2f})",
                    user_message="I couldn't tell which language that was. "
                                 "Pick a language and try again.")
        if language not in self.config.languages:
            raise TranscriptionError(f"unsupported language {language!r}")

        started = time.perf_counter()
        text, confidence = self.backend.transcribe(clip, language)
        latency = (time.perf_counter() - started) * 1000.0
        if not text.strip():
            raise TranscriptionError(
                f"{LANGUAGE_NAMES.get(language, language)} transcription "
                f"returned nothing",
                user_message="I couldn't make out that command.")
        return Transcript(text=text.strip(), language=language,
                          confidence=confidence, latency_ms=latency,
                          model=self.config.checkpoints.get(language, ""),
                          auto_detected=auto, alternatives=alternatives)

    def detect_language(self, clip: AudioClip
                        ) -> tuple[str, float, list[tuple[str, float]]]:
        """Phase 125 -- guess the language when the user did not pick one.

        Each checkpoint transcribes the first few seconds and the results
        are scored by script agreement and plausibility. A checkpoint asked
        for the wrong language typically emits either the wrong script or
        an implausible word rate, and both are visible without any extra
        model.

        Only a short head of the clip is used: this runs three models, so
        doing it over the whole recording would cost more than it saves.
        """
        probe = clip.head(3.0)
        scores: list[tuple[str, float]] = []
        for language in self.config.languages:
            try:
                text, plausibility = self.backend.transcribe(probe, language)
            except TranscriptionError:
                continue                      # checkpoint missing: skip it
            scores.append((language, plausibility * script_agreement(text,
                                                                     language)))
        if not scores:
            raise TranscriptionError(
                "no voice checkpoints are available",
                user_message="Voice models aren't installed.")
        scores.sort(key=lambda item: item[1], reverse=True)
        best_language, best_score = scores[0]
        runner_up = scores[1][1] if len(scores) > 1 else 0.0
        # Confidence is the margin, not the raw score: two languages both
        # scoring 0.9 means the detector learned nothing.
        confidence = best_score - runner_up + (best_score * 0.3)
        return best_language, min(confidence, 1.0), scores


#: Unicode block boundaries for the two Indic scripts in play.
_DEVANAGARI = (0x0900, 0x097F)
_KANNADA = (0x0C80, 0x0CFF)


def script_of(text: str) -> str:
    """Which script does this text predominantly use."""
    counts = {"deva": 0, "knda": 0, "latin": 0}
    for char in text:
        code = ord(char)
        if _DEVANAGARI[0] <= code <= _DEVANAGARI[1]:
            counts["deva"] += 1
        elif _KANNADA[0] <= code <= _KANNADA[1]:
            counts["knda"] += 1
        elif char.isalpha() and code < 128:
            counts["latin"] += 1
    total = sum(counts.values())
    if not total:
        return "unknown"
    return max(counts, key=lambda key: counts[key])


def script_agreement(text: str, language: str) -> float:
    """1.0 when the output script matches what the language should produce."""
    expected = {"hi": "deva", "kn": "knda", "en": "latin"}[language]
    actual = script_of(text)
    if actual == "unknown":
        return 0.0
    if actual == expected:
        return 1.0
    # Romanized Hindi/Kannada is common and not disqualifying, just weaker.
    if actual == "latin" and language in ("hi", "kn"):
        return 0.45
    return 0.1
