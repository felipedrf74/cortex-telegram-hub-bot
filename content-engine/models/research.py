import hashlib
import math
from datetime import datetime, timezone
from typing import Annotated, Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator


BoundedResearchLine = Annotated[
    str,
    StringConstraints(
        strict=True,
        strip_whitespace=True,
        min_length=1,
        max_length=2_000,
        pattern=r"^[^\x00-\x1f\x7f]+$",
    ),
]
BoundedResearchText = Annotated[
    str,
    StringConstraints(
        strict=True,
        strip_whitespace=True,
        min_length=1,
        max_length=16_000,
        pattern=r"^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+$",
    ),
]
BoundedOptionalResearchText = Annotated[
    str,
    StringConstraints(
        strict=True,
        strip_whitespace=True,
        max_length=10_000,
        pattern=r"^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$",
    ),
]
BoundedResearchIdentity = Annotated[
    str,
    StringConstraints(
        strict=True,
        strip_whitespace=True,
        min_length=1,
        max_length=160,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    ),
]
BoundedExternalMetadataKey = Annotated[
    str,
    StringConstraints(
        strict=True,
        strip_whitespace=True,
        min_length=1,
        max_length=80,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    ),
]
BoundedExternalMetadataValue = str | int | float | bool | None


def _validated_timestamp_input(value: object) -> object:
    if value is None or isinstance(value, datetime):
        return value
    if (
        not isinstance(value, str)
        or not value.strip()
        or value != value.strip()
        or len(value) > 64
    ):
        raise ValueError("timestamp must be a bounded ISO-8601 string or datetime")
    return value


def _validated_http_url(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("source URL must be a string")
    normalized = value.strip()
    parsed = urlparse(normalized)
    try:
        parsed_port = parsed.port
    except ValueError:
        parsed_port = None
        invalid_port = True
    else:
        invalid_port = False
    if (
        len(normalized) > 4_096
        or not normalized
        or normalized != value
        or any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in normalized)
        or parsed.scheme.lower() not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or invalid_port
        or (parsed_port is not None and not 1 <= parsed_port <= 65_535)
    ):
        raise ValueError("source URL must be an HTTP(S) URL without embedded credentials")
    return normalized


def _bounded_external_metadata(value: object, limit: int = 500) -> str | None:
    """Retain scalar provider metadata without letting it invalidate a source record."""
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        return None
    normalized = " ".join(
        "".join(
            " " if ord(character) < 32 or ord(character) == 127 else character
            for character in str(value)
        ).split()
    )
    return normalized[:limit].rstrip() or None


