"""
FR-6: the DM conversation state machine.

States: opened -> awaiting_confirm -> gate_pending -> completed | declined | abandoned | failed

Quick-reply payload conventions used throughout:
  CONFIRM_YES  - user wants the link (step 9 in TZ section 4.1)
  CONFIRM_NO   - user declines (A4)
  GATE_CONFIRM - user claims to have completed the gate action (S1) or asks to be re-checked (S2)
"""
import logging
import uuid
from datetime import datetime, timedelta, timezone

import redis.asyncio as redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.campaign import Campaign, MessageTemplate
from app.models.conversation import Conversation
from app.models.lead import Lead
from app.models.message import MessageLog
from app.services.gate_evaluator import GateOutcome, evaluate_gate
from app.services.meta_client import MetaAPIError, MetaClient
from app.services.template_renderer import apply_utm, build_context, render_template

logger = logging.getLogger("conversation_engine")
settings = get_settings()

CONFIRM_YES = "CONFIRM_YES"
CONFIRM_NO = "CONFIRM_NO"
GATE_CONFIRM = "GATE_CONFIRM"

STANDARD_WINDOW = timedelta(hours=24)


async def pick_variant(r: redis.Redis, campaign_id: str, step: str, templates: list[MessageTemplate]) -> MessageTemplate | None:
    """FR-4.3: rotate between reply/message variants for the same step."""
    variants = sorted([t for t in templates if t.step == step], key=lambda t: t.sort_order)
    if not variants:
        return None
    if len(variants) == 1:
        return variants[0]
    key = f"variant_rotation:{campaign_id}:{step}"
    idx = await r.incr(key)
    return variants[(idx - 1) % len(variants)]


async def _get_conversation(session: AsyncSession, campaign_id: uuid.UUID, ig_user_id: str) -> Conversation | None:
    res = await session.execute(
        select(Conversation).where(Conversation.campaign_id == campaign_id, Conversation.ig_user_id == ig_user_id)
    )
    return res.scalar_one_or_none()


async def _log_message(session: AsyncSession, conversation_id, direction: str, step: str, body: str, status: str, error: str | None = None):
    session.add(
        MessageLog(
            conversation_id=conversation_id,
            direction=direction,
            step=step,
            body=body,
            delivery_status=status,
            meta_error_message=error,
        )
    )


async def _upsert_lead(session: AsyncSession, campaign_id, ig_user_id: str, ig_username: str | None, **fields):
    res = await session.execute(select(Lead).where(Lead.campaign_id == campaign_id, Lead.ig_user_id == ig_user_id))
    lead = res.scalar_one_or_none()
    if lead is None:
        lead = Lead(campaign_id=campaign_id, ig_user_id=ig_user_id, ig_username=ig_username)
        session.add(lead)
    for k, v in fields.items():
        setattr(lead, k, v)
    return lead


def _quick_replies(template: MessageTemplate) -> list[dict]:
    return template.quick_replies or []


async def _send_dm_step(
    session: AsyncSession,
    meta: MetaClient,
    r: redis.Redis,
    campaign: Campaign,
    conversation: Conversation,
    step: str,
    reward_link_override: str | None = None,
) -> MessageTemplate | None:
    template = await pick_variant(r, str(campaign.id), step, campaign.templates)
    if template is None:
        logger.warning("Campaign %s has no template for step '%s'", campaign.id, step)
        return None

    # FR-7.2: apply the campaign's UTM params to the reward link wherever
    # {link} is rendered, so delivered links are consistently tagged.
    raw_link = reward_link_override or campaign.reward_link
    context = build_context(
        username=conversation.ig_username,
        first_name=None,
        link=apply_utm(raw_link, campaign.utm_params),
        keyword=conversation.matched_keyword,
    )
    body = render_template(template.body, context)

    try:
        if step == "opening" and conversation.triggering_comment_id:
            # Delivered as a private reply to the triggering comment (TZ section 2.3's
            # primary delivery mechanism), not as a freeform message to a user we haven't
            # messaged before -- Meta does not allow unsolicited outbound DMs (NFR-8).
            await meta.private_reply_to_comment(conversation.triggering_comment_id, body, _quick_replies(template))
        else:
            await meta.send_dm(conversation.ig_user_id, body, _quick_replies(template))
        await _log_message(session, conversation.id, "out", step, body, "sent")
    except MetaAPIError as exc:
        logger.error("DM send failed (step=%s, user=%s): %s", step, conversation.ig_user_id, exc)
        await _log_message(session, conversation.id, "out", step, body, "failed", str(exc))
    return template


