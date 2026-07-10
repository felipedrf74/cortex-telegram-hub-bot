import logging
import os
import sys
import time
import secrets
from contextvars import ContextVar
from pathlib import Path

# Add project root to path so `models`, `searchers`, `services` resolve
sys.path.insert(0, os.path.dirname(__file__))

# Load .env from parent directory (shared with TS bot)
from dotenv import load_dotenv

_shared_env_candidates = (
    Path(__file__).resolve().parent.parent / ".env",
    Path(__file__).resolve().parent.parent / ".env.agents",
    Path(__file__).resolve().parent / ".env",
)

for _env_path in _shared_env_candidates:
    if _env_path.exists():
        load_dotenv(_env_path, override=False)
        break

from fastapi import FastAPI, Request
from starlette.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from routers.research import router as research_router
from routers.books import router as books_router
from config import cfg
from services.log_redaction import SecretRedactionFilter
from services.claude_client import AiProxyError

# ── Distributed tracing (Quarter audit item) ──────────────────────────
#
# Mirror of the bot's src/utils/request-context.ts. Every incoming HTTP
# request gets a `reqId` that's either honored from the X-Request-Id
# header (when the bot upstream sends one) or freshly generated. The ID
# is stored in a contextvars-backed ContextVar so it survives across
# `await` boundaries inside the FastAPI handler, and a logging Filter
# pulls it back out and stamps it on every log line emitted during the
# request.
#
# This makes it possible to grep one requestId across BOTH services'
# logs and see the full trace: bot received message → bot called engine
# → engine ran research → engine returned → bot sent reply.

_request_id_var: ContextVar[str] = ContextVar("request_id", default="-")


def _generate_request_id() -> str:
    """
    Same shape as the TS generator (base36 time + base36 random suffix)
    so the IDs look uniform when grepped across logs from both services.
    Python doesn't have a one-liner for base36 so we encode manually.
    """
    def _b36(n: int) -> str:
        if n == 0:
            return "0"
        chars = "0123456789abcdefghijklmnopqrstuvwxyz"
        out = []
        while n:
            n, r = divmod(n, 36)
            out.append(chars[r])
        return "".join(reversed(out))

    t = _b36(int(time.time() * 1000))
    r = _b36(secrets.randbelow(36 ** 5)).rjust(5, "0")
    return f"{t}-{r}"


class RequestIdMiddleware(BaseHTTPMiddleware):
    """
    Reads X-Request-Id from incoming requests (or generates a fresh one),
    stores it in the contextvar for the duration of the request, and
    echoes it back in the response. This is the FastAPI side of the
    distributed tracing handshake.

    NOTE: We deliberately do NOT call _request_id_var.reset(token) in a
    finally block. ContextVars in async code are per-Task — Starlette runs
    each request in its own task, and when the task ends the contextvar
    value is released automatically. If we DID reset() in finally, we'd
    clear the value BEFORE uvicorn's access log fires (uvicorn writes its
    access log after the middleware chain completes), which means every
    request line would show `reqId=-` regardless of what was in the header.
    """

    async def dispatch(self, request: Request, call_next):
        incoming = request.headers.get("x-request-id")
        request_id = incoming or _generate_request_id()
        _request_id_var.set(request_id)
        response = await call_next(request)
        response.headers["x-request-id"] = request_id
        return response


class InternalSecretMiddleware(BaseHTTPMiddleware):
    """
    Protect every content-engine route except /health with the same shared
    internal secret used by the TypeScript backend's /api/v1/internal routes.
    """

    async def dispatch(self, request: Request, call_next):
        if request.url.path == "/health":
            return await call_next(request)

        expected = cfg.internal_api_secret
        provided = request.headers.get("x-internal-secret") or ""
        expected_bytes = (expected or "").encode("utf-8")
        provided_bytes = provided.encode("utf-8", "replace")
        if not expected_bytes or not secrets.compare_digest(provided_bytes, expected_bytes):
            return JSONResponse(
                status_code=401,
                content={"error": {"code": "UNAUTHORIZED", "message": "Unauthorized"}},
            )

        return await call_next(request)


class RequestIdFilter(logging.Filter):
    """
    Logging filter that injects the current request_id into every log
    record. Pairs with the format string below — `%(request_id)s` reads
    the value the filter just attached to the record.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = _request_id_var.get("-")
        return True


# Configure root logging with the request_id filter applied to the handler.
# We have to be aggressive here because uvicorn configures its OWN loggers
# (`uvicorn`, `uvicorn.access`, `uvicorn.error`) at startup with their own
# handlers — those handlers don't inherit from root, so just configuring
# root isn't enough. We rebuild the relevant loggers explicitly.
_FORMAT = "%(asctime)s %(levelname)s [%(name)s] [reqId=%(request_id)s] %(message)s"
_request_filter = RequestIdFilter()
_secret_filter = SecretRedactionFilter()


def _make_handler() -> logging.StreamHandler:
    h = logging.StreamHandler()
    h.setFormatter(logging.Formatter(_FORMAT))
    h.addFilter(_request_filter)
    h.addFilter(_secret_filter)
    return h


# Root + our app logger
_root = logging.getLogger()
_root.handlers = [_make_handler()]
_root.addFilter(_secret_filter)
_root.setLevel(logging.INFO)

# Override uvicorn's loggers so the access log line ALSO carries reqId.
# Without this, uvicorn writes its access log in its own bare format and
# the trace ID is invisible on the request line — it'd only show up on
# our application's logger.info() calls inside the handler.
for _name in ("content-engine", "uvicorn", "uvicorn.access", "uvicorn.error", "fastapi"):
    _lg = logging.getLogger(_name)
    _lg.handlers = [_make_handler()]
    _lg.addFilter(_secret_filter)
    _lg.propagate = False  # don't double-log via root
    _lg.setLevel(logging.INFO)

logger = logging.getLogger("content-engine")

app = FastAPI(
    title="Nexus Hub Content Engine",
    version="0.1.0",
    description="Research-powered content creation engine for the Nexus Hub Telegram bot",
)

# Register auth before tracing because Starlette wraps middleware in reverse
# registration order; RequestIdMiddleware must be outermost so even rejected
# requests receive the x-request-id echo header.
app.add_middleware(InternalSecretMiddleware)
app.add_middleware(RequestIdMiddleware)

app.include_router(research_router)
app.include_router(books_router)


@app.exception_handler(AiProxyError)
async def stable_ai_proxy_error_handler(_request: Request, exc: AiProxyError) -> JSONResponse:
    """Preserve the TS model-access contract across the Python service hop."""
    headers = {}
    if exc.status_code == 429 and exc.retry_after:
        headers["Retry-After"] = exc.retry_after
    return JSONResponse(
        status_code=exc.status_code,
        headers=headers,
        content={
            "ok": False,
            "error": {
                "code": exc.code,
                "message": exc.public_message,
                "details": exc.details,
            },
        },
    )


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "version": "0.1.0"}


@app.get("/ready")
async def ready() -> dict:
    return {
        "status": "ready",
        "version": "0.1.0",
        "internalAuthConfigured": bool(cfg.internal_api_secret),
        "routers": ["research", "books"],
    }


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("CONTENT_ENGINE_PORT", "8100"))
    reload = os.environ.get("ENV", "production") != "production"
    logger.info("Starting Content Engine on port %d (reload=%s)", port, reload)
    uvicorn.run("main:app", host="127.0.0.1", port=port, reload=reload)
