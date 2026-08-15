"""Cross-runtime attribution vocabulary regression coverage."""

from services.inference_vocabulary import (
    CONTENT_ENGINE_SCRIPT_CATEGORY,
    LOCAL_PRIMARY_SHADOW_CATEGORY_PREFIX,
    build_content_engine_script_category,
    is_content_engine_script_category,
    is_local_primary_shadow_category,
)


def test_content_script_category_is_normalized_and_recognized() -> None:
    assert build_content_engine_script_category(" Standard ") == "content_engine_script_standard"
    assert is_content_engine_script_category("content_engine_script_standard_openai_fallback")
    assert CONTENT_ENGINE_SCRIPT_CATEGORY == "content_engine_script"


def test_local_primary_shadow_prefix_is_recognized() -> None:
    assert LOCAL_PRIMARY_SHADOW_CATEGORY_PREFIX == "local_primary_shadow:"
    assert is_local_primary_shadow_category("LOCAL_PRIMARY_SHADOW:ios_chat_message")
