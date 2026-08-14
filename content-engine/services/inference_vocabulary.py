"""Stable local-primary attribution vocabulary mirrored from the TS backend."""

LOCAL_PRIMARY_SHADOW_JOB_NAME = "local_primary_shadow"
LOCAL_PRIMARY_SHADOW_CATEGORY_PREFIX = f"{LOCAL_PRIMARY_SHADOW_JOB_NAME}:"
CONTENT_ENGINE_SCRIPT_CATEGORY = "content_engine_script"


def build_content_engine_script_category(mode: str) -> str:
    return f"{CONTENT_ENGINE_SCRIPT_CATEGORY}_{mode.strip().lower()}"


def is_content_engine_script_category(category: str) -> bool:
    normalized = category.strip().lower()
    return normalized == CONTENT_ENGINE_SCRIPT_CATEGORY or normalized.startswith(
        f"{CONTENT_ENGINE_SCRIPT_CATEGORY}_"
    )


def is_local_primary_shadow_category(category: str) -> bool:
    return category.strip().lower().startswith(LOCAL_PRIMARY_SHADOW_CATEGORY_PREFIX)