class SearchResult(BaseModel):
    """A single result from any searcher (web, YouTube, news, etc.)."""
    model_config = ConfigDict(extra="forbid", validate_assignment=True, revalidate_instances="always")

    title: BoundedResearchLine = Field(max_length=1_000)
    url: str
    snippet: BoundedOptionalResearchText = ""
    source: BoundedResearchIdentity  # e.g. "web", "youtube", "news"
    published_at: datetime | None = None
    thumbnail_url: str | None = None
    metadata: dict[BoundedExternalMetadataKey, BoundedExternalMetadataValue] = Field(
        default_factory=dict,
        max_length=32,
    )  # bounded searcher-specific scalar extras

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        return _validated_http_url(value)

    @field_validator("thumbnail_url")
    @classmethod
    def validate_thumbnail_url(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        try:
            return _validated_http_url(value)
        except ValueError:
            # A bad optional thumbnail must not discard an otherwise valid
            # source record. Primary source URLs remain fail-closed above.
            return None

    @field_validator("published_at")
    @classmethod
    def withhold_naive_published_at(cls, value: datetime | None) -> datetime | None:
        if value is None or value.tzinfo is None or value.utcoffset() is None:
            return None
        return value

    @field_validator("published_at", mode="before")
    @classmethod
    def validate_published_at_input(cls, value: object) -> object:
        return _validated_timestamp_input(value)

    @field_validator("metadata", mode="before")
    @classmethod
    def validate_metadata(cls, value: object) -> object:
        if not isinstance(value, dict):
            raise ValueError("search metadata must be an object")
        if len(value) > 32:
            raise ValueError("search metadata exceeds the supported field count")
        bounded: dict[str, BoundedExternalMetadataValue] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError("search metadata keys must be strings")
            normalized_key = key.strip()
            if (
                not normalized_key
                or len(normalized_key) > 80
                or not all(character.isalnum() or character in "._:-" for character in normalized_key)
            ):
                raise ValueError("search metadata key is invalid")
            if item is None or isinstance(item, bool):
                bounded[normalized_key] = item
            elif isinstance(item, int):
                if abs(item) > 10**15:
                    raise ValueError("search metadata integer is outside the supported range")
                bounded[normalized_key] = item
            elif isinstance(item, float):
                if not math.isfinite(item) or abs(item) > 10**15:
                    raise ValueError("search metadata number is outside the supported range")
                bounded[normalized_key] = item
            elif isinstance(item, str):
                normalized_item = " ".join(
                    "".join(
                        " " if ord(character) < 32 or ord(character) == 127 else character
                        for character in item
                    ).split()
                )
                bounded[normalized_key] = normalized_item[:500]
            else:
                raise ValueError("search metadata values must be bounded scalars")
        return bounded


class SourceReference(BaseModel):
    """A curated source with relevance context."""
    model_config = ConfigDict(extra="forbid", validate_assignment=True, revalidate_instances="always")

    source_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
    title: BoundedResearchLine = Field(max_length=1_000)
    url: str
    source_type: BoundedResearchIdentity  # "article", "video", "social", "news"
    relevance_note: BoundedOptionalResearchText = Field(default="", max_length=2_000)  # why this source matters
    publisher: BoundedResearchLine | None = Field(default=None, max_length=500)
    author: BoundedResearchLine | None = Field(default=None, max_length=500)
    published_at: datetime | None = None
    accessed_at: datetime | None = None

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        return _validated_http_url(value)

    @field_validator("published_at", "accessed_at")
    @classmethod
    def withhold_naive_timestamp(cls, value: datetime | None) -> datetime | None:
        if value is None or value.tzinfo is None or value.utcoffset() is None:
            return None
        return value

    @field_validator("published_at", "accessed_at", mode="before")
    @classmethod
    def validate_timestamp_input(cls, value: object) -> object:
        return _validated_timestamp_input(value)


def source_reference_from_search_result(
    result: SearchResult,
    relevance_note: str = "",
    title: str | None = None,
    source_id: str | None = None,
) -> SourceReference:
    """Preserve available source identity and dates when curating a result."""
    metadata = result.metadata if isinstance(result.metadata, dict) else {}
    publisher = (
        metadata.get("publisher")
        or metadata.get("channel_title")
        or metadata.get("displayed_link")
        or (f"r/{metadata['subreddit']}" if metadata.get("subreddit") else None)
    )
    return SourceReference(
        source_id=source_id or f"source_{hashlib.sha256(result.url.encode('utf-8')).hexdigest()[:16]}",
        title=title or result.title,
        url=result.url,
        source_type=result.source,
        relevance_note=relevance_note,
        publisher=_bounded_external_metadata(publisher),
        author=_bounded_external_metadata(metadata.get("author")),
        published_at=result.published_at,
        accessed_at=datetime.now(timezone.utc),
    )


class ResearchClaim(BaseModel):
    """A bounded claim with server-reconciled source IDs, not factual verification.

    `source_bound` means every cited ID exists in the server-issued source set.
    It does not establish that the source entails the claim or that a human
    reviewed it.
    """
    model_config = ConfigDict(extra="forbid", validate_assignment=True, revalidate_instances="always")

    text: BoundedResearchLine
    source_ids: list[str] = Field(default_factory=list, max_length=12)
    verification_status: Literal["source_bound", "unverified"] = "unverified"

    @field_validator("source_ids")
    @classmethod
    def validate_source_ids(cls, values: list[str]) -> list[str]:
        normalized: list[str] = []
        seen: set[str] = set()
        for value in values:
            source_id = value.strip() if isinstance(value, str) else ""
            if not source_id or len(source_id) > 128 or source_id in seen:
                continue
            if not all(char.isalnum() or char in "._:-" for char in source_id):
                continue
            normalized.append(source_id)
            seen.add(source_id)
        return normalized


class TrendingTopic(BaseModel):
    """A trending topic detected across sources."""
    model_config = ConfigDict(extra="forbid", validate_assignment=True, revalidate_instances="always")

    topic: BoundedResearchLine = Field(max_length=1_000)
    heat_score: float = Field(ge=0.0, le=1.0, allow_inf_nan=False)  # 0=cold, 1=volcanic
    sources: list[BoundedResearchIdentity] = Field(default_factory=list, max_length=12)
    source_ids: list[str] = Field(default_factory=list, max_length=12)
    source_references: list[SourceReference] = Field(default_factory=list, max_length=12)
    first_seen: datetime | None = None
    niche: Annotated[
        str,
        StringConstraints(strict=True, strip_whitespace=True, max_length=160, pattern=r"^[^\x00-\x1f\x7f]*$"),
    ] = ""                                    # which content niche it fits
    content_angle: BoundedOptionalResearchText = Field(default="", max_length=2_000)  # creator approach
    relevance: int = Field(default=5, ge=1, le=10, strict=True)  # 1-10 brand relevance score

    @field_validator("heat_score", mode="before")
    @classmethod
    def require_numeric_heat_score(cls, value: object) -> object:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("heat_score must be numeric")
        return value

    @field_validator("source_ids")
    @classmethod
    def validate_topic_source_ids(cls, values: list[str]) -> list[str]:
        normalized: list[str] = []
        seen: set[str] = set()
        for value in values:
            source_id = value.strip() if isinstance(value, str) else ""
            if (
                not source_id
                or len(source_id) > 128
                or source_id in seen
                or not all(character.isalnum() or character in "._:-" for character in source_id)
            ):
                raise ValueError("trending source IDs must be unique bounded identifiers")
            normalized.append(source_id)
            seen.add(source_id)
        return normalized

    @field_validator("first_seen")
    @classmethod
    def withhold_naive_first_seen(cls, value: datetime | None) -> datetime | None:
        if value is None or value.tzinfo is None or value.utcoffset() is None:
            return None
        return value

    @field_validator("first_seen", mode="before")
    @classmethod
    def validate_first_seen_input(cls, value: object) -> object:
        return _validated_timestamp_input(value)


class ContentBrief(BaseModel):
    """The final deliverable: a complete content brief for one idea."""
    model_config = ConfigDict(extra="forbid", validate_assignment=True, revalidate_instances="always")

    title: BoundedResearchLine = Field(max_length=1_000)
    hook: BoundedResearchLine                 # topic-specific opening hypothesis in the requested locale
    angle: BoundedResearchText = Field(max_length=2_000)  # what makes the authenticated creator's take unique
    format: Literal["YouTube", "Short", "Reel", "Carousel"]
    niche: Annotated[
        str,
        StringConstraints(strict=True, strip_whitespace=True, min_length=1, max_length=160, pattern=r"^[^\x00-\x1f\x7f]+$"),
    ]
    key_points: list[BoundedResearchLine] = Field(default_factory=list, max_length=24)
    claims: list[ResearchClaim] = Field(default_factory=list, max_length=24)
    title_options: list[BoundedResearchLine] = Field(default_factory=list, max_length=10)  # SEO-friendly variations
    sources: list[SourceReference] = Field(default_factory=list, max_length=50)
    score: float = Field(default=0.0, ge=0.0, le=1.0, allow_inf_nan=False)  # composite content score
    time_sensitive: bool = Field(default=False, strict=True)  # expires in 24-48h?
    why_now: BoundedOptionalResearchText = ""  # what makes this trending TODAY

    @field_validator("score", mode="before")
    @classmethod
    def require_numeric_score(cls, value: object) -> object:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("brief score must be numeric")
        return value
