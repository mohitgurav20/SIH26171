import json
import logging
from typing import Optional, Dict, Any
from schemas import ActionPlan
from ollama_client import OllamaClient

class DraftSpeculativePlanner:
    """
    Speculative decoding / fast-pass planner using lightweight ~0.5B model (Task #31, #47).
    Generates rapid first-pass plans on clean DOMs; triggers full escalation on ambiguity.
    """

    def __init__(self, ollama: OllamaClient, draft_model: str = "qwen2.5:0.5b", full_model: str = "qwen2.5:3b"):
        self.ollama = ollama
        self.draft_model = draft_model
        self.full_model = full_model
        self.confidence_threshold = 0.75

    async def propose_plan(self, task: str, elements_json: Dict[str, Any], memory_context: Optional[str] = None) -> ActionPlan:
        """Propose speculative plan using draft model; escalate to full model if below confidence threshold."""
        prompt = f"""Task: {task}
Memory Context: {memory_context or 'None'}
Interactive Elements: {json.dumps(elements_json, indent=2)}

Output a valid JSON ActionPlan with fields:
- actions: list of {{step: int, action: 'click'|'type'|'scroll', tag_id: int, value: string|null, description: string}}
- reasoning: string
- confidence: float (0.0 to 1.0)
- source: 'draft_model'
- evidence: list of {{step: int, element_text: string, reason: string}}
"""
        try:
            res = await self.ollama.generate(
                model=self.draft_model,
                prompt=prompt,
                system="You are a fast browser action planner. Output only valid ActionPlan JSON.",
                format="json"
            )
            raw_output = json.loads(res.get("response", "{}"))
            plan = ActionPlan(**raw_output)

            # Check for escalation
            if plan.confidence < self.confidence_threshold:
                logging.info(f"Draft plan confidence {plan.confidence} below threshold {self.confidence_threshold}. Escalating to full model {self.full_model}...")
                return await self._escalate_to_full(task, elements_json, memory_context)

            return plan

        except Exception as e:
            logging.warning(f"Draft model execution failed or produced invalid plan: {e}. Escalating to full model.")
            return await self._escalate_to_full(task, elements_json, memory_context)

    async def _escalate_to_full(self, task: str, elements_json: Dict[str, Any], memory_context: Optional[str] = None) -> ActionPlan:
        """Escalate planning to full 3B reasoning model."""
        prompt = f"""Task: {task}
Memory Context: {memory_context or 'None'}
Interactive Elements: {json.dumps(elements_json, indent=2)}

Output structured JSON matching ActionPlan schema."""
        res = await self.ollama.generate(
            model=self.full_model,
            prompt=prompt,
            system="You are a deterministic browser agent. Produce thorough, accurate ActionPlans.",
            format="json"
        )
        raw_output = json.loads(res.get("response", "{}"))
        raw_output["source"] = "full_model"
        return ActionPlan(**raw_output)
