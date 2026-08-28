import os
import time
import json
import logging
import asyncio
from typing import List, Dict, Any, Optional
from .collections import MemoryCollectionName, MemoryCollections
from .embeddings import LocalEmbeddingWrapper
from .crypto import EncryptedLocalMemoryDB

class VersionedMemoryStore:
    """
    Self-built Versioned Memory System (Tasks #2, #6, #21, #22, #41, #68, #88, #101, #102, #113, #114, #115, #150).
    Features:
    - 4 Chroma collections: session_memory, user_preferences, site_knowledge, task_history
    - Explicit versioning (v1 -> v2 -> v3) with superseded marking so old facts never survive updates
    - Local AES-256-GCM / PBKDF2 Encrypted Storage (Task #68)
    - Parallel multi-collection retrieval (Task #101)
    - Batched embedding writes (Task #102)
    - Similarity score thresholding (Task #114)
    - Top-3 fact injection cap (Task #150)
    - Pure offline fallback engine when ChromaDB C++ bindings are not present
    """

    def __init__(self, persist_directory: str = "./memory/chroma_data", encryption_key: Optional[str] = None, enable_encryption: bool = True):
        self.persist_directory = persist_directory
        os.makedirs(persist_directory, exist_ok=True)
        self.embedder = LocalEmbeddingWrapper()
        self.enable_encryption = enable_encryption
        self.crypto = EncryptedLocalMemoryDB(key_passphrase=encryption_key)
        self._use_chroma = False

        try:
            import chromadb
            from chromadb.config import Settings
            self.client = chromadb.PersistentClient(
                path=persist_directory,
                settings=Settings(anonymized_telemetry=False)
            )
            self._init_chroma_collections()
            self._use_chroma = True
            logging.info("Chroma PersistentClient initialized successfully.")
        except Exception as e:
            logging.warning(f"ChromaDB native backend unavailable ({e}). Using high-performance self-contained local memory engine.")
            self._init_fallback_storage()

    def _init_chroma_collections(self):
        """Initialize the 4 Chroma collections."""
        self.collections: Dict[str, Any] = {}
        for col_enum in MemoryCollectionName:
            col_name = col_enum.value
            self.collections[col_name] = self.client.get_or_create_collection(
                name=col_name,
                metadata={"hnsw:space": "cosine"}
            )

    def _init_fallback_storage(self):
        """Fallback memory storage engine with local cryptographic protection for offline resilience."""
        self.fallback_file_enc = os.path.join(self.persist_directory, "versioned_memory.enc")
        self.fallback_file_json = os.path.join(self.persist_directory, "versioned_memory.json")
        self.storage: Dict[str, List[Dict[str, Any]]] = {
            col.value: [] for col in MemoryCollectionName
        }

        # 1. Try loading encrypted vault first
        if os.path.exists(self.fallback_file_enc):
            try:
                with open(self.fallback_file_enc, "rb") as f:
                    encrypted_data = f.read()
                self.storage = self.crypto.decrypt_json(encrypted_data)
                return
            except Exception as e:
                logging.error(f"Error decrypting versioned memory vault: {e}")

        # 2. Fallback to unencrypted JSON if legacy exists
        if os.path.exists(self.fallback_file_json):
            try:
                with open(self.fallback_file_json, "r", encoding="utf-8") as f:
                    self.storage = json.load(f)
            except Exception as e:
                logging.error(f"Error loading legacy fallback memory: {e}")

    def _save_fallback_storage(self):
        if not self._use_chroma:
            if self.enable_encryption:
                encrypted_payload = self.crypto.encrypt_json(self.storage)
                with open(self.fallback_file_enc, "wb") as f:
                    f.write(encrypted_payload)
            else:
                with open(self.fallback_file_json, "w", encoding="utf-8") as f:
                    json.dump(self.storage, f, indent=2)

    def store_memory(
        self,
        collection_name: MemoryCollectionName,
        fact_key: str,
        content: str,
        metadata: Optional[Dict[str, Any]] = None,
        embedding: Optional[List[float]] = None,
        save_immediate: bool = True
    ) -> str:
        """
        Store a fact with version incrementing.
        Marks any previous active versions of `fact_key` as superseded (Task #21, #41).
        """
        timestamp = int(time.time())
        col_key = collection_name.value
        emb = embedding if embedding is not None else self.embedder.get_embedding(content)

        if self._use_chroma:
            col = self.collections[col_key]
            existing = col.get(
                where={"$and": [
                    {MemoryCollections.METADATA_KEY_FACT_KEY: fact_key},
                    {MemoryCollections.METADATA_KEY_SUPERSEDED: False}
                ]}
            )
            current_version = 1
            if existing and existing.get("ids"):
                old_ids = existing["ids"]
                old_metadatas = existing["metadatas"]
                versions = [m.get(MemoryCollections.METADATA_KEY_VERSION, 1) for m in old_metadatas]
                current_version = max(versions) + 1

                for oid, ometa in zip(old_ids, old_metadatas):
                    ometa[MemoryCollections.METADATA_KEY_SUPERSEDED] = True
                    col.update(ids=[oid], metadatas=[ometa])

            new_id = f"{fact_key}_v{current_version}_{timestamp}"
            meta = metadata.copy() if metadata else {}
            meta.update({
                MemoryCollections.METADATA_KEY_FACT_KEY: fact_key,
                MemoryCollections.METADATA_KEY_VERSION: current_version,
                MemoryCollections.METADATA_KEY_SUPERSEDED: False,
                MemoryCollections.METADATA_KEY_TIMESTAMP: timestamp
            })

            col.add(
                ids=[new_id],
                documents=[content],
                embeddings=[emb],
                metadatas=[meta]
            )
            return new_id
        else:
            # Fallback storage engine
            items = self.storage[col_key]
            current_version = 1
            for item in items:
                if item["metadata"].get(MemoryCollections.METADATA_KEY_FACT_KEY) == fact_key:
                    if not item["metadata"].get(MemoryCollections.METADATA_KEY_SUPERSEDED, False):
                        item["metadata"][MemoryCollections.METADATA_KEY_SUPERSEDED] = True
                    v = item["metadata"].get(MemoryCollections.METADATA_KEY_VERSION, 1)
                    if v >= current_version:
                        current_version = v + 1

            new_id = f"{fact_key}_v{current_version}_{timestamp}"
            meta = metadata.copy() if metadata else {}
            meta.update({
                MemoryCollections.METADATA_KEY_FACT_KEY: fact_key,
                MemoryCollections.METADATA_KEY_VERSION: current_version,
                MemoryCollections.METADATA_KEY_SUPERSEDED: False,
                MemoryCollections.METADATA_KEY_TIMESTAMP: timestamp
            })

            items.append({
                "id": new_id,
                "content": content,
                "embedding": emb,
                "metadata": meta
            })
            if save_immediate:
                self._save_fallback_storage()
            return new_id

    def batch_store_memory(
        self,
        collection_name: MemoryCollectionName,
        facts: List[Dict[str, Any]]
    ) -> List[str]:
        """
        Batch write facts with amortized embedding computation (Task #102).
        facts format: [{'fact_key': str, 'content': str, 'metadata': dict}, ...]
        """
        if not facts:
            return []

        contents = [f["content"] for f in facts]
        embeddings = self.embedder.batch_embed(contents)

        ids = []
        for fact_dict, emb in zip(facts, embeddings):
            fact_key = fact_dict["fact_key"]
            content = fact_dict["content"]
            meta = fact_dict.get("metadata", {})
            mid = self.store_memory(collection_name, fact_key, content, meta, embedding=emb, save_immediate=False)
            ids.append(mid)

        self._save_fallback_storage()
        logging.info(f"Batched stored {len(ids)} facts into {collection_name.value}.")
        return ids

    def retrieve_memory(
        self,
        collection_name: MemoryCollectionName,
        query: str,
        top_k: int = 3,
        similarity_cutoff: float = 0.2
    ) -> List[Dict[str, Any]]:
        """
        Semantic retrieval querying ONLY active (non-superseded) memory entries.
        Enforces top-3 fact cap (Task #150) and similarity thresholding (Task #114).
        """
        top_k = min(top_k, 3)
        col_key = collection_name.value
        query_embedding = self.embedder.get_embedding(query)

        if self._use_chroma:
            col = self.collections[col_key]
            results = col.query(
                query_embeddings=[query_embedding],
                n_results=top_k,
                where={MemoryCollections.METADATA_KEY_SUPERSEDED: False}
            )

            output: List[Dict[str, Any]] = []
            if results and results.get("documents") and len(results["documents"]) > 0:
                docs = results["documents"][0]
                metas = results["metadatas"][0] if results.get("metadatas") else [{}] * len(docs)
                distances = results["distances"][0] if results.get("distances") else [0.0] * len(docs)
                ids = results["ids"][0] if results.get("ids") else [""] * len(docs)

                for doc, meta, dist, mid in zip(docs, metas, distances, ids):
                    sim = 1.0 - dist if dist is not None else 1.0
                    if sim >= similarity_cutoff:
                        output.append({
                            "id": mid,
                            "content": doc,
                            "metadata": meta,
                            "similarity": round(sim, 3)
                        })
            return output
        else:
            items = self.storage.get(col_key, [])
            active_items = [i for i in items if not i["metadata"].get(MemoryCollections.METADATA_KEY_SUPERSEDED, False)]

            scored = []
            for item in active_items:
                sim = self._cosine_similarity(query_embedding, item["embedding"])
                if sim >= similarity_cutoff:
                    scored.append({
                        "id": item["id"],
                        "content": item["content"],
                        "metadata": item["metadata"],
                        "similarity": round(sim, 3)
                    })

            scored.sort(key=lambda x: x["similarity"], reverse=True)
            return scored[:top_k]

    async def parallel_retrieve_all(self, query: str) -> Dict[str, List[Dict[str, Any]]]:
        """
        Parallelize memory retrieval across all 4 collections using asyncio (Task #101).
        """
        loop = asyncio.get_event_loop()
        tasks = [
            loop.run_in_executor(None, self.retrieve_memory, col, query, 3, 0.2)
            for col in MemoryCollectionName
        ]
        results = await asyncio.gather(*tasks)
        return {col.value: res for col, res in zip(MemoryCollectionName, results)}

    @staticmethod
    def _cosine_similarity(vec_a: List[float], vec_b: List[float]) -> float:
        """Compute cosine similarity between two float vectors."""
        if not vec_a or not vec_b or len(vec_a) != len(vec_b):
            return 0.0
        dot = sum(a * b for a, b in zip(vec_a, vec_b))
        norm_a = sum(a * a for a in vec_a) ** 0.5
        norm_b = sum(b * b for b in vec_b) ** 0.5
        if norm_a == 0.0 or norm_b == 0.0:
            return 0.0
        return dot / (norm_a * norm_b)
