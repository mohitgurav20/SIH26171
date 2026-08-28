import httpx
import logging
from typing import List

class LocalEmbeddingWrapper:
    """
    Offline embedding generator connecting to local Ollama instance (Task #21, #149).
    Includes in-memory vector caching for repeated query optimization.
    """

    def __init__(self, model: str = "nomic-embed-text", base_url: str = "http://127.0.0.1:11434"):
        self.model = model
        self.base_url = base_url
        self._cache: dict[str, List[float]] = {}

    def get_embedding(self, text: str) -> List[float]:
        """Compute or retrieve cached vector embedding for a given text snippet."""
        clean_text = text.strip()
        if clean_text in self._cache:
            return self._cache[clean_text]

        try:
            with httpx.Client(base_url=self.base_url, timeout=10.0) as client:
                res = client.post("/api/embeddings", json={"model": self.model, "prompt": clean_text})
                res.raise_for_status()
                vector = res.json().get("embedding", [])
                self._cache[clean_text] = vector
                return vector
        except Exception as e:
            logging.error(f"Offline embedding extraction failed: {e}")
            # Fallback zero-vector for testing if Ollama is not active
            return [0.0] * 768

    def batch_embed(self, texts: List[str]) -> List[List[float]]:
        """Batch embedding computation for multiple memory entries (Task #102)."""
        return [self.get_embedding(t) for t in texts]
