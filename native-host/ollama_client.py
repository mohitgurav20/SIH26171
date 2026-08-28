import json
import logging
import httpx
from typing import Dict, Any, Optional

class OllamaClient:
    """Local Ollama client wrapper with warm-keeping and error handling (Task #29, #49)."""

    def __init__(self, base_url: str = "http://127.0.0.1:11434"):
        self.base_url = base_url
        self.client = httpx.AsyncClient(base_url=base_url, timeout=30.0)

    async def check_health(self) -> bool:
        """Verify Ollama service is reachable offline."""
        try:
            res = await self.client.get("/api/tags")
            return res.status_code == 200
        except Exception as e:
            logging.error(f"Ollama healthcheck failed: {e}")
            return False

    async def generate(self, model: str, prompt: str, system: Optional[str] = None, format: Optional[str] = "json", options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Send prompt and receive response with structured JSON enforcement."""
        payload: Dict[str, Any] = {
            "model": model,
            "prompt": prompt,
            "stream": False
        }
        if system:
            payload["system"] = system
        if format:
            payload["format"] = format
        if options:
            payload["options"] = options

        try:
            response = await self.client.post("/api/generate", json=payload)
            response.raise_for_status()
            data = response.json()
            return data
        except Exception as e:
            logging.error(f"Ollama generation failed for model {model}: {e}")
            raise

    async def get_embeddings(self, model: str, prompt: str) -> list[float]:
        """Compute local embeddings for memory indexing and queries."""
        try:
            response = await self.client.post("/api/embeddings", json={"model": model, "prompt": prompt})
            response.raise_for_status()
            return response.json().get("embedding", [])
        except Exception as e:
            logging.error(f"Embedding calculation failed: {e}")
            raise
