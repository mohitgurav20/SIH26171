import base64
import io
import logging
from PIL import Image
from typing import Tuple, Optional

class ScreenshotPreprocessor:
    """
    Screenshot capture normalization & image preprocessing (Task #18).
    Handles decoding, dimensions validation, aspect ratio padding, and compression.
    """

    @staticmethod
    def decode_base64_image(base64_str: str) -> Image.Image:
        """Decode a base64 encoded PNG/JPEG into a PIL Image."""
        if "," in base64_str:
            base64_str = base64_str.split(",")[1]
        img_data = base64.b64decode(base64_str)
        return Image.open(io.BytesIO(img_data)).convert("RGB")

    @staticmethod
    def encode_image_base64(image: Image.Image, format: str = "PNG") -> str:
        """Encode a PIL Image back to a base64 string."""
        buf = io.BytesIO()
        image.save(buf, format=format)
        return base64.b64encode(buf.getvalue()).decode("utf-8")

    @staticmethod
    def crop_region(image: Image.Image, bbox: dict) -> Image.Image:
        """
        Crop an interactive region (foveation patch) from the main screenshot.
        bbox format: {'x': int, 'y': int, 'w': int, 'h': int}
        """
        left = max(0, int(bbox.get("x", 0)))
        top = max(0, int(bbox.get("y", 0)))
        right = min(image.width, left + int(bbox.get("w", 0)))
        bottom = min(image.height, top + int(bbox.get("h", 0)))
        return image.crop((left, top, right, bottom))
