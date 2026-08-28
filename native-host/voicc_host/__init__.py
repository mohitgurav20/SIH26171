"""SIH26171 native host -- agent reasoning, draft planning and voice.

Owner: Omkar. Boundaries with the rest of the team:
  * Mohit's extension speaks to `protocol` and the message contract in `api`.
  * Siddu's vision pipeline plugs into `perception.PerceptionProvider`.
  * Siddu's memory layer supplies the fact list `prompts.render_memory` caps.
  * Chinmay's audit tooling reads the chain `decision_log` writes.
"""
from .config import CONFIG, HOST_NAME, HOST_VERSION

__all__ = ["CONFIG", "HOST_NAME", "HOST_VERSION"]
