"""
AI client for all creative/intelligence modules.

ARCHITECTURE (April 2026):
  This module NO LONGER calls Anthropic directly. All AI completions
  route through the TS backend's internal proxy endpoint:

    POST /api/v1/internal/ai-complete

  The TS backend handles:
    1. Signed local-primary Content routing for attributed eligible calls
    2. Policy-controlled cloud routing for legacy or explicitly eligible calls
    3. Usage metering, inference telemetry, and provider fallbacks
    4. Privacy, budget, kill-switch, and capacity enforcement

  This means Python never needs API keys for AI providers — it only
  needs INTERNAL_API_SECRET to talk to the TS backend.

  The module name is kept as `claude_client.py` for backward compat
  with all importers. The public API (ask_claude, ask_claude_json)
  is unchanged — callers don't need to update.
"""

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import struct
import uuid
from contextvars import ContextVar
from typing import Any

import httpx

logger = logging.getLogger("content-engine.claude")

# Legacy model constants — kept for callers that pass model= explicitly.
# These are ignored now (TS picks the provider) but prevent import errors.
MODEL = "sonnet"
FAST_MODEL = "haiku"

# ── TS backend proxy ────────────────────────────────────────────────

_TS_BASE = (
    os.environ.get("NEXUS_BACKEND_BASE_URL")
    or os.environ.get("TS_BACKEND_BASE_URL")
    or f"http://localhost:{os.environ.get('NEXUS_BACKEND_PORT') or os.environ.get('TS_BACKEND_PORT') or '8200'}"
).rstrip("/")
_INTERNAL_SECRET = os.environ.get("INTERNAL_API_SECRET", "")
_AI_COMPLETE_URL = f"{_TS_BASE}/api/v1/internal/ai-complete"
_FIXTURE_MODE = (
    os.environ.get("CONTENT_ENGINE_FIXTURE_MODE") == "1"
    or os.environ.get("NEXUS_LOCAL_ALLOW_MODEL_CALLS") == "0"
)
_ATTRIBUTION_CONTEXT: ContextVar[dict[str, Any] | None] = ContextVar(
    "content_engine_attribution_context",
    default=None,
)


_STABLE_AI_BUDGET_CODES = {
    "AI_PLAN_REQUIRED",
    "AI_DAILY_LIMIT_REACHED",
    "AI_MONTHLY_LIMIT_REACHED",
    "SERVICE_DEGRADED",
}

_STABLE_LOCAL_INFERENCE_CODES = {
    "LOCAL_PRIMARY_DISABLED",
    "LOCAL_PLAN_REQUIRED",
    "LOCAL_FAIR_USE_REACHED",
    "LOCAL_CAPACITY_BUSY",
    "LOCAL_QUEUE_FULL",
    "LOCAL_QUEUE_DEADLINE",
    "PRIVATE_LOCAL_ROUTE_UNAVAILABLE",
    "INFERENCE_PROVIDER_UNAVAILABLE",
    "INFERENCE_CONTEXT_LIMIT_EXCEEDED",
    "INFERENCE_EMPTY_OUTPUT",
    "INFERENCE_SCHEMA_VALUE_INVALID",
    "LOCAL_INFERENCE_ATTRIBUTION_UNAVAILABLE",
    "INTERNAL_ATTRIBUTION_INVALID",
    "INTERNAL_INFERENCE_ATTRIBUTION_INVALID",
    "INTERNAL_INFERENCE_ATTRIBUTION_MISMATCH",
    "ACCOUNT_DELETION_IN_PROGRESS",
}


class AiProxyError(Exception):
    """Typed, public-safe model-access denial returned by the TS proxy.

    FastAPI maps this exception back to the same stable envelope. Keeping the
    public fields separate from the raw httpx response prevents provider or
    internal error text from leaking through the Content Engine hop.
    """

    def __init__(
        self,
        *,
        status_code: int,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
        retry_after: str | None = None,
    ) -> None:
        super().__init__(code)
        self.status_code = status_code
        self.code = code
        self.public_message = message
        self.details = details or {}
        self.retry_after = retry_after


