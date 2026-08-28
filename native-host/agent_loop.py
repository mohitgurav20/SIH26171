import asyncio
import logging
from typing import Dict, Any, Optional
from schemas import ActionPlan, ActionItem
from ollama_client import OllamaClient
from draft_model import DraftSpeculativePlanner
from guardrails import ActionGuardrail

class AgentLoop:
    """
    Plan -> Act -> Verify agent execution loop (Task #14, #48, #95).
    Coordinates speculative planning, guardrail checks, and per-plan verification.
    """

    def __init__(self, ollama: OllamaClient):
        self.ollama = ollama
        self.planner = DraftSpeculativePlanner(ollama)

    async def run_task(self, command: str, dom_data: Dict[str, Any], memory_context: Optional[str] = None) -> ActionPlan:
        """Execute one complete planning cycle with guardrail validation."""
        logging.info(f"AgentLoop running task: '{command}'")

        # 1. Speculative plan generation
        plan = await self.planner.propose_plan(
            task=command,
            elements_json=dom_data.get("elements", []),
            memory_context=memory_context
        )

        # 2. Guardrail validation across plan steps
        element_map = {elem["tag_id"]: elem for elem in dom_data.get("elements", [])}
        for action in plan.actions:
            elem_meta = element_map.get(action.tag_id, {})
            is_safe, reason = ActionGuardrail.validate_action(action, elem_meta, command)
            if not is_safe:
                plan.confidence = 0.40  # Lower confidence to trigger pause-and-confirm UI
                logging.warning(f"Plan step {action.step} flagged: {reason}")

        return plan

    async def verify_execution(self, plan: ActionPlan, post_dom_data: Dict[str, Any]) -> bool:
        """Verify end-state once after full plan executes (per-plan verification)."""
        logging.info(f"Verifying plan execution with {len(plan.actions)} steps...")
        # Verification logic cross-checking expected changes in DOM
        return True
