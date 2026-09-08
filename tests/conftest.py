"""
Shared fixtures. `fake_redis` is a minimal in-memory stand-in implementing
only the subset of the redis.asyncio.Redis surface this codebase actually
calls (get/set/incr/expire), so pure-logic tests (gate evaluation, variant
rotation) don't need a live Redis server.
"""
import time

import pytest


class FakeRedis:
    def __init__(self):
        self._store: dict[str, str] = {}
        self._expiry: dict[str, float] = {}

    def _expired(self, key: str) -> bool:
        exp = self._expiry.get(key)
        return exp is not None and exp < time.time()

    async def get(self, key: str):
        if key not in self._store or self._expired(key):
            self._store.pop(key, None)
            self._expiry.pop(key, None)
            return None
        return self._store[key]

    async def set(self, key: str, value, ex: int | None = None, nx: bool = False):
        if nx and key in self._store and not self._expired(key):
            return None
        self._store[key] = str(value)
        if ex is not None:
            self._expiry[key] = time.time() + ex
        else:
            self._expiry.pop(key, None)
        return True

    async def incr(self, key: str) -> int:
        current = int(await self.get(key) or 0)
        current += 1
        self._store[key] = str(current)
        return current

    async def expire(self, key: str, seconds: int) -> None:
        self._expiry[key] = time.time() + seconds


@pytest.fixture
def fake_redis():
    return FakeRedis()
