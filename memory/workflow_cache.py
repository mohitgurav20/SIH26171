import hashlib
import json
import logging
from typing import Dict, Any, Optional

class WorkflowCache:
    """
    Workflow Schema Caching with Page Layout Invalidation (Task #72, #79, #132).
    Allows repeat multi-step tasks to skip LLM reasoning while safely invalidating on layout changes.
    """

    def __init__(self, store=None):
        self.store = store
        self._cache: Dict[str, Dict[str, Any]] = {}

    def _compute_layout_hash(self, dom_elements: list) -> str:
        """Hash key element tag names and texts to detect DOM structure modifications."""
        sig = "|".join(f"{e.get('tag')}:{e.get('text', '')[:20]}" for e in dom_elements[:20])
        return hashlib.sha256(sig.encode('utf-8')).hexdigest()

    def get_cached_plan(self, task_key: str, current_dom_elements: list) -> Optional[Dict[str, Any]]:
        """Retrieve cached workflow only if current layout hash matches."""
        entry = self._cache.get(task_key)
        if not entry:
            return None

        current_hash = self._compute_layout_hash(current_dom_elements)
        if entry["layout_hash"] != current_hash:
            logging.warning(f"Workflow cache invalidated for '{task_key}': DOM layout changed.")
            del self._cache[task_key]
            return None

        logging.info(f"Workflow cache HIT for '{task_key}'. Replaying deterministic plan.")
        return entry["plan"]

    def cache_workflow(self, task_key: str, current_dom_elements: list, plan: Dict[str, Any]):
        """Save a proven successful multi-action plan linked to its DOM signature."""
        layout_hash = self._compute_layout_hash(current_dom_elements)
        self._cache[task_key] = {
            "layout_hash": layout_hash,
            "plan": plan
        }
        logging.info(f"Cached workflow for '{task_key}' with layout hash {layout_hash[:8]}.")
