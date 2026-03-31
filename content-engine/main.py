import logging
import os
import sys
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

from fastapi import FastAPI
from routers.research import router as research_router
from routers.books import router as books_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("content-engine")

app = FastAPI(
    title="Nexus Hub Content Engine",
    version="0.1.0",
    description="Research-powered content creation engine for the Nexus Hub Telegram bot",
)

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
