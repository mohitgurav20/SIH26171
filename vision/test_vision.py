"""
SIH26171 — Vision & Perception Module Unit & Stress Test Suite
Owner: Siddu (Integration Lead)
Tasks: #37, #55, #70, #71, #89, #116, #134, #137
"""

import unittest
import base64
import io
from PIL import Image

from vision.router import DOMVisionRouter, PerceptionRoute
from vision.proof_of_perception import HashChainAuditLog, ProofOfPerception
from vision.grounding import NumberedTagGrounding
from vision.foveation import FoveatedRegionLocator
from vision.preprocessing import ScreenshotPreprocessor
from vision.pipeline import VisionPipeline

class TestVisionAndPerception(unittest.TestCase):

    def setUp(self):
        self.router = DOMVisionRouter()
        self.audit_log = HashChainAuditLog()
        self.pop = ProofOfPerception(self.audit_log)
        self.grounder = NumberedTagGrounding()
        self.foveator = FoveatedRegionLocator()
        self.preprocessor = ScreenshotPreprocessor()
        self.pipeline = VisionPipeline()

    # ========================================================
    # Task #134: Router Boundary Unit Tests (5+ Boundary Cases)
    # ========================================================

    def test_router_case_1_clear_dom_match(self):
        """Boundary Case 1: Standard interactive DOM with clear text match."""
        dom_data = {
            "elements": [
                {"tag_id": 1, "tag": "button", "text": "Submit Mission Report", "aria_label": None},
                {"tag_id": 2, "tag": "input", "text": "", "aria_label": "Search satellite"}
            ]
        }
        route = self.router.evaluate_route(dom_data, "Click the Submit button")
        self.assertEqual(route, PerceptionRoute.DOM_FAST_PATH, "Clear DOM match must use DOM Fast Path!")

    def test_router_case_2_empty_dom_canvas(self):
        """Boundary Case 2: Zero DOM elements (Canvas / WebGL / SVG page)."""
        dom_data = {"elements": []}
        route = self.router.evaluate_route(dom_data, "Calibrate telemetry")
        self.assertEqual(route, PerceptionRoute.VISION_FOVEATED, "Empty DOM must escalate to vision!")

    def test_router_case_3_visual_keyword_intent(self):
        """Boundary Case 3: Explicit visual intent (map / orbit / canvas / chart)."""
        dom_data = {
            "elements": [{"tag_id": 1, "tag": "button", "text": "Filter"}]
        }
        route = self.router.evaluate_route(dom_data, "Inspect the satellite orbit canvas trajectory")
        self.assertEqual(route, PerceptionRoute.VISION_FOVEATED, "Visual keyword must route to Vision!")

    def test_router_case_4_ambiguous_unlabelled_elements(self):
        """Boundary Case 4: DOM has elements, but labels are ambiguous or unrelated."""
        dom_data = {
            "elements": [
                {"tag_id": 1, "tag": "div", "text": "Item A"},
                {"tag_id": 2, "tag": "div", "text": "Item B"}
            ]
        }
        route = self.router.evaluate_route(dom_data, "Authorize high-gain antenna slew")
        self.assertEqual(route, PerceptionRoute.VISION_FOVEATED, "Ambiguous DOM elements must escalate to Vision.")

    def test_router_case_5_aria_label_matching(self):
        """Boundary Case 5: Element with no visible text but clear ARIA label."""
        dom_data = {
            "elements": [
                {"tag_id": 1, "tag": "button", "text": "", "aria_label": "Calibrate Sensor"}
            ]
        }
        route = self.router.evaluate_route(dom_data, "Calibrate sensor")
        self.assertEqual(route, PerceptionRoute.DOM_FAST_PATH, "ARIA label match should be recognized by DOM fast path.")

    # ========================================================
    # Task #137: Evidence Records Complete for EVERY Action Type
    # ========================================================

    def test_evidence_for_click_action(self):
        """Verify complete evidence justification for CLICK action."""
        valid, entry = self.pop.validate_and_record(
            action_type="click",
            element_text="Calibrate",
            reason="Matched intent 'calibrate spacecraft' to element #1",
            dom_snippet="<button id='cal-1'>Calibrate</button>"
        )
        self.assertTrue(valid)
        self.assertIsNotNone(entry)
        self.assertEqual(entry["action"], "click")
        self.assertIn("Calibrate", entry["target"])

    def test_evidence_for_type_action(self):
        """Verify complete evidence justification for TYPE action."""
        valid, entry = self.pop.validate_and_record(
            action_type="type",
            element_text="Search Filter Box",
            reason="Inputting query 'Cartosat-3A' into search input",
            dom_snippet="<input id='search-filter' placeholder='Search satellite...'>"
        )
        self.assertTrue(valid)
        self.assertEqual(entry["action"], "type")

    def test_evidence_for_scroll_action(self):
        """Verify complete evidence justification for SCROLL action."""
        valid, entry = self.pop.validate_and_record(
            action_type="scroll",
            element_text="Telemetry Table Viewport",
            reason="Scrolling 400px down to reveal rows 10-15",
            crop_base64="dummy_crop_base64"
        )
        self.assertTrue(valid)
        self.assertEqual(entry["action"], "scroll")

    def test_evidence_refusal_on_missing_justification(self):
        """Block any action candidate lacking proof evidence."""
        valid, entry = self.pop.validate_and_record(
            action_type="click",
            element_text="",
            reason=""  # Missing reason and target!
        )
        self.assertFalse(valid, "Proof-of-Perception must refuse actions without evidence!")
        self.assertIsNone(entry)

    # ========================================================
    # Task #71 & #89: Cryptographic Hash-Chain Tamper-Resistance
    # ========================================================

    def test_hash_chain_valid_verification(self):
        """Clean hash-chain must pass verification 100%."""
        self.audit_log.append_action("click", "Btn 1", "Reason 1")
        self.audit_log.append_action("type", "Input 2", "Reason 2")
        self.audit_log.append_action("scroll", "Viewport", "Reason 3")

        is_valid, msg = self.audit_log.verify_chain()
        self.assertTrue(is_valid, "Untampered chain must pass verification!")
        self.assertIn("zero tampering", msg)

    def test_hash_chain_tamper_detection(self):
        """Modifying a past log entry must immediately break verification."""
        self.audit_log.append_action("click", "Btn 1", "Reason 1")
        self.audit_log.append_action("click", "Btn 2", "Reason 2")
        self.audit_log.append_action("click", "Btn 3", "Reason 3")

        # Deliberately tamper with past record (index #1)
        self.audit_log.chain[1]["target"] = "TAMPERED_BUTTON_TARGET"

        is_valid, msg = self.audit_log.verify_chain()
        self.assertFalse(is_valid, "Tampered chain must FAIL verification!")
        self.assertIn("Tamper detected at index #1", msg)

    # ========================================================
    # Task #37 & #116: End-to-End Pipeline & Foveation Timing
    # ========================================================

    def test_foveated_vision_pipeline_execution(self):
        """Test full vision pipeline with fake 1080p screenshot."""
        test_img = Image.new("RGB", (1280, 720), color=(10, 15, 29))
        buf = io.BytesIO()
        test_img.save(buf, format="PNG")
        b64_img = base64.b64encode(buf.getvalue()).decode("utf-8")

        dom_data = {
            "elements": [
                {"tag_id": 1, "tag": "button", "text": "Calibrate", "bbox": {"x": 100, "y": 150, "w": 80, "h": 30}},
                {"tag_id": 2, "tag": "input", "text": "", "bbox": {"x": 200, "y": 150, "w": 120, "h": 30}}
            ]
        }

        # Force vision route with visual keyword
        result = self.pipeline.process_perception("Locate the canvas telemetry widget", dom_data, b64_img)

        self.assertIn("metrics", result)
        self.assertIn("total_vision_time_ms", result["metrics"])
        self.assertTrue(result["foveated"])
        self.assertIsNotNone(result.get("processed_image_base64"))
        self.assertLess(result["metrics"]["total_vision_time_ms"], 500, "Vision pipeline should be lightweight and sub-second.")

if __name__ == "__main__":
    unittest.main()
