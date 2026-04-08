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

_env_path = Path(__file__).resolve().parent.parent / ".env"
if _env_path.exists():
    load_dotenv(_env_path, override=True)
else:
    _local_env = Path(__file__).resolve().parent / ".env"
    if _local_env.exists():
        load_dotenv(_local_env, override=True)

from fastapi import FastAPI, Request
from starlette.middleware.base import BaseHTTPMiddleware
from routers.research import router as research_router
from routers.books import router as books_router

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
    """

    async def dispatch(self, request: Request, call_next):
        incoming = request.headers.get("x-request-id")
        request_id = incoming or _generate_request_id()
        token = _request_id_var.set(request_id)
        try:
            response = await call_next(request)
            response.headers["x-request-id"] = request_id
            return response
        finally:
            _request_id_var.reset(token)


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
# Doing this on the root logger means uvicorn/fastapi/starlette logs ALSO
# pick up the request ID, not just our own logger.
_handler = logging.StreamHandler()
_handler.setFormatter(
    logging.Formatter(
        "%(asctime)s %(levelname)s [%(name)s] [reqId=%(request_id)s] %(message)s"
    )
)
_handler.addFilter(RequestIdFilter())
_root = logging.getLogger()
_root.handlers = [_handler]
_root.setLevel(logging.INFO)

logger = logging.getLogger("content-engine")

app = FastAPI(
    title="Nexus Hub Content Engine",
    version="0.1.0",
    description="Research-powered content creation engine for the Nexus Hub Telegram bot",
)

# Mount the tracing middleware FIRST so it covers everything below it,
# including FastAPI's routing and exception handlers.
app.add_middleware(RequestIdMiddleware)

app.include_router(research_router)
app.include_router(books_router)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "version": "0.1.0"}


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("CONTENT_ENGINE_PORT", "8100"))
    reload = os.environ.get("ENV", "production") != "production"
    logger.info("Starting Content Engine on port %d (reload=%s)", port, reload)
    uvicorn.run("main:app", host="127.0.0.1", port=port, reload=reload)
