"""Shared request-disconnect cancellation for cost-bearing route work."""

import asyncio
from collections.abc import Awaitable, Callable
from typing import TypeVar

from fastapi import Request


T = TypeVar("T")


async def run_until_client_disconnect(
    request: Request,
    operation: Callable[[], Awaitable[T]],
) -> T:
    """Cancel and drain provider/search work when the HTTP client disconnects."""
    operation_task = asyncio.create_task(operation())
    disconnect_task: asyncio.Task[None] | None = None

    async def wait_for_disconnect() -> None:
        while not await request.is_disconnected():
            await asyncio.sleep(0.05)

    try:
        # Let immediately-completing operations finish before starting an
        # ASGI receive poll. Some test/server transports cannot resolve that
        # poll until the response begins, which would otherwise deadlock a
        # completed operation during cleanup.
        await asyncio.sleep(0)
        if operation_task.done():
            return await operation_task

        disconnect_task = asyncio.create_task(wait_for_disconnect())
        done, _ = await asyncio.wait(
            {operation_task, disconnect_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if operation_task in done:
            return await operation_task
        operation_task.cancel()
        try:
            await operation_task
        except asyncio.CancelledError:
            pass
        raise asyncio.CancelledError("content_engine_client_disconnected")
    finally:
        tasks = tuple(task for task in (operation_task, disconnect_task) if task is not None)
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
