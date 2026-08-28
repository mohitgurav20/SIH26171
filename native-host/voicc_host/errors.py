"""Error taxonomy for the native host.

Phase 95: every error path must surface a clear, user-facing message rather
than a stack trace or a silent hang. Each error carries a stable `code` the
extension can switch on, and a `user_message` written for a human.
"""
from __future__ import annotations


class VoiccError(Exception):
    code = "internal_error"
    user_message = "Something went wrong inside the agent."
    recoverable = False

    def __init__(self, detail: str = "", *, user_message: str | None = None):
        self.detail = detail
        if user_message:
            self.user_message = user_message
        super().__init__(detail or self.user_message)

    def to_dict(self) -> dict:
        return {
            "code": self.code,
            "message": self.user_message,
            "detail": self.detail,
            "recoverable": self.recoverable,
        }


class BackendUnavailable(VoiccError):
    """Phase 118 — Ollama is not running. Fail loudly and immediately."""

    code = "backend_unavailable"
    user_message = ("The local model server isn't running. "
                    "Start Ollama and try again.")
    recoverable = True


class BackendTimeout(VoiccError):
    code = "backend_timeout"
    user_message = "The local model took too long to respond."
    recoverable = True


class ModelNotFound(VoiccError):
    code = "model_not_found"
    user_message = "A required local model isn't installed."
    recoverable = True


class InvalidModelOutput(VoiccError):
    """Phase 30/142 — the model returned something the schema rejects."""

    code = "invalid_model_output"
    user_message = "The model returned an unusable response."
    recoverable = True


class GuardrailViolation(VoiccError):
    """Phase 65/144 — intent and the chosen element's real label disagree."""

    code = "guardrail_violation"
    user_message = ("That action was blocked: the element doesn't match "
                    "what you asked for.")
    recoverable = False


class EvidenceMissing(VoiccError):
    """Phase 55 — no Proof-of-Perception record, so no action."""

    code = "evidence_missing"
    user_message = "Blocked: nothing on the page justifies that action."
    recoverable = False


class LowConfidence(VoiccError):
    """Phase 57 — pause and confirm instead of guessing."""

    code = "low_confidence"
    user_message = "I'm not confident enough about this one. Confirm?"
    recoverable = True


class TranscriptionError(VoiccError):
    code = "transcription_failed"
    user_message = "I couldn't make out that voice command."
    recoverable = True


class QueueOverflow(VoiccError):
    """Phase 124 — too many rapid commands stacked up."""

    code = "queue_overflow"
    user_message = "Too many commands at once — slow down a moment."
    recoverable = True


class ProtocolError(VoiccError):
    code = "protocol_error"
    user_message = "The extension and the host disagreed on a message."
    recoverable = False


class NetworkPolicyViolation(VoiccError):
    """Refuses anything that would leave the machine."""

    code = "network_policy_violation"
    user_message = "Blocked an attempt to contact a non-local service."
    recoverable = False
