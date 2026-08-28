"""
SIH26171 — Memory Module Unit & Stress Test Suite
Owner: Siddu (Integration Lead)
Tasks: #41, #88, #101, #102, #113, #114, #115, #135, #150
"""

import os
import time
import asyncio
import unittest
import shutil
from memory.collections import MemoryCollectionName, MemoryCollections
from memory.store import VersionedMemoryStore
from memory.workflow_cache import WorkflowCache

class TestVersionedMemory(unittest.TestCase):

    def setUp(self):
        self.test_dir = "./memory/test_chroma_data"
        if os.path.exists(self.test_dir):
            shutil.rmtree(self.test_dir)
        self.store = VersionedMemoryStore(persist_directory=self.test_dir)

    def tearDown(self):
        if os.path.exists(self.test_dir):
            shutil.rmtree(self.test_dir)

    def test_versioning_and_superseded_overwrite(self):
        """Task #41 & #135: Overwrite the same fact 4 times; confirm only the latest version is active."""
        fact_key = "user_default_station"

        # Write v1
        self.store.store_memory(MemoryCollectionName.USER_PREFERENCES, fact_key, "Default station is Bengaluru")
        # Write v2
        self.store.store_memory(MemoryCollectionName.USER_PREFERENCES, fact_key, "Default station is Ahmedabad")
        # Write v3
        self.store.store_memory(MemoryCollectionName.USER_PREFERENCES, fact_key, "Default station is Sriharikota SDSC")
        # Write v4
        final_id = self.store.store_memory(MemoryCollectionName.USER_PREFERENCES, fact_key, "Default station is ISTRAC BLR Ground Station")

        # Retrieve
        results = self.store.retrieve_memory(MemoryCollectionName.USER_PREFERENCES, "What is the default station?")
        self.assertEqual(len(results), 1, "Only the latest active version must be returned!")
        self.assertIn("ISTRAC BLR", results[0]["content"])
        self.assertEqual(results[0]["metadata"]["version"], 4)
        self.assertFalse(results[0]["metadata"]["superseded"])

    def test_paraphrased_repeat_command_retrieval(self):
        """Task #88: Paraphrased repeat query should retrieve the correct stored fact."""
        self.store.store_memory(
            MemoryCollectionName.SITE_KNOWLEDGE,
            "cartosat_calibration_flow",
            "To calibrate Cartosat-3A, click the Calibrate button in row 1, then confirm the prompt."
        )

        query = "How do I perform Cartosat sensor calibration?"
        results = self.store.retrieve_memory(MemoryCollectionName.SITE_KNOWLEDGE, query)
        self.assertTrue(len(results) > 0)
        self.assertIn("Cartosat-3A", results[0]["content"])

    def test_top_3_fact_injection_cap(self):
        """Task #150: Enforce that no query retrieves more than top-3 facts."""
        for i in range(10):
            self.store.store_memory(
                MemoryCollectionName.SESSION_MEMORY,
                f"session_step_{i}",
                f"Action step {i} was executed on page XYZ"
            )

        results = self.store.retrieve_memory(MemoryCollectionName.SESSION_MEMORY, "step", top_k=8)
        self.assertLessEqual(len(results), 3, "Memory context must be hard-capped to top-3 facts max!")

    def test_batch_embedding_writes(self):
        """Task #102: Batch storing multiple facts."""
        facts = [
            {"fact_key": f"batch_item_{i}", "content": f"Telemetry fact {i}", "metadata": {"index": i}}
            for i in range(5)
        ]
        t0 = time.perf_counter()
        ids = self.store.batch_store_memory(MemoryCollectionName.TASK_HISTORY, facts)
        t_batch = time.perf_counter() - t0

        self.assertEqual(len(ids), 5)
        self.assertLess(t_batch, 2.0, "Batch write should be fast and amortized.")

    def test_workflow_cache_invalidation_on_changed_layout(self):
        """Task #79 & #132: Workflow cache must replay on identical DOM and invalidate on changed layout."""
        cache = WorkflowCache()
        dom_original = [
            {"tag": "button", "text": "Calibrate"},
            {"tag": "input", "text": "Search"}
        ]
        dom_altered = [
            {"tag": "button", "text": "Delete All Records"},
            {"tag": "input", "text": "Search"}
        ]

        plan = {"actions": [{"step": 0, "action": "click", "tag_id": 1}]}
        cache.cache_workflow("task_calibrate", dom_original, plan)

        # 1. Hit on original DOM
        hit_plan = cache.get_cached_plan("task_calibrate", dom_original)
        self.assertIsNotNone(hit_plan, "Cache must HIT on unmodified layout.")

        # 2. Miss & Invalidation on altered DOM
        miss_plan = cache.get_cached_plan("task_calibrate", dom_altered)
        self.assertIsNone(miss_plan, "Cache must INVALIDATE on altered layout.")

    def test_parallel_retrieval(self):
        """Task #101: Parallel retrieval across all 4 collections."""
        self.store.store_memory(MemoryCollectionName.USER_PREFERENCES, "pref_theme", "Dark mode is preferred")
        self.store.store_memory(MemoryCollectionName.SESSION_MEMORY, "active_tab", "Active tab is Telemetry")

        async def run_parallel():
            return await self.store.parallel_retrieve_all("theme preferences")

        all_res = asyncio.run(run_parallel())
        self.assertIn("user_preferences", all_res)
        self.assertIn("session_memory", all_res)

if __name__ == "__main__":
    unittest.main()
