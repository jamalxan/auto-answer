"""
FR-5: gate / verification step. Implements strategies S1/S2/S5 from TZ section 2.2
(S3 "manual audit" and S4 "native Subscriptions" are operational/eligibility-dependent
and are not automatable API calls, so they are not modeled here — S3 is just "gate: none"
plus admin review in the Leads screen, S4 would be added as a new strategy once
eligibility is confirmed).
"""
import json
import logging
from dataclasses import dataclass
from enum import Enum

import httpx
import redis.asyncio as redis

from app.models.campaign import Campaign

logger = logging.getLogger("gate_evaluator")

GATE_CACHE_TTL_SECONDS = 6 * 3600


class GateOutcome(str, Enum):
    PASS = "pass"
    FAIL = "fail"
    PENDING = "pending"  # requires a further user action (self_confirm / engagement)


@dataclass
class GateResult:
    outcome: GateOutcome
    detail: str = ""


async def _cache_get(r: redis.Redis, campaign_id: str, ig_user_id: str) -> GateOutcome | None:
    raw = await r.get(f"gate:{campaign_id}:{ig_user_id}")
    return GateOutcome(raw) if raw else None


async def _cache_set(r: redis.Redis, campaign_id: str, ig_user_id: str, outcome: GateOutcome) -> None:
    await r.set(f"gate:{campaign_id}:{ig_user_id}", outcome.value, ex=GATE_CACHE_TTL_SECONDS)


async def evaluate_external_db_gate(campaign: Campaign, ig_user_id: str, ig_username: str | None) -> GateResult:
    """
    S2: query the business's own subscriber source (CRM / Telegram bot / site signup DB)
    for whether this Instagram user is a known subscriber.
    """
    config = campaign.gate_config or {}
    url = config.get("url")
    if not url:
        return GateResult(GateOutcome.FAIL, "external_db gate has no url configured")

    timeout = float(config.get("timeout_seconds", 5))
    retries = int(config.get("retries", 2))
    headers = {}
    if auth_header := config.get("auth_header"):
        headers["Authorization"] = auth_header

    payload = {"ig_user_id": ig_user_id, "ig_username": ig_username}

    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(url, json=payload, headers=headers)
                resp.raise_for_status()
                data = resp.json()
                subscribed = bool(data.get("subscribed"))
                return GateResult(GateOutcome.PASS if subscribed else GateOutcome.FAIL, json.dumps(data)[:500])
        except (httpx.HTTPError, ValueError) as exc:
            last_error = exc
            logger.warning("external_db gate attempt %s failed: %s", attempt + 1, exc)

    return GateResult(GateOutcome.FAIL, f"external_db lookup failed after {retries + 1} attempts: {last_error}")


async def evaluate_gate(
    *,
    redis_client: redis.Redis,
    campaign: Campaign,
    ig_user_id: str,
    ig_username: str | None,
    trigger: str = "check",
) -> GateResult:
    """
    trigger is one of: "check" (evaluate now, e.g. external_db / engagement),
    "self_confirm_tap" (user tapped the self-confirm quick reply -> immediate pass),
    "user_replied" (any inbound DM -> satisfies the "engagement" strategy).
    """
    strategy = campaign.gate_strategy

    if strategy == "none":
        return GateResult(GateOutcome.PASS)

    cached = await _cache_get(redis_client, str(campaign.id), ig_user_id)  # FR-5.6
    if cached:
        return GateResult(cached, "cached")

    if strategy == "self_confirm":
        outcome = GateOutcome.PASS if trigger == "self_confirm_tap" else GateOutcome.PENDING
    elif strategy == "engagement":
        outcome = GateOutcome.PASS if trigger == "user_replied" else GateOutcome.PENDING
    elif strategy == "external_db":
        result = await evaluate_external_db_gate(campaign, ig_user_id, ig_username)
        outcome = result.outcome
    else:
        outcome = GateOutcome.FAIL

    if outcome != GateOutcome.PENDING:
        await _cache_set(redis_client, str(campaign.id), ig_user_id, outcome)
    return GateResult(outcome)
