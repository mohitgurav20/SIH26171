import socket
import logging
import hashlib
import math
from typing import List, Optional

class LocalEmbeddingWrapper:
    """
    Offline embedding generator connecting to local Ollama instance (Task #21, #149).
    Includes in-memory vector caching and fast deterministic offline fallback.
    """

    _GLOBAL_OLLAMA_STATUS: Optional[bool] = None

    def __init__(self, model: str = "nomic-embed-text", host: str = "127.0.0.1", port: int = 11434):
        self.model = model
        self.host = host
        self.port = port
        self._cache: dict[str, List[float]] = {}

    @classmethod
    def check_ollama_available(cls, host: str = "127.0.0.1", port: int = 11434) -> bool:
        if cls._GLOBAL_OLLAMA_STATUS is not None:
            return cls._GLOBAL_OLLAMA_STATUS
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(0.05)
            s.connect((host, port))
            s.close()
            cls._GLOBAL_OLLAMA_STATUS = True
        except Exception:
            cls._GLOBAL_OLLAMA_STATUS = False
        return cls._GLOBAL_OLLAMA_STATUS

    def _generate_deterministic_vector(self, text: str, dim: int = 128) -> List[float]:
        """Compute deterministic text vector for fast offline execution."""
        words = text.lower().replace(",", " ").replace(".", " ").replace("?", " ").split()
        vec = [0.0] * dim
        for w in words:
            ngrams = [w[i:i+3] for i in range(max(1, len(w) - 2))]
            for ng in ngrams:
                h = int(hashlib.md5(ng.encode('utf-8')).hexdigest()[:8], 16)
                idx = h % dim
                vec[idx] += 1.0

        norm = math.sqrt(sum(x * x for x in vec))
        if norm > 0:
            vec = [x / norm for x in vec]
        return vec

    def get_embedding(self, text: str) -> List[float]:
        """Compute or retrieve cached vector embedding for a given text snippet."""
        clean_text = text.strip()
        if clean_text in self._cache:
            return self._cache[clean_text]

        if self.check_ollama_available(self.host, self.port):
            try:
                import httpx
                with httpx.Client(base_url=f"http://{self.host}:{self.port}", timeout=5.0) as client:
                    res = client.post("/api/embeddings", json={"model": self.model, "prompt": clean_text})
                    res.raise_for_status()
                    vector = res.json().get("embedding", [])
                    self._cache[clean_text] = vector
                    return vector
            except Exception as e:
                logging.warning(f"Ollama embedding request failed: {e}. Using deterministic fallback.")

        vector = self._generate_deterministic_vector(clean_text)
        self._cache[clean_text] = vector
        return vector

    def batch_embed(self, texts: List[str]) -> List[List[float]]:
        """Batch embedding computation for multiple memory entries (Task #102)."""
        return [self.get_embedding(t) for t in texts]
