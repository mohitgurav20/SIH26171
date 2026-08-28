import time
import logging
from enum import Enum
from typing import Dict, Any, Optional
from PIL import Image

from .preprocessing import ScreenshotPreprocessor
from .foveation import FoveatedRegionLocator
from .grounding import NumberedTagGrounding
from .router import DOMVisionRouter, PerceptionRoute
from .proof_of_perception import ProofOfPerception, HashChainAuditLog

class VisionModelTier(str, Enum):
    """Vision model tier toggle for speed vs. high-accuracy fallback (Task #117)."""
    FAST = "fast_moondream"          # ~1.8B lightweight model, ultra fast (<200ms)
    HIGH_ACCURACY = "high_acc_qwen2_vl" # ~7B heavier model for complex visual parsing

class VisionPipeline:
    """
    End-to-End Vision Perception & Grounding Pipeline (Task #37, #53, #117, #170).
    Connects screenshot ingestion -> region foveation -> tag overlay -> evidence logging.
    """

    def __init__(self, model_tier: VisionModelTier = VisionModelTier.FAST):
        self.model_tier = model_tier
        self.preprocessor = ScreenshotPreprocessor()
        self.foveator = FoveatedRegionLocator()
        self.grounder = NumberedTagGrounding()
        self.router = DOMVisionRouter()
        self.audit_log = HashChainAuditLog()
        self.pop = ProofOfPerception(self.audit_log)

    def set_model_tier(self, tier: VisionModelTier):
        """Toggle between fast and high-accuracy vision models (Task #117)."""
        self.model_tier = tier
        logging.info(f"Vision model tier switched to: {tier.value}")

    def process_perception(
        self,
        command: str,
        dom_data: Dict[str, Any],
        screenshot_base64: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Execute vision pipeline with internal stage timing.
        """
        metrics = {}
        t0 = time.perf_counter()

        # 1. Routing Decision
        route = self.router.evaluate_route(dom_data, command)
        t_route = time.perf_counter()
        metrics["router_time_ms"] = round((t_route - t0) * 1000, 2)

        if route == PerceptionRoute.DOM_FAST_PATH or not screenshot_base64:
            return {
                "route": route.value,
                "metrics": metrics,
                "foveated": False,
                "model_tier": self.model_tier.value,
                "image_base64": None
            }

        # 2. Decode & Normalize Screenshot
        t1 = time.perf_counter()
        raw_image = self.preprocessor.decode_base64_image(screenshot_base64)
        t_decode = time.perf_counter()
        metrics["decode_time_ms"] = round((t_decode - t1) * 1000, 2)

        # 3. Foveated Sub-region Localization
        t2 = time.perf_counter()
        elements = dom_data.get("elements", [])
        clusters = self.foveator.locate_interactive_clusters(elements)
        t_fovea = time.perf_counter()
        metrics["foveation_time_ms"] = round((t_fovea - t2) * 1000, 2)

        target_image = raw_image
        if clusters:
            primary_box = clusters[0]["bbox"]
            target_image = self.preprocessor.crop_region(raw_image, primary_box)

        # 4. Numbered-tag Grounding Overlay
        t3 = time.perf_counter()
        grounded_image = self.grounder.apply_grounding_overlay(target_image, elements)
        t_ground = time.perf_counter()
        metrics["grounding_time_ms"] = round((t_ground - t3) * 1000, 2)

        total_time = round((time.perf_counter() - t0) * 1000, 2)
        metrics["total_vision_time_ms"] = total_time

        return {
            "route": route.value,
            "metrics": metrics,
            "foveated": len(clusters) > 0,
            "model_tier": self.model_tier.value,
            "processed_image_base64": self.preprocessor.encode_image_base64(grounded_image)
        }
