from enum import Enum
from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field

class ActionType(str, Enum):
    CLICK = "click"
    TYPE = "type"
    SCROLL = "scroll"
    SELECT = "select"
    HOVER = "hover"
    WAIT = "wait"

class ActionItem(BaseModel):
    step: int = Field(..., description="0-indexed step sequence number")
    action: ActionType = Field(..., description="Action primitive to execute")
    tag_id: int = Field(..., description="Numbered grounding tag ID of the target element")
    value: Optional[str] = Field(None, description="Input string for type/select actions")
    description: str = Field(..., description="Human-readable description of this action step")

class EvidenceItem(BaseModel):
    step: int
    element_text: str
    dom_snippet: Optional[str] = None
    vision_crop_base64: Optional[str] = None
    reason: str

class ActionPlan(BaseModel):
    actions: List[ActionItem] = Field(..., description="Ordered list of actions to execute sequentially")
    reasoning: str = Field(..., description="Rationale for the chosen plan")
    confidence: float = Field(..., ge=0.0, le=1.0, description="Model confidence score")
    source: str = Field(..., description="Origin of plan: 'draft_model', 'full_model', 'vision', or 'cached'")
    evidence: List[EvidenceItem] = Field(default_factory=list, description="Proof-of-Perception justification records")

class DecisionRecord(BaseModel):
    id: str
    timestamp: str
    command: str
    chosen_action: str
    target_tag_id: int
    confidence: float
    evidence_reason: str
    prev_hash: str
    current_hash: str
