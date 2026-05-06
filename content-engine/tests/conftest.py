import sys
from pathlib import Path

import pytest


CONTENT_ENGINE_ROOT = Path(__file__).resolve().parents[1]
if str(CONTENT_ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(CONTENT_ENGINE_ROOT))


@pytest.fixture
def neutral_creator_profile() -> str:
    return (
        "CREATOR PROFILE: authenticated creator. "
        "Voice: use the saved brand voice when present; otherwise stay neutral. "
        "Audience: use the saved audience profile; never assume founder identity."
    )


@pytest.fixture
def founder_identity_tokens() -> tuple[str, ...]:
    return (
        "felipe",
        "felipedrf",
        "jaqueline",
        "vieira",
        "felipedominguez",
        "nexushubbot",
    )


@pytest.fixture
def assert_no_founder_identity(founder_identity_tokens):
    def check(*texts: object) -> None:
        joined = " ".join(str(text) for text in texts if text is not None).lower()
        leaked = [token for token in founder_identity_tokens if token in joined]
        assert leaked == []

    return check
