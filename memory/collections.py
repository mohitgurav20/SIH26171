from enum import Enum

class MemoryCollectionName(str, Enum):
    """
    4 Core Chroma Collections for SIH26171 (Task #2, #48).
    Designed to prevent fact collisions and enable versioned superseding.
    """
    SESSION_MEMORY = "session_memory"       # Ephemeral context, active task state
    USER_PREFERENCES = "user_preferences"   # Long-term user preferences & defaults
    SITE_KNOWLEDGE = "site_knowledge"       # Learned site layout patterns & workflows
    TASK_HISTORY = "task_history"           # Audited historical task completions

class MemoryCollections:
    """Schema definitions and metadata keys for memory items."""
    
    METADATA_KEY_VERSION = "version"
    METADATA_KEY_SUPERSEDED = "superseded"
    METADATA_KEY_FACT_KEY = "fact_key"
    METADATA_KEY_TIMESTAMP = "timestamp"
    METADATA_KEY_URL_PATTERN = "url_pattern"
