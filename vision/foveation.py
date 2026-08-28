import logging
from typing import List, Dict, Any

class FoveatedRegionLocator:
    """
    Foveation Engine (Task #19, #38, #116).
    Identifies high-priority bounding boxes of interactive sub-regions to avoid full-frame inference.
    """

    def __init__(self, padding_px: int = 20):
        self.padding_px = padding_px

    def locate_interactive_clusters(self, elements: List[Dict[str, Any]], max_regions: int = 3) -> List[Dict[str, Any]]:
        """
        Group nearby interactive elements into 1-3 focal bounding boxes (fovea patches).
        """
        if not elements:
            return []

        # Extract bounding boxes
        valid_boxes = []
        for el in elements:
            bbox = el.get("bbox")
            if bbox and bbox.get("w", 0) > 0 and bbox.get("h", 0) > 0:
                valid_boxes.append({
                    "tag_id": el.get("tag_id"),
                    "x": bbox["x"],
                    "y": bbox["y"],
                    "w": bbox["w"],
                    "h": bbox["h"]
                })

        if not valid_boxes:
            return []

        # Simple clustering / bounding envelope for prioritized subregions
        # Calculate full envelope with padding
        min_x = max(0, min(b["x"] for b in valid_boxes) - self.padding_px)
        min_y = max(0, min(b["y"] for b in valid_boxes) - self.padding_px)
        max_x = max(b["x"] + b["w"] for b in valid_boxes) + self.padding_px
        max_y = max(b["y"] + b["h"] for b in valid_boxes) + self.padding_px

        primary_region = {
            "region_id": 1,
            "bbox": {
                "x": min_x,
                "y": min_y,
                "w": max_x - min_x,
                "h": max_y - min_y
            },
            "tag_ids": [b["tag_id"] for b in valid_boxes]
        }

        logging.info(f"Foveation located primary interactive cluster: {primary_region['bbox']}")
        return [primary_region]
