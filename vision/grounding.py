import logging
from typing import List, Dict, Any
from PIL import Image, ImageDraw, ImageFont

class NumberedTagGrounding:
    """
    Set-of-Marks Numbered Tag Grounding Engine (Task #20, #43, #108).
    Overlays discrete, high-contrast numbered badge tags on interactive elements so LLMs output tag numbers, never raw coordinates.
    """

    def __init__(self, badge_color: str = "#FF0055", text_color: str = "#FFFFFF"):
        self.badge_color = badge_color
        self.text_color = text_color

    def apply_grounding_overlay(self, image: Image.Image, elements: List[Dict[str, Any]]) -> Image.Image:
        """
        Draw numbered tags directly onto a copy of the screenshot for vision model grounding.
        """
        canvas = image.copy()
        draw = ImageDraw.Draw(canvas)

        for el in elements:
            tag_id = el.get("tag_id")
            bbox = el.get("bbox")
            if not bbox or tag_id is None:
                continue

            x = bbox.get("x", 0)
            y = bbox.get("y", 0)
            w = bbox.get("w", 0)
            h = bbox.get("h", 0)

            # Draw element boundary outline
            draw.rectangle([x, y, x + w, y + h], outline=self.badge_color, width=2)

            # Draw numbered tag badge box in upper-left corner
            tag_text = str(tag_id)
            badge_w = max(18, len(tag_text) * 10 + 6)
            badge_h = 16
            draw.rectangle([x, y - badge_h, x + badge_w, y], fill=self.badge_color)
            draw.text((x + 3, y - badge_h + 1), tag_text, fill=self.text_color)

        logging.info(f"Numbered-tag grounding applied to {len(elements)} elements.")
        return canvas
