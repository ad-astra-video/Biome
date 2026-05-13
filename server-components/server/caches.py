"""
TTL caches for upstream-fetched data.

Used by the routes module to avoid hammering HuggingFace on every model
picker render — the renderer batches one request per visible model when
settings opens, and the same IDs repeat back-to-back across reopens.

In-memory and per-process. Bounded only by the working set of keys the
renderer asks about, which is fine for an interactive UI. If a future
endpoint admits user-controlled high-cardinality keys, swap for an LRU
implementation rather than letting the dict grow unbounded.
"""

import asyncio
import time
from collections.abc import Awaitable, Callable


class TtlCache[K, V]:
    """Per-key TTL cache. `get` returns `None` on miss or expiry, `set`
    records a fresh value with the current monotonic timestamp.

    Not thread-safe. All access from the same asyncio task is fine since
    Python's GIL makes dict mutations atomic, but cross-thread use needs
    external synchronisation. Routes are async-only, so this is moot in
    practice."""

    def __init__(self, ttl_seconds: float) -> None:
        self._ttl = ttl_seconds
        self._store: dict[K, tuple[float, V]] = {}
        self._in_flight: dict[K, asyncio.Future[V]] = {}

    def get(self, key: K) -> V | None:
        entry = self._store.get(key)
        if entry is None:
            return None
        timestamp, value = entry
        if time.monotonic() - timestamp >= self._ttl:
            return None
        return value

    def set(self, key: K, value: V) -> None:
        self._store[key] = (time.monotonic(), value)

    async def get_or_fetch(self, key: K, fetcher: Callable[[], Awaitable[V]]) -> V:
        """Return the cached value if present; otherwise call ``fetcher``,
        cache the result, and return it. Concurrent callers that miss the
        same key share a single in-flight fetch — they all await the same
        ``Future`` and the cache is populated exactly once.

        On fetcher failure the exception propagates to every coalesced
        waiter and nothing is cached, so the next call retries. Callers
        that need to soft-fall a failure (e.g. "return a default but don't
        cache it") should let the fetcher raise and catch the exception
        outside ``get_or_fetch``."""
        cached = self.get(key)
        if cached is not None:
            return cached

        in_flight = self._in_flight.get(key)
        if in_flight is not None:
            return await in_flight

        future: asyncio.Future[V] = asyncio.get_running_loop().create_future()
        self._in_flight[key] = future
        try:
            value = await fetcher()
        except BaseException as e:
            future.set_exception(e)
            raise
        else:
            self.set(key, value)
            future.set_result(value)
            return value
        finally:
            self._in_flight.pop(key, None)
