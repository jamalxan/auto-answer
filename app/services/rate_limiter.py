"""
NFR-6: all Meta API calls pass through a rate limiter with per-account budgets.
Simple Redis sliding-window counter (fixed window is good enough for this volume;
see A9 / NFR-2 for the throughput target this needs to support).
"""
import time

import redis.asyncio as redis

from app.config import get_settings

settings = get_settings()
_redis: redis.Redis | None = None


def get_redis() -> redis.Redis:
    global _redis
    if _redis is None:
        _redis = redis.from_url(settings.redis_url, decode_responses=True)
    return _redis


class RateLimitExceeded(Exception):
    pass


# A9 / FR-10.1: how many Meta-side throttling errors within the window count
# as "sustained" (vs. one transient blip), and how often we're willing to
# re-alert once it is.
SUSTAINED_THROTTLE_THRESHOLD = 3
SUSTAINED_THROTTLE_WINDOW_SECONDS = 600
SUSTAINED_THROTTLE_ALERT_COOLDOWN_SECONDS = 3600


async def note_meta_throttle(account_id: str) -> bool:
    """
    Records one Meta-side rate-limit error (HTTP 429 / error codes 4,17,32,613)
    for this account. Returns True at most once per cooldown window, the
    moment the sustained threshold is crossed -- callers use this as the
    "should I send an admin alert now" signal, so a single retry storm
    triggers one alert rather than one per failed call.
    """
    r = get_redis()
    hits_key = f"meta_throttle_hits:{account_id}"
    count = await r.incr(hits_key)
    if count == 1:
        await r.expire(hits_key, SUSTAINED_THROTTLE_WINDOW_SECONDS)
    if count < SUSTAINED_THROTTLE_THRESHOLD:
        return False

    alerted_key = f"meta_throttle_alerted:{account_id}"
    return bool(await r.set(alerted_key, "1", ex=SUSTAINED_THROTTLE_ALERT_COOLDOWN_SECONDS, nx=True))


async def check_and_increment(account_id: str, limit_per_hour: int | None = None) -> None:
    """
    Raises RateLimitExceeded if the account has exceeded its hourly Meta API budget.
    Caller (meta_client) should back off and re-queue rather than call through.
    """
    limit = limit_per_hour or settings.meta_rate_limit_per_account_per_hour
    r = get_redis()
    window = int(time.time() // 3600)
    key = f"ratelimit:meta:{account_id}:{window}"

    count = await r.incr(key)
    if count == 1:
        await r.expire(key, 3600)
    if count > limit:
        raise RateLimitExceeded(f"Account {account_id} exceeded {limit} Graph API calls/hour")