def _stable_ai_proxy_error(response: httpx.Response) -> AiProxyError | None:
    if response.status_code not in (400, 403, 409, 429, 500, 502, 503):
        return None
    try:
        payload = response.json()
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    error = payload.get("error")
    if not isinstance(error, dict):
        detail = payload.get("detail")
        error = detail.get("error") if isinstance(detail, dict) else None
    if not isinstance(error, dict):
        return None
    code = error.get("code")
    if code not in _STABLE_AI_BUDGET_CODES and code not in _STABLE_LOCAL_INFERENCE_CODES:
        return None
    expected_statuses = {
        "AI_PLAN_REQUIRED": {403},
        "AI_DAILY_LIMIT_REACHED": {429},
        "AI_MONTHLY_LIMIT_REACHED": {429},
        "SERVICE_DEGRADED": {429},
        "LOCAL_PRIMARY_DISABLED": {409},
        "LOCAL_PLAN_REQUIRED": {403},
        "LOCAL_FAIR_USE_REACHED": {429},
        "LOCAL_CAPACITY_BUSY": {503},
        "LOCAL_QUEUE_FULL": {503},
        "LOCAL_QUEUE_DEADLINE": {503},
        "LOCAL_INFERENCE_ATTRIBUTION_UNAVAILABLE": {503},
        "INTERNAL_ATTRIBUTION_INVALID": {403},
        "INTERNAL_INFERENCE_ATTRIBUTION_INVALID": {403},
        "INTERNAL_INFERENCE_ATTRIBUTION_MISMATCH": {403},
        "ACCOUNT_DELETION_IN_PROGRESS": {409},
        "PRIVATE_LOCAL_ROUTE_UNAVAILABLE": {503},
        "INFERENCE_PROVIDER_UNAVAILABLE": {503},
        "INFERENCE_CONTEXT_LIMIT_EXCEEDED": {400},
        "INFERENCE_EMPTY_OUTPUT": {502},
        "INFERENCE_SCHEMA_VALUE_INVALID": {502},
    }
    if response.status_code not in expected_statuses.get(code, set()):
        return None
    message = error.get("message")
    details = error.get("details")
    return AiProxyError(
        status_code=response.status_code,
        code=code,
        message=message if isinstance(message, str) and message else code,
        details=details if isinstance(details, dict) else {},
        retry_after=response.headers.get("retry-after"),
    )


def set_attribution_context(
    user_id: int | None = None,
    tenant_id: int | None = None,
    attribution_token: str | None = None,
    inference_attribution_token: str | None = None,
    inference_proof_key: str | None = None,
):
    """Install request-scoped user/tenant attribution for downstream AI calls."""
    return _ATTRIBUTION_CONTEXT.set({
        "user_id": user_id,
        "tenant_id": tenant_id,
        "attribution_token": attribution_token,
        "inference_attribution_token": inference_attribution_token,
        "inference_proof_key": inference_proof_key,
    })


def reset_attribution_context(token) -> None:
    _ATTRIBUTION_CONTEXT.reset(token)


