import hashlib
import json
import time
import logging
from typing import List, Dict, Any, Optional

class HashChainAuditLog:
    """
    Cryptographic Tamper-Evident Hash-Chain Audit Log (Task #51, #71, #75, #89).
    Each log entry incorporates the SHA-256 hash of the preceding entry.
    """

    def __init__(self):
        self.chain: List[Dict[str, Any]] = []
        # Genesis block
        self.genesis_hash = "0" * 64
        self._add_genesis()

    def _add_genesis(self):
        genesis_entry = {
            "index": 0,
            "timestamp": int(time.time()),
            "action": "GENESIS",
            "prev_hash": "0" * 64,
            "hash": self._hash_payload("GENESIS_INIT", "0" * 64)
        }
        self.chain.append(genesis_entry)

    def _hash_payload(self, content_str: str, prev_hash: str) -> str:
        data = f"{content_str}|{prev_hash}"
        return hashlib.sha256(data.encode('utf-8')).hexdigest()

    def append_action(self, action_type: str, target: str, reason: str, evidence: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Record an action and cryptographically link it to the previous log hash."""
        prev_entry = self.chain[-1]
        prev_hash = prev_entry["hash"]
        index = len(self.chain)
        timestamp = int(time.time())

        payload = {
            "index": index,
            "timestamp": timestamp,
            "action": action_type,
            "target": target,
            "reason": reason,
            "evidence": evidence or {},
            "prev_hash": prev_hash
        }

        entry_hash = self._hash_payload(json.dumps(payload, sort_keys=True), prev_hash)
        payload["hash"] = entry_hash
        self.chain.append(payload)
        logging.info(f"Audit log appended index #{index} with hash: {entry_hash[:12]}...")
        return payload

    def verify_chain(self) -> tuple[bool, str]:
        """
        Walk and recompute all hashes along the chain to verify integrity.
        Returns (is_valid, report).
        """
        for i in range(1, len(self.chain)):
            curr = self.chain[i]
            prev = self.chain[i - 1]

            if curr["prev_hash"] != prev["hash"]:
                return False, f"Hash chain broken at index #{i}! Recorded prev_hash does not match previous block hash."

            # Verify integrity of current block hash
            temp_copy = curr.copy()
            claimed_hash = temp_copy.pop("hash")
            recomputed = self._hash_payload(json.dumps(temp_copy, sort_keys=True), curr["prev_hash"])
            if recomputed != claimed_hash:
                return False, f"Tamper detected at index #{i}! Block content has been modified."

        return True, f"Hash chain valid. Verified {len(self.chain)} blocks with zero tampering."


class ProofOfPerception:
    """
    Proof-of-Perception Justification Engine (Task #55, #56, #137).
    Refuses any action proposition that lacks unambiguous justification evidence.
    """

    def __init__(self, audit_log: HashChainAuditLog):
        self.audit_log = audit_log

    def validate_and_record(
        self,
        action_type: str,
        element_text: str,
        reason: str,
        dom_snippet: Optional[str] = None,
        crop_base64: Optional[str] = None
    ) -> tuple[bool, Optional[Dict[str, Any]]]:
        """
        Enforce evidence requirement before allowing action execution.
        """
        if not reason or (not element_text and not crop_base64):
            logging.error(f"Proof-of-Perception refused action '{action_type}': Missing evidence justification.")
            return False, None

        evidence_payload = {
            "element_text": element_text,
            "dom_snippet": dom_snippet,
            "has_crop": crop_base64 is not None
        }

        entry = self.audit_log.append_action(
            action_type=action_type,
            target=element_text,
            reason=reason,
            evidence=evidence_payload
        )
        return True, entry
