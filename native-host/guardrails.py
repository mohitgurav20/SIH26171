import re
import logging
from typing import Tuple, Dict, Any
from schemas import ActionItem, ActionType

class ActionGuardrail:
    """
    Guardrail validator that intercepts dangerous/destructive actions (Task #39, #65, #144).
    Cross-checks selected element text against user intent before firing submit/delete/confirm.
    """

    CRITICAL_KEYWORDS = {
        "delete": ["delete", "remove", "clear", "erase", "trash", "drop"],
        "confirm": ["confirm", "proceed", "agree", "accept", "submit", "apply"],
        "submit": ["submit", "checkout", "buy", "pay", "order", "send"]
    }

    @staticmethod
    def validate_action(action: ActionItem, element_meta: Dict[str, Any], user_intent: str) -> Tuple[bool, str]:
        """
        Validate if the target element label matches the stated user intent.
        Returns (is_safe, reason).
        """
        elem_text = (element_meta.get("text") or "").lower()
        aria_label = (element_meta.get("aria_label") or "").lower()
        combined_label = f"{elem_text} {aria_label}".strip()
        intent_lower = user_intent.lower()

        # Check for destructive/critical action mismatch
        for category, keywords in ActionGuardrail.CRITICAL_KEYWORDS.items():
            elem_has_critical = any(kw in combined_label for kw in keywords)
            intent_has_critical = any(kw in intent_lower for kw in keywords)

            # If element is destructive (e.g. Delete) but user intent did not ask for it
            if elem_has_critical and not intent_has_critical:
                msg = f"Guardrail Alert: Element #{action.tag_id} '{combined_label}' is critical ({category}), but user intent was '{user_intent}'. Pausing for confirmation."
                logging.warning(msg)
                return False, msg

        return True, "Action passed guardrail checks."