def _strip_markdown_json_fence(raw: str) -> str:
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json|JSON)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```\s*$", "", cleaned)
    return cleaned.strip()


def _extract_json_candidate(raw: str) -> str:
    cleaned = _strip_markdown_json_fence(raw)
    if not cleaned:
        return cleaned

    start_candidates = [idx for idx in (cleaned.find("{"), cleaned.find("[")) if idx >= 0]
    if not start_candidates:
        return cleaned
    start = min(start_candidates)
    opener = cleaned[start]
    closer = "}" if opener == "{" else "]"

    depth = 0
    in_string = False
    escaped = False
    for idx in range(start, len(cleaned)):
        ch = cleaned[idx]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue

        if ch == '"':
            in_string = True
        elif ch == opener:
            depth += 1
        elif ch == closer:
            depth -= 1
            if depth == 0:
                return cleaned[start:idx + 1].strip()

    return cleaned[start:].strip()


async def _repair_json_response(
    raw: str,
    system: str,
    category: str,
    max_tokens: int,
    user_id: int | None = None,
    tenant_id: int | None = None,
    attribution_token: str | None = None,
) -> dict | list | None:
    repair_prompt = f"""Repair the following model output into valid JSON only.
Preserve the original structure and data. Do not summarize. Do not add markdown.
If a string contains a line break, escape it correctly. Return only the JSON object or array.

BROKEN OUTPUT:
{raw[:12000]}"""
    try:
        repaired = await ask_claude(
            repair_prompt,
            system=system,
            max_tokens=min(max_tokens, 4096),
            temperature=0.0,
            # A repair is another stage of the same signed workload/run, not
            # a new billable category. Reusing the original category lets the
            # TS proxy re-enter the live outer reservation exactly.
            category=category,
            json_mode=True,
            user_id=user_id,
            tenant_id=tenant_id,
            attribution_token=attribution_token,
        )
        return json.loads(_extract_json_candidate(repaired))
    except AiProxyError:
        # Plan/quota errors are authoritative and must survive the repair hop;
        # returning a raw/degraded success would hide the user's reset state.
        raise
    except Exception as exc:
        logger.warning("AI JSON repair failed for category=%s: %s", category, exc)
        return None


def _canonical_inference_temperature(value: float) -> str:
    normalized = float(value)
    # Collapse signed zero, then encode the shared IEEE-754 value directly.
    # Decimal tie-breaking differs between Python and JavaScript, so rounded
    # decimal text is not a safe cross-language authentication contract.
    if normalized == 0:
        normalized = 0.0
    return struct.pack(">d", normalized).hex()


_ECMASCRIPT_TRIM_CHARS = (
    "\u0009\u000b\u000c\u0020\u00a0\ufeff"
    "\u000a\u000d\u2028\u2029"
    "\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u202f\u205f\u3000"
)


def _canonical_inference_text(value: str) -> str:
    """Match ECMAScript String.trim without Python-only whitespace drift."""
    return value.strip(_ECMASCRIPT_TRIM_CHARS)


def _build_internal_inference_request_proof(
    proof_key: str,
    *,
    category: str,
    run_id: str,
    prompt: str,
    system: str,
    max_tokens: int,
    temperature: float,
    json_mode: bool,
    skill_id: str,
    task_type: str,
    risk_class: str,
    execution_class: str,
    schema_id: str,
) -> str | None:
    """MAC the exact internal inference request without sending the proof key."""
    try:
        padding = "=" * (-len(proof_key) % 4)
        key = base64.urlsafe_b64decode(proof_key + padding)
        if len(key) != 32:
            return None
        payload = "\n".join([
            "nexus-skill-inference-v1",
            category,
            run_id,
            skill_id,
            task_type,
            risk_class,
            execution_class,
            schema_id,
            str(int(max_tokens)),
            _canonical_inference_temperature(temperature),
            "true" if json_mode else "false",
            hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
            hashlib.sha256(system.encode("utf-8")).hexdigest(),
        ]).encode("utf-8")
        signature = hmac.new(key, payload, hashlib.sha256).digest()
        return base64.urlsafe_b64encode(signature).decode("ascii").rstrip("=")
    except (TypeError, ValueError):
        return None


async def ask_claude(
    prompt: str,
    system: str = "",
    model: str = FAST_MODEL,
    max_tokens: int = 4096,
    temperature: float = 0.7,
    category: str = "content_engine",
    json_mode: bool = False,
    user_id: int | None = None,
    tenant_id: int | None = None,
    attribution_token: str | None = None,
    inference_attribution_token: str | None = None,
    inference_proof_key: str | None = None,
) -> str:
    """Send a prompt through the TS AI proxy and return the text response.

    Routes through the governed TS inference/provider boundary.
    The `model` parameter is kept for backward compat but is ignored —
    the TS backend picks the best available provider.
    """
    if _FIXTURE_MODE:
        raise RuntimeError("AI proxy disabled by Content Engine fixture mode.")

    if not _INTERNAL_SECRET:
        raise RuntimeError(
            "INTERNAL_API_SECRET not set — content-engine requires it to "
            "communicate with the TS backend's AI proxy."
        )

    context = _ATTRIBUTION_CONTEXT.get() or {}
    effective_user_id = user_id if user_id is not None else context.get("user_id")
    effective_tenant_id = tenant_id if tenant_id is not None else context.get("tenant_id")
    effective_attribution_token = attribution_token or context.get("attribution_token")
    effective_inference_attribution_token = (
        inference_attribution_token or context.get("inference_attribution_token")
    )
    effective_inference_proof_key = (
        inference_proof_key or context.get("inference_proof_key")
    )

    canonical_prompt = _canonical_inference_text(prompt)
    canonical_system = _canonical_inference_text(system)
    body = {
        "prompt": canonical_prompt,
        "system": canonical_system,
        "category": category,
        "maxTokens": max_tokens,
        "temperature": temperature,
        "jsonMode": json_mode,
    }
    if effective_user_id is not None:
        body["userId"] = effective_user_id
    if effective_tenant_id is not None:
        body["tenantId"] = effective_tenant_id
    if effective_attribution_token:
        body["attributionToken"] = effective_attribution_token
    if effective_inference_attribution_token:
        if not effective_inference_proof_key:
            raise AiProxyError(
                status_code=503,
                code="LOCAL_INFERENCE_ATTRIBUTION_UNAVAILABLE",
                message="Local-primary Content request proof is unavailable.",
                details={"retryable": True},
            )
        body["inferenceAttributionToken"] = effective_inference_attribution_token
        body["runId"] = str(uuid.uuid4())
        body["skillId"] = "content"
        body["taskType"] = category
        body["riskClass"] = "low"
        # Signed local-primary grants currently originate only at the durable
        # script boundary. Nested deep-search/synthesis calls remain background
        # work even though their individual category is not script-prefixed.
        body["executionClass"] = "background"
        body["schemaId"] = "generic_json" if json_mode else "text"
        proof = _build_internal_inference_request_proof(
            effective_inference_proof_key,
            category=category,
            run_id=body["runId"],
            prompt=canonical_prompt,
            system=canonical_system,
            max_tokens=max_tokens,
            temperature=temperature,
            json_mode=json_mode,
            skill_id=body["skillId"],
            task_type=body["taskType"],
            risk_class=body["riskClass"],
            execution_class=body["executionClass"],
            schema_id=body["schemaId"],
        )
        if proof is None:
            raise AiProxyError(
                status_code=503,
                code="LOCAL_INFERENCE_ATTRIBUTION_UNAVAILABLE",
                message="Local-primary Content request proof could not be created.",
                details={"retryable": True},
            )
        body["inferenceAttributionProof"] = proof

    async with httpx.AsyncClient(timeout=300.0) as client:
        try:
            resp = await client.post(_AI_COMPLETE_URL, json=body, headers={
                "x-internal-secret": _INTERNAL_SECRET,
                "content-type": "application/json",
            })
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            stable_error = _stable_ai_proxy_error(e.response)
            if stable_error is not None:
                raise stable_error from None
            if effective_inference_attribution_token:
                # A signed local-primary workload must never be converted by
                # script_writer into a plausible deterministic success. Keep
                # unknown proxy/configuration failures public-safe and
                # retryable while preserving the local-only privacy boundary.
                raise AiProxyError(
                    status_code=503,
                    code="LOCAL_INFERENCE_FAILED",
                    message="Local content generation is temporarily unavailable.",
                    details={"retryable": True},
                ) from None
            logger.error(
                "AI proxy HTTP error %d for category=%s (%d chars)",
                e.response.status_code,
                category,
                len(e.response.text or ""),
            )
            raise RuntimeError(f"AI proxy error {e.response.status_code} for category={category}")
        except httpx.TimeoutException:
            logger.error("AI proxy timeout after 300s for category=%s", category)
            if effective_inference_attribution_token:
                raise AiProxyError(
                    status_code=503,
                    code="LOCAL_INFERENCE_FAILED",
                    message="Local content generation timed out. Please retry.",
                    details={"retryable": True},
                ) from None
            raise
        except httpx.RequestError:
            logger.error("AI proxy transport failure for category=%s", category)
            if effective_inference_attribution_token:
                raise AiProxyError(
                    status_code=503,
                    code="LOCAL_INFERENCE_FAILED",
                    message="Local content generation is temporarily unavailable.",
                    details={"retryable": True},
                ) from None
            raise

        data = resp.json()

    text = data.get("text", "")
    provider = data.get("provider", "unknown")
    logger.info("AI complete via %s for category=%s (%d chars)", provider, category, len(text))

    if not text:
        logger.warning("AI proxy returned empty text for category=%s", category)

    return text


async def ask_claude_json(
    prompt: str,
    system: str = "",
    model: str = FAST_MODEL,
    max_tokens: int = 4096,
    temperature: float = 0.5,
    category: str = "content_engine",
    user_id: int | None = None,
    tenant_id: int | None = None,
    attribution_token: str | None = None,
) -> dict | list:
    """Send a prompt through the AI proxy and parse the response as JSON.

    The prompt should instruct the model to respond with valid JSON only.
    The proxy adds a JSON instruction suffix automatically when jsonMode
    could be used, but we also handle it here for robustness.
    """
    raw = await ask_claude(
        prompt, system=system, model=model,
        max_tokens=max_tokens, temperature=temperature,
        category=category, json_mode=True,
        user_id=user_id, tenant_id=tenant_id,
        attribution_token=attribution_token,
    )

    cleaned = _extract_json_candidate(raw)

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        repaired = await _repair_json_response(
            raw,
            system,
            category,
            max_tokens,
            user_id,
            tenant_id,
            attribution_token,
        )
        if repaired is not None:
            logger.info("AI JSON response repaired for category=%s", category)
            return repaired

        logger.warning("AI proxy returned non-JSON after repair attempt for category=%s (%d chars)", category, len(raw))
        return {"raw": raw}
