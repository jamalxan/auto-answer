import pytest

from app.services import rate_limiter


@pytest.fixture(autouse=True)
def _patch_redis(fake_redis, monkeypatch):
    """rate_limiter keeps its own module-level redis singleton; point it at fake_redis."""
    monkeypatch.setattr(rate_limiter, "get_redis", lambda: fake_redis)
    yield


async def test_check_and_increment_allows_under_limit():
    for _ in range(5):
        await rate_limiter.check_and_increment("acc-1", limit_per_hour=10)
    # no exception raised


async def test_check_and_increment_raises_over_limit():
    for _ in range(3):
        await rate_limiter.check_and_increment("acc-1", limit_per_hour=3)
    with pytest.raises(rate_limiter.RateLimitExceeded):
        await rate_limiter.check_and_increment("acc-1", limit_per_hour=3)


async def test_check_and_increment_buckets_are_per_account():
    for _ in range(3):
        await rate_limiter.check_and_increment("acc-1", limit_per_hour=3)
    # a different account has its own independent budget
    await rate_limiter.check_and_increment("acc-2", limit_per_hour=3)


async def test_note_meta_throttle_false_below_threshold():
    for _ in range(rate_limiter.SUSTAINED_THROTTLE_THRESHOLD - 1):
        result = await rate_limiter.note_meta_throttle("acc-1")
        assert result is False


async def test_note_meta_throttle_true_once_threshold_crossed():
    results = [await rate_limiter.note_meta_throttle("acc-1") for _ in range(rate_limiter.SUSTAINED_THROTTLE_THRESHOLD)]
    # only the call that crosses the threshold returns True
    assert results.count(True) == 1
    assert results[-1] is True


async def test_note_meta_throttle_does_not_realert_within_cooldown():
    for _ in range(rate_limiter.SUSTAINED_THROTTLE_THRESHOLD):
        await rate_limiter.note_meta_throttle("acc-1")
    # further hits keep incrementing but must not fire another alert immediately
    again = await rate_limiter.note_meta_throttle("acc-1")
    assert again is False
