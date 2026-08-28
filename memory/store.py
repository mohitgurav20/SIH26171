import os
import time
import logging
from typing import List, Dict, Any, Optional
import chromadb
from chromadb.config import Settings
from .collections import MemoryCollectionName, MemoryCollections
from .embeddings import LocalEmbeddingWrapper

class VersionedMemoryStore:
    """
    Self-built Versioned Memory Store using local Chroma PersistentClient (Task #2, #6, #21, #22, #41, #150).
    Features explicit fact versioning & superseding to prevent old facts from surviving updates.
    """

    def __init__(self, persist_directory: str = "./memory/chroma_data"):
        self.persist_directory = persist_directory
        os.makedirs(persist_directory, exist_ok=True)
        
        # Initialize offline PersistentClient
        self.client = chromadb.PersistentClient(
            path=persist_directory,
            settings=Settings(anonymized_telemetry=False)
        )
        self.embedder = LocalEmbeddingWrapper()
        self._init_collections()

    def _init_collections(self):
        """Initialize the 4 distinct collections."""
        self.collections: Dict[str, Any] = {}
        for col_enum in MemoryCollectionName:
            col_name = col_enum.value
            self.collections[col_name] = self.client.get_or_create_collection(
                name=col_name,
                metadata={"hnsw:space": "cosine"}
            )

    def store_memory(
        self,
        collection_name: MemoryCollectionName,
        fact_key: str,
        content: str,
        metadata: Optional[Dict[str, Any]] = None
    ) -> str:
        """
        Store a fact with version incrementing.
        Marks any previous active versions of `fact_key` as superseded.
        """
        col = self.collections[collection_name.value]
        timestamp = int(time.time())

        # 1. Query for existing entries with same fact_key that are not superseded
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
            
            # Find max version
            versions = [m.get(MemoryCollections.METADATA_KEY_VERSION, 1) for m in old_metadatas]
            current_version = max(versions) + 1

            # Mark old versions as superseded
            for oid, ometa in zip(old_ids, old_metadatas):
                ometa[MemoryCollections.METADATA_KEY_SUPERSEDED] = True
                col.update(ids=[oid], metadatas=[ometa])
                logging.info(f"Marked memory entry {oid} for fact '{fact_key}' as superseded.")

        # 2. Insert new version
        new_id = f"{fact_key}_v{current_version}_{timestamp}"
        meta = metadata.copy() if metadata else {}
        meta.update({
            MemoryCollections.METADATA_KEY_FACT_KEY: fact_key,
            MemoryCollections.METADATA_KEY_VERSION: current_version,
            MemoryCollections.METADATA_KEY_SUPERSEDED: False,
            MemoryCollections.METADATA_KEY_TIMESTAMP: timestamp
        })

        embedding = self.embedder.get_embedding(content)
        col.add(
            ids=[new_id],
            documents=[content],
            embeddings=[embedding],
            metadatas=[meta]
        )
        logging.info(f"Stored version {current_version} for fact '{fact_key}' in {collection_name.value}.")
        return new_id

    def retrieve_memory(
        self,
        collection_name: MemoryCollectionName,
        query: str,
        top_k: int = 3,
        similarity_cutoff: float = 0.3
    ) -> List[Dict[str, Any]]:
        """
        Semantic retrieval querying ONLY active (non-superseded) memory entries.
        Enforces top-k cap (Task #150) and similarity thresholding (Task #114).
        """
        col = self.collections[collection_name.value]
        query_embedding = self.embedder.get_embedding(query)

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
                # Cosine distance to similarity: similarity = 1 - distance
                sim = 1.0 - dist if dist is not None else 1.0
                if sim >= similarity_cutoff:
                    output.append({
                        "id": mid,
                        "content": doc,
                        "metadata": meta,
                        "similarity": sim
                    })
        return output
