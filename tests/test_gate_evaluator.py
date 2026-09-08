import uuid
from types import SimpleNamespace

import httpx
import pytest
import respx

from app.services.gate_evaluator import GateOutcome, evaluate_external_db_gate, evaluate_gate


def make_campaign(gate_strategy: str, gate_config: dict | None = None):
    return SimpleNamespace(id=uuid.uuid4(), gate_strategy=gate_strategy, gate_config=gate_config or {})


# ---- strategy: none ----

async def test_none_strategy_always_passes(fake_redis):
    campaign = make_campaign("none")
    result = await evaluate_gate(redis_client=fake_redis, campaign=campaign, ig_user_id="u1", ig_username="aziz")
    assert result.outcome == GateOutcome.PASS


# ---- strategy: self_confirm (S1) ----

async def test_self_confirm_pending_until_tapped(fake_redis):
    campaign = make_campaign("self_confirm")
    result = await evaluate_gate(
        redis_client=fake_redis, campaign=campaign, ig_user_id="u1", ig_username="aziz", trigger="check"
    )
    assert result.outcome == GateOutcome.PENDING


async def test_self_confirm_passes_on_tap(fake_redis):
    campaign = make_campaign("self_confirm")
    result = await evaluate_gate(
        redis_client=fake_redis,
        campaign=campaign,
        ig_user_id="u1",
        ig_username="aziz",
        trigger="self_confirm_tap",
    )
    assert result.outcome == GateOutcome.PASS


async def test_self_confirm_result_is_cached_across_calls(fake_redis):
    campaign = make_campaign("self_confirm")
    first = await evaluate_gate(
        redis_client=fake_redis, campaign=campaign, ig_user_id="u1", ig_username="aziz", trigger="self_confirm_tap"
    )
    assert first.outcome == GateOutcome.PASS

    # A second call with a "check" trigger (which alone would be PENDING) must
    # still return PASS because FR-5.6 caches the prior outcome per campaign+user.
    second = await evaluate_gate(
        redis_client=fake_redis, campaign=campaign, ig_user_id="u1", ig_username="aziz", trigger="check"
    )
    assert second.outcome == GateOutcome.PASS
    assert second.detail == "cached"


async def test_pending_outcome_is_not_cached(fake_redis):
    campaign = make_campaign("self_confirm")
    await evaluate_gate(redis_client=fake_redis, campaign=campaign, ig_user_id="u1", ig_username="aziz", trigger="check")
    cached = await fake_redis.get(f"gate:{campaign.id}:u1")
    assert cached is None


# ---- strategy: engagement (S5) ----

async def test_engagement_pending_until_user_replies(fake_redis):
    campaign = make_campaign("engagement")
    result = await evaluate_gate(
        redis_client=fake_redis, campaign=campaign, ig_user_id="u1", ig_username="aziz", trigger="check"
    )
    assert result.outcome == GateOutcome.PENDING


async def test_engagement_passes_when_user_replied(fake_redis):
    campaign = make_campaign("engagement")
    result = await evaluate_gate(
        redis_client=fake_redis, campaign=campaign, ig_user_id="u1", ig_username="aziz", trigger="user_replied"
    )
    assert result.outcome == GateOutcome.PASS


# ---- per-user isolation ----

async def test_gate_cache_is_isolated_per_user(fake_redis):
    campaign = make_campaign("self_confirm")
    await evaluate_gate(
        redis_client=fake_redis, campaign=campaign, ig_user_id="u1", ig_username="a", trigger="self_confirm_tap"
    )
    other = await evaluate_gate(
        redis_client=fake_redis, campaign=campaign, ig_user_id="u2", ig_username="b", trigger="check"
    )
    assert other.outcome == GateOutcome.PENDING


# ---- strategy: external_db (S2) ----

async def test_external_db_no_url_configured_fails_closed(fake_redis):
    campaign = make_campaign("external_db", {})
    result = await evaluate_gate(redis_client=fake_redis, campaign=campaign, ig_user_id="u1", ig_username="aziz")
    assert result.outcome == GateOutcome.FAIL


@respx.mock
async def test_external_db_subscribed_true_passes():
    campaign = make_campaign("external_db", {"url": "https://crm.example.uz/check"})
    respx.post("https://crm.example.uz/check").mock(
        return_value=httpx.Response(200, json={"subscribed": True})
    )
    result = await evaluate_external_db_gate(campaign, "u1", "aziz")
    assert result.outcome == GateOutcome.PASS


@respx.mock
async def test_external_db_subscribed_false_fails():
    campaign = make_campaign("external_db", {"url": "https://crm.example.uz/check"})
    respx.post("https://crm.example.uz/check").mock(
        return_value=httpx.Response(200, json={"subscribed": False})
    )
    result = await evaluate_external_db_gate(campaign, "u1", "aziz")
    assert result.outcome == GateOutcome.FAIL


@respx.mock
async def test_external_db_sends_auth_header_when_configured():
    campaign = make_campaign(
        "external_db", {"url": "https://crm.example.uz/check", "auth_header": "Bearer secret123"}
    )
    route = respx.post("https://crm.example.uz/check").mock(
        return_value=httpx.Response(200, json={"subscribed": True})
    )
    await evaluate_external_db_gate(campaign, "u1", "aziz")
    assert route.calls.last.request.headers["authorization"] == "Bearer secret123"


@respx.mock
async def test_external_db_retries_on_failure_then_fails_closed():
    campaign = make_campaign(
        "external_db", {"url": "https://crm.example.uz/check", "retries": 2, "timeout_seconds": 1}
    )
    route = respx.post("https://crm.example.uz/check").mock(return_value=httpx.Response(500))
    result = await evaluate_external_db_gate(campaign, "u1", "aziz")
    assert result.outcome == GateOutcome.FAIL
    # retries=2 -> 1 initial attempt + 2 retries = 3 total calls
    assert route.call_count == 3


@respx.mock
async def test_external_db_recovers_after_transient_failure():
    campaign = make_campaign("external_db", {"url": "https://crm.example.uz/check", "retries": 2})
    respx.post("https://crm.example.uz/check").mock(
        side_effect=[httpx.Response(500), httpx.Response(200, json={"subscribed": True})]
    )
    result = await evaluate_external_db_gate(campaign, "u1", "aziz")
    assert result.outcome == GateOutcome.PASS
