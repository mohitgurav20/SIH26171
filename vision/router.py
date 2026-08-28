import logging
from enum import Enum
from typing import Dict, Any, List

class PerceptionRoute(str, Enum):
    DOM_FAST_PATH = "dom_fast_path"
    VISION_FOVEATED = "vision_foveated"
    VISION_FULL_FRAME = "vision_full_frame"
    EXPLAINED_REFUSAL = "explained_refusal"

class DOMVisionRouter:
    """
    DOM-vs-Vision Decision Router (Task #40, #70, #134).
    Implements the Graceful Degradation Ladder. Skips vision whenever DOM/JSON is unambiguous.
    """

    def __init__(self, ambiguity_threshold: float = 0.6):
        self.ambiguity_threshold = ambiguity_threshold

    def evaluate_route(self, dom_data: Dict[str, Any], user_command: str) -> PerceptionRoute:
        """
        Determine whether DOM processing is sufficient or visual perception is required.
        """
        elements: List[Dict[str, Any]] = dom_data.get("elements", [])

        # 1. If DOM has 0 interactive elements (e.g. Canvas app, SVG graphic, WebGL)
        if len(elements) == 0:
            logging.info("DOM empty of interactive tags. Routing to FOVEATED VISION.")
            return PerceptionRoute.VISION_FOVEATED

        # 2. Check for canvas/image/visual keywords in the user command
        visual_keywords = ["canvas", "chart", "map", "plot", "graphic", "satellite", "orbit"]
        if any(kw in user_command.lower() for kw in visual_keywords):
            logging.info(f"Visual keyword detected in '{user_command}'. Routing to FOVEATED VISION.")
            return PerceptionRoute.VISION_FOVEATED

        # 3. Check for obvious element text matches in DOM
        command_tokens = set(user_command.lower().split())
        matched_elements = 0
        for el in elements:
            el_text = (el.get("text") or "").lower()
            el_aria = (el.get("aria_label") or "").lower()
            if any(tok in el_text or tok in el_aria for tok in command_tokens if len(tok) > 3):
                matched_elements += 1

        if matched_elements > 0:
            logging.info(f"Direct semantic matches found ({matched_elements}). Routing to DOM FAST PATH.")
            return PerceptionRoute.DOM_FAST_PATH

        # Fallback to foveated vision
        logging.info("Ambiguous DOM match. Escalating to FOVEATED VISION.")
        return PerceptionRoute.VISION_FOVEATED
