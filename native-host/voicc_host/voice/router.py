"""Route transcribed speech into the one command pipeline (phase 64).

Whatever language was spoken, what leaves this module is an ordinary
command string that goes through exactly the same path as something typed
into the popup. There is no separate "voice mode" in the agent loop, and
that is deliberate -- a second path would be a second set of bugs and a
second thing to rehearse.

One wrinkle is worth being honest about. The reasoning model is a 3B
general model; it handles English well, Hindi passably, and Kannada
poorly. Handing it raw Kannada would make the Kannada demo the weakest
moment in the run. So the transcript is passed through a small local
lexicon that maps spoken action verbs onto the canonical English verbs the
prompts already use, and *both* strings travel onward: the canonical text
is what the model reasons over, the original is what the UI and the audit
log show the user. No translation model, no network, no extra latency.

The lexicon covers verbs and UI nouns only. Proper nouns, field values and
anything it does not recognise pass through untouched, so "ಹೆಸರು ಬಾಕ್ಸ್‌ನಲ್ಲಿ
Ramesh ಎಂದು ಬರೆ" still types "Ramesh" and not a mangled transliteration.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

from .transcriber import Transcript, script_of

#: Spoken term -> canonical English used in the prompts. Hindi and Kannada
#: share one table because the values are the canonical side, not the
#: source language; collisions between the two scripts are impossible.
COMMAND_LEXICON: dict[str, str] = {
    # --- Hindi (Devanagari) -------------------------------------------
    "क्लिक": "click", "दबाओ": "click", "दबाएं": "click", "चुनो": "select",
    "खोलो": "open", "खोलें": "open", "जाओ": "go to", "भरो": "type",
    "लिखो": "type", "लिखें": "type", "टाइप": "type", "भेजो": "submit",
    "जमा": "submit", "सबमिट": "submit", "स्क्रॉल": "scroll",
    "नीचे": "down", "ऊपर": "up", "लॉगिन": "login", "लॉग": "login",
    "रिपोर्ट": "report", "रिपोर्ट्स": "reports", "पेज": "page",
    "बटन": "button", "खोज": "search", "खोजो": "search", "दिखाओ": "show",
    "हटाओ": "delete", "मिटाओ": "delete", "रद्द": "cancel",
    "पुष्टि": "confirm", "सहेजो": "save", "वापस": "back",
    "तालिका": "table", "पंक्ति": "row", "पहला": "first", "दूसरा": "second",
    "अंतिम": "last", "नाम": "name", "पासवर्ड": "password",
    # --- Kannada -------------------------------------------------------
    "ಕ್ಲಿಕ್": "click", "ಒತ್ತಿ": "click", "ಒತ್ತು": "click", "ಆಯ್ಕೆ": "select",
    "ತೆರೆ": "open", "ತೆರೆಯಿರಿ": "open", "ಹೋಗು": "go to", "ಬರೆ": "type",
    "ಬರೆಯಿರಿ": "type", "ಟೈಪ್": "type", "ಸಲ್ಲಿಸು": "submit",
    "ಸಲ್ಲಿಸಿ": "submit", "ಸಬ್ಮಿಟ್": "submit", "ಸ್ಕ್ರಾಲ್": "scroll",
    "ಕೆಳಗೆ": "down", "ಮೇಲೆ": "up", "ಲಾಗಿನ್": "login", "ವರದಿ": "report",
    "ವರದಿಗಳು": "reports", "ಪುಟ": "page", "ಬಟನ್": "button",
    "ಹುಡುಕು": "search", "ಹುಡುಕಿ": "search", "ತೋರಿಸು": "show",
    "ಅಳಿಸು": "delete", "ಅಳಿಸಿ": "delete", "ರದ್ದು": "cancel",
    "ದೃಢೀಕರಿಸಿ": "confirm", "ಉಳಿಸು": "save", "ಹಿಂದೆ": "back",
    "ಕೋಷ್ಟಕ": "table", "ಸಾಲು": "row", "ಮೊದಲ": "first",
    "ಎರಡನೇ": "second", "ಕೊನೆಯ": "last", "ಹೆಸರು": "name",
    "ಪಾಸ್‌ವರ್ಡ್": "password",
    # --- connectives ---------------------------------------------------
    # Left in rather than dropped: "open reports and click submit" is two
    # steps, "open reports click submit" reads as one ambiguous phrase, and
    # the planner batches better when the boundary survives.
    "और": "and", "में": "in", "पर": "on", "से": "from", "फिर": "then",
    "ಮತ್ತು": "and", "ನಂತರ": "then", "ಗೆ": "to", "ಇಂದ": "from",
}

#: Filler the ASR reliably emits that carries no instruction.
FILLERS = {"उम", "अं", "ಅಂ", "ಉಂ", "um", "uh", "hmm", "ok", "okay"}

#: Punctuation stripped from token edges, including the Devanagari danda.
_EDGE_PUNCT = ",.;:!?()[]{}<>\"'`‘’“”।॥"

#: Tokenizing with \w is wrong for these scripts: Devanagari and Kannada
#: vowel signs are combining marks, which \w does not match, so "kholo"
#: written in Devanagari comes back as four separate "words" and every
#: lexicon lookup misses. Splitting on whitespace keeps clusters intact.
_WHITESPACE = re.compile(r"\s+", re.UNICODE)


@dataclass
class VoiceCommand:
    """One spoken command, ready for the ordinary command pipeline."""

    #: What the user actually said, in their own script. Shown in the UI.
    original: str
    #: What the reasoning model sees.
    canonical: str
    language: str
    confidence: float = 0.0
    auto_detected: bool = False
    latency_ms: float = 0.0
    #: (spoken term, canonical term) pairs, for the why-panel.
    translated_terms: list[tuple[str, str]] = field(default_factory=list)

    @property
    def was_normalized(self) -> bool:
        return bool(self.translated_terms)

    def to_dict(self) -> dict:
        return {
            "original": self.original,
            "canonical": self.canonical,
            "language": self.language,
            "confidence": round(self.confidence, 3),
            "auto_detected": self.auto_detected,
            "latency_ms": round(self.latency_ms, 2),
            "translated_terms": [list(pair) for pair in self.translated_terms],
        }


def _strip_marks(token: str) -> str:
    """Drop ZWJ/ZWNJ so lookups are not defeated by invisible characters.

    Kannada ASR output varies on zero-width joiners between the same words,
    which would otherwise cause silent lexicon misses.
    """
    return "".join(ch for ch in unicodedata.normalize("NFC", token)
                   if unicodedata.category(ch) != "Cf")


#: Lexicon keyed by the same normalization applied to incoming tokens, so a
#: stray ZWNJ in either the table or the ASR output cannot cause a miss.
_LOOKUP: dict[str, str] = {}


def _key(token: str) -> str:
    return _strip_marks(token).strip(_EDGE_PUNCT).lower()


def _build_lookup() -> None:
    for spoken, canonical in COMMAND_LEXICON.items():
        _LOOKUP[_key(spoken)] = canonical


_build_lookup()


def normalize_text(text: str) -> tuple[str, list[tuple[str, str]]]:
    """Map known spoken terms to canonical English, leave the rest alone."""
    out: list[str] = []
    translated: list[tuple[str, str]] = []
    for token in _WHITESPACE.split(text.strip()):
        if not token:
            continue
        key = _key(token)
        if not key or key in FILLERS:
            continue
        replacement = _LOOKUP.get(key)
        if replacement:
            translated.append((token, replacement))
            out.append(replacement)
        else:
            out.append(token.strip(_EDGE_PUNCT) or token)
    return " ".join(out), translated


def route(transcript: Transcript) -> VoiceCommand:
    """Turn a Transcript into the command the pipeline will execute."""
    canonical, translated = normalize_text(transcript.text)
    if not canonical:
        canonical = transcript.text.strip()
    return VoiceCommand(
        original=transcript.text,
        canonical=canonical,
        language=transcript.language,
        confidence=transcript.confidence,
        auto_detected=transcript.auto_detected,
        latency_ms=transcript.latency_ms,
        translated_terms=translated,
    )


def looks_like_language(text: str, language: str) -> bool:
    """Sanity check used by the QA harness (phases 131, 148)."""
    expected = {"hi": "deva", "kn": "knda", "en": "latin"}[language]
    return script_of(text) in (expected, "latin")