async def start_funnel(
    session: AsyncSession,
    meta: MetaClient,
    r: redis.Redis,
    campaign: Campaign,
    *,
    ig_user_id: str,
    ig_username: str | None,
    triggering_comment_id: str,
    matched_keyword: str,
) -> Conversation:
    """Handles TZ 4.1 steps 7-8: public reply already sent by the caller; this opens the DM thread."""
    conversation = await _get_conversation(session, campaign.id, ig_user_id)
    if conversation is None:
        conversation = Conversation(
            campaign_id=campaign.id,
            ig_user_id=ig_user_id,
            ig_username=ig_username,
            triggering_comment_id=triggering_comment_id,
            matched_keyword=matched_keyword,
            state="opened",
        )
        session.add(conversation)
        await session.flush()

    await _upsert_lead(session, campaign.id, ig_user_id, ig_username, first_triggered_at=datetime.now(timezone.utc))

    await _send_dm_step(session, meta, r, campaign, conversation, "opening")
    conversation.state = "awaiting_confirm"
    conversation.window_expires_at = datetime.now(timezone.utc) + STANDARD_WINDOW
    return conversation


async def _advance_after_yes(session, meta, r, campaign: Campaign, conversation: Conversation):
    conversation.last_user_message_at = datetime.now(timezone.utc)
    conversation.window_expires_at = datetime.now(timezone.utc) + STANDARD_WINDOW

    if campaign.gate_strategy == "none":
        await _deliver_reward(session, meta, r, campaign, conversation)
        return

    if campaign.gate_strategy == "engagement":
        # S5: the user's own reply already satisfies the gate.
        result = await evaluate_gate(
            redis_client=r, campaign=campaign, ig_user_id=conversation.ig_user_id,
            ig_username=conversation.ig_username, trigger="user_replied",
        )
        if result.outcome == GateOutcome.PASS:
            await _deliver_reward(session, meta, r, campaign, conversation)
            return

    conversation.state = "gate_pending"
    await _send_dm_step(session, meta, r, campaign, conversation, "gate")


async def _deliver_reward(session, meta, r, campaign: Campaign, conversation: Conversation):
    await _send_dm_step(session, meta, r, campaign, conversation, "reward")
    conversation.state = "completed"
    await _upsert_lead(
        session, campaign.id, conversation.ig_user_id, conversation.ig_username,
        completed_at=datetime.now(timezone.utc), gate_result="pass", link_delivered=True,
    )


async def _handle_gate_recheck(session, meta, r, campaign: Campaign, conversation: Conversation):
    trigger = "self_confirm_tap" if campaign.gate_strategy == "self_confirm" else "check"
    result = await evaluate_gate(
        redis_client=r, campaign=campaign, ig_user_id=conversation.ig_user_id,
        ig_username=conversation.ig_username, trigger=trigger,
    )

    if result.outcome == GateOutcome.PASS:
        await _deliver_reward(session, meta, r, campaign, conversation)
        return

    conversation.gate_retry_count += 1
    if conversation.gate_retry_count >= campaign.gate_max_retries:
        conversation.state = "failed"
        await _upsert_lead(session, campaign.id, conversation.ig_user_id, conversation.ig_username, gate_result="fail")
        return

    await _send_dm_step(session, meta, r, campaign, conversation, "retry")


async def handle_postback(
    session: AsyncSession, meta: MetaClient, r: redis.Redis, campaign: Campaign, conversation: Conversation, payload: str
):
    if payload == CONFIRM_YES and conversation.state == "awaiting_confirm":
        await _advance_after_yes(session, meta, r, campaign, conversation)
    elif payload == CONFIRM_NO and conversation.state == "awaiting_confirm":
        await _send_dm_step(session, meta, r, campaign, conversation, "decline")
        conversation.state = "declined"
        await _upsert_lead(session, campaign.id, conversation.ig_user_id, conversation.ig_username, gate_result="not_applicable")
    elif payload == GATE_CONFIRM and conversation.state == "gate_pending":
        await _handle_gate_recheck(session, meta, r, campaign, conversation)
    else:
        logger.info("Ignored postback '%s' for conversation %s in state %s", payload, conversation.id, conversation.state)


async def handle_free_text_reply(session: AsyncSession, conversation: Conversation):
    """Any inbound DM (not a quick-reply postback) still counts as opening/renewing the messaging window."""
    conversation.last_user_message_at = datetime.now(timezone.utc)
    conversation.window_expires_at = datetime.now(timezone.utc) + STANDARD_WINDOW
