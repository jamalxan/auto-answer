"""
ARQ worker tasks. Each task opens its own DB session and commits/closes it —
tasks must never assume they share a session with the API process (Section 7.1).
"""
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import case, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload

from app.config import get_settings
from app.database import AsyncSessionLocal
from app.deps import get_redis
from app.models.account import Account
from app.models.campaign import Campaign
from app.models.conversation import Conversation
from app.models.event import CommentEvent
from app.security import decrypt_token, encrypt_token
from app.services import conversation_engine, notifications
from app.services.keyword_matcher import match_comment
from app.services.meta_client import MetaAPIError, MetaClient, REQUIRED_WEBHOOK_FIELDS

logger = logging.getLogger("worker.tasks")
settings = get_settings()

TOKEN_REFRESH_THRESHOLD_DAYS = 5
DELIVERY_HEALTH_WINDOW_HOURS = 1
DELIVERY_HEALTH_MIN_SAMPLE = 5
DELIVERY_HEALTH_ALERT_COOLDOWN_SECONDS = 3600


async def _load_active_campaigns(session, account_id) -> list[Campaign]:
    res = await session.execute(
        select(Campaign)
        .options(selectinload(Campaign.keywords), selectinload(Campaign.templates), selectinload(Campaign.media_targets))
        .where(Campaign.account_id == account_id, Campaign.status == "active")
        .order_by(Campaign.priority.asc())
    )
    return list(res.scalars().unique().all())


def _resolve_campaign(campaigns: list[Campaign], ig_media_id: str) -> list[Campaign]:
    """FR-2.2 / FR-2.5: campaigns targeting this specific media first, then 'all posts', by priority."""
    specific = [c for c in campaigns if c.target_mode == "specific" and any(m.ig_media_id == ig_media_id for m in c.media_targets)]
    catch_all = [c for c in campaigns if c.target_mode == "all"]
    return specific + catch_all


async def _within_cooldown(session, campaign_id, ig_user_id: str, cooldown_hours: int) -> bool:
    """A3: suppress a duplicate public reply/trigger within the cooldown window."""
    if cooldown_hours <= 0:
        return False
    since = datetime.now(timezone.utc) - timedelta(hours=cooldown_hours)
    res = await session.execute(
        select(CommentEvent.id).where(
            CommentEvent.campaign_id == campaign_id,
            CommentEvent.ig_user_id == ig_user_id,
            CommentEvent.match_result == "matched",
            CommentEvent.received_at >= since,
        )
    )
    return res.first() is not None


async def _decrypt_or_flag(account: Account) -> str | None:
    """
    Every worker entry point needs the account's live access token. A failed
    decrypt (TOKEN_ENCRYPTION_KEY rotated without re-encrypting existing rows,
    a corrupted column, etc.) is operationally identical to A10 "access token
    expired or revoked" -- the account needs to be reconnected -- so it's
    handled the same way (halt + alert) instead of crashing the caller's job.
    """
    try:
        return decrypt_token(account.access_token_encrypted)
    except ValueError:
        logger.error("Could not decrypt stored token for %s -- flagging for reconnect", account.ig_username)
        if account.status == "active":
            account.status = "expired"
            await notifications.alert_token_expiry(account.ig_username)
        return None


async def process_comment_event(ctx, change_value: dict, entry_id: str) -> None:
    ig_comment_id = change_value.get("id")
    if not ig_comment_id:
        logger.warning("Comment webhook payload missing id: %s", change_value)
        return

    comment_text = change_value.get("text", "") or ""
    ig_media_id = (change_value.get("media") or {}).get("id", "")
    commenter = change_value.get("from") or {}
    ig_user_id = commenter.get("id", "")
    ig_username = commenter.get("username")

    async with AsyncSessionLocal() as session:
        # NFR-4 / A12: idempotency. Reserve the comment id first; a duplicate delivery
        # will hit the unique constraint and we bail out cleanly.
        placeholder = CommentEvent(
            ig_comment_id=ig_comment_id,
            ig_media_id=ig_media_id,
            ig_user_id=ig_user_id,
            ig_username=ig_username,
            comment_text=comment_text,
            match_result="no_match",
        )
        session.add(placeholder)
        try:
            await session.flush()
        except IntegrityError:
            await session.rollback()
            logger.info("Duplicate webhook delivery for comment %s ignored", ig_comment_id)
            return

        res = await session.execute(select(Account).where(Account.ig_user_id == entry_id))
        account = res.scalar_one_or_none()
        if account is None:
            placeholder.match_result = "no_match"
            placeholder.processed_at = datetime.now(timezone.utc)
            await session.commit()
            logger.warning("No connected account for webhook entry id %s", entry_id)
            return

        # A2: never react to the business's own comments (loop prevention, FR-4.5).
        if ig_user_id == account.ig_user_id:
            placeholder.match_result = "self_comment"
            placeholder.processed_at = datetime.now(timezone.utc)
            await session.commit()
            return

        campaigns = _resolve_campaign(await _load_active_campaigns(session, account.id), ig_media_id)

        matched_campaign = None
        match_result = None
        for campaign in campaigns:
            result = match_comment(comment_text, campaign)
            if result.matched:
                matched_campaign = campaign
                match_result = result
                break

        if matched_campaign is None:
            placeholder.match_result = "no_match"
            placeholder.processed_at = datetime.now(timezone.utc)
            await session.commit()
            return

        if await _within_cooldown(session, matched_campaign.id, ig_user_id, matched_campaign.cooldown_hours):
            placeholder.campaign_id = matched_campaign.id
            placeholder.matched_keyword = match_result.keyword
            placeholder.match_result = "cooldown"
            placeholder.processed_at = datetime.now(timezone.utc)
            await session.commit()
            return

        placeholder.campaign_id = matched_campaign.id
        placeholder.matched_keyword = match_result.keyword
        placeholder.match_result = "matched"

        token = await _decrypt_or_flag(account)
        if token is None:
            placeholder.match_result = "token_error"
            placeholder.public_reply_status = "failed"
            placeholder.public_reply_error = "stored access token could not be decrypted"
            placeholder.processed_at = datetime.now(timezone.utc)
            await session.commit()
            return

        client = MetaClient(token, str(account.id), label=account.ig_username)
        redis_client = get_redis()

        # FR-4: public reply, with variant rotation (FR-4.3), unless DM-only mode (FR-4.4).
        if matched_campaign.reply_enabled:
            public_templates = [t for t in matched_campaign.templates if t.step == "public_reply"]
            if public_templates:
                template = await conversation_engine.pick_variant(
                    redis_client, str(matched_campaign.id), "public_reply", matched_campaign.templates
                )
                body = template.body.replace("{username}", ig_username or "")
                try:
                    await client.reply_to_comment(ig_comment_id, body)
                    placeholder.public_reply_status = "sent"
                except MetaAPIError as exc:
                    logger.error("Public reply failed for comment %s: %s", ig_comment_id, exc)
                    placeholder.public_reply_status = "failed"
                    placeholder.public_reply_error = str(exc)
            else:
                placeholder.public_reply_status = "skipped"
        else:
            placeholder.public_reply_status = "disabled"

        # FR-6: open the DM thread (steps 7-8 in TZ 4.1).
        try:
            await conversation_engine.start_funnel(
                session, client, redis_client, matched_campaign,
                ig_user_id=ig_user_id, ig_username=ig_username,
                triggering_comment_id=ig_comment_id, matched_keyword=match_result.keyword,
            )
        except MetaAPIError as exc:
            logger.error("Failed to open DM funnel for %s: %s", ig_user_id, exc)

        placeholder.processed_at = datetime.now(timezone.utc)
        await session.commit()


async def process_message_event(ctx, messaging_event: dict, entry_id: str) -> None:
    sender_id = (messaging_event.get("sender") or {}).get("id")
    recipient_id = (messaging_event.get("recipient") or {}).get("id")
    if not sender_id or not recipient_id:
        return

    async with AsyncSessionLocal() as session:
        res = await session.execute(select(Account).where(Account.ig_user_id == recipient_id))
        account = res.scalar_one_or_none()
        if account is None:
            logger.warning("No account matches recipient id %s for inbound message", recipient_id)
            return

        # Find the most recent non-terminal conversation for this user under this account's campaigns.
        res = await session.execute(
            select(Conversation)
            .where(Conversation.ig_user_id == sender_id)
            .where(Conversation.state.not_in(["completed", "declined", "abandoned", "failed"]))
            .order_by(Conversation.updated_at.desc())
        )
        conversation = res.scalars().first()
        if conversation is None:
            logger.info("No active conversation for inbound message from %s; ignoring", sender_id)
            return

        res = await session.execute(
            select(Campaign)
            .options(selectinload(Campaign.templates), selectinload(Campaign.keywords))
            .where(Campaign.id == conversation.campaign_id)
        )
        campaign = res.scalar_one_or_none()
        if campaign is None:
            return

        token = await _decrypt_or_flag(account)
        if token is None:
            await session.commit()
            return

        client = MetaClient(token, str(account.id), label=account.ig_username)
        redis_client = get_redis()

        postback_payload = None
        if "postback" in messaging_event:
            postback_payload = (messaging_event.get("postback") or {}).get("payload")
        elif "message" in messaging_event and "quick_reply" in messaging_event["message"]:
            postback_payload = messaging_event["message"]["quick_reply"].get("payload")

        try:
            if postback_payload:
                await conversation_engine.handle_postback(session, client, redis_client, campaign, conversation, postback_payload)
            else:
                await conversation_engine.handle_free_text_reply(session, conversation)
        except MetaAPIError as exc:
            logger.error("Error handling inbound message for conversation %s: %s", conversation.id, exc)

        await session.commit()


async def refresh_tokens_job(ctx) -> None:
    """FR-1.3: refresh long-lived tokens before expiry; alert on failure (FR-10.1 / A10)."""
    threshold = datetime.now(timezone.utc) + timedelta(days=TOKEN_REFRESH_THRESHOLD_DAYS)
    async with AsyncSessionLocal() as session:
        res = await session.execute(
            select(Account).where(Account.status == "active", Account.token_expires_at <= threshold)
        )
        for account in res.scalars().all():
            token = await _decrypt_or_flag(account)
            if token is None:
                continue
            client = MetaClient(token, str(account.id), label=account.ig_username)
            try:
                refreshed = await client.refresh_long_lived_token()
                account.access_token_encrypted = encrypt_token(refreshed["access_token"])
                account.token_expires_at = datetime.now(timezone.utc) + timedelta(
                    seconds=refreshed.get("expires_in", 60 * 24 * 3600)
                )
            except MetaAPIError as exc:
                logger.error("Token refresh failed for %s: %s", account.ig_username, exc)
                account.status = "expired"
                await notifications.alert_token_expiry(account.ig_username)
        await session.commit()


async def reconciliation_poll_job(ctx) -> None:
    """
    NFR-3 mitigation: periodically re-poll recent comments on targeted media,
    in case a webhook delivery was missed during downtime. Safe to run often --
    process_comment_event is idempotent on ig_comment_id.
    """
    async with AsyncSessionLocal() as session:
        res = await session.execute(select(Account).where(Account.status == "active"))
        accounts = res.scalars().all()

        for account in accounts:
            token = await _decrypt_or_flag(account)
            if token is None:
                continue
            campaigns = await _load_active_campaigns(session, account.id)
            client = MetaClient(token, str(account.id), label=account.ig_username)
            media_ids = {m.ig_media_id for c in campaigns for m in c.media_targets}

            for media_id in media_ids:
                try:
                    data = await client.get_media_comments(media_id)
                except MetaAPIError as exc:
                    logger.warning("Reconciliation poll failed for media %s: %s", media_id, exc)
                    continue

                for comment in data.get("data", []):
                    change_value = {
                        "id": comment["id"],
                        "text": comment.get("text", ""),
                        "media": {"id": media_id},
                        "from": comment.get("from", {"id": "", "username": comment.get("username")}),
                    }
                    await process_comment_event(ctx, change_value, account.ig_user_id)

        # Commits any account.status="expired" flags set by _decrypt_or_flag above
        # (process_comment_event manages its own separate session/commit for events).
        await session.commit()


async def sweep_abandoned_conversations_job(ctx) -> None:
    """
    A6: 'Flow times out after configurable period (default 7 days). Mark as
    abandoned. No further messages.' A conversation's `updated_at` moves
    every time it advances (opened -> awaiting_confirm -> gate_pending ->
    ...), so 'no activity for abandon_after_days' is exactly 'now minus
    updated_at exceeds the campaign's configured window'.
    """
    async with AsyncSessionLocal() as session:
        res = await session.execute(
            select(Conversation, Campaign.abandon_after_days)
            .join(Campaign, Campaign.id == Conversation.campaign_id)
            .where(Conversation.state.not_in(["completed", "declined", "abandoned", "failed"]))
        )
        now = datetime.now(timezone.utc)
        abandoned = 0
        for conversation, abandon_after_days in res.all():
            if now - conversation.updated_at >= timedelta(days=abandon_after_days):
                conversation.state = "abandoned"
                abandoned += 1

        if abandoned:
            await session.commit()
        if abandoned:
            logger.info("Abandon sweep: marked %d conversation(s) as abandoned", abandoned)


async def check_webhook_subscriptions_job(ctx) -> None:
    """
    FR-10.1 'webhook subscription loss' alert. Our `Account.webhook_subscribed`
    flag is only ever set at connect/disconnect time -- Meta can drop a
    subscription independently (app review changes, token issues, the
    business unlinking the Page from the app, etc.) without us hearing about
    it, so this periodically asks Meta directly whether it's still live.
    """
    async with AsyncSessionLocal() as session:
        res = await session.execute(select(Account).where(Account.status == "active"))
        accounts = res.scalars().all()

        for account in accounts:
            token = await _decrypt_or_flag(account)
            if token is None:
                continue
            target = account.page_id or account.ig_user_id
            client = MetaClient(token, str(account.id), label=account.ig_username)
            try:
                data = await client.get_subscribed_apps(target)
            except MetaAPIError as exc:
                logger.warning("Could not verify webhook subscription for %s: %s", account.ig_username, exc)
                continue

            subscribed_fields: set[str] = set()
            for entry in data.get("data", []):
                subscribed_fields.update(entry.get("subscribed_fields", []))
            still_subscribed = set(REQUIRED_WEBHOOK_FIELDS).issubset(subscribed_fields)

            if account.webhook_subscribed and not still_subscribed:
                await notifications.alert_webhook_subscription_lost(account.ig_username)
            account.webhook_subscribed = still_subscribed

        await session.commit()


async def check_delivery_health_job(ctx) -> None:
    """
    FR-10.1 'delivery failure rate above a configurable threshold' alert.
    Looks at each campaign's public-reply outcomes over a rolling window;
    campaigns with too few attempts to be meaningful are skipped, and an
    already-alerted campaign is not re-alerted until its cooldown expires
    (a sustained outage would otherwise fire this every run).
    """
    threshold_pct = settings.delivery_failure_alert_threshold_pct
    since = datetime.now(timezone.utc) - timedelta(hours=DELIVERY_HEALTH_WINDOW_HOURS)
    r = get_redis()

    async with AsyncSessionLocal() as session:
        res = await session.execute(
            select(
                CommentEvent.campaign_id,
                func.count(CommentEvent.id),
                func.sum(case((CommentEvent.public_reply_status == "failed", 1), else_=0)),
            )
            .where(
                CommentEvent.received_at >= since,
                CommentEvent.campaign_id.is_not(None),
                CommentEvent.public_reply_status.in_(["sent", "failed"]),
            )
            .group_by(CommentEvent.campaign_id)
        )

        for campaign_id, total, failed in res.all():
            failed = failed or 0
            if total < DELIVERY_HEALTH_MIN_SAMPLE:
                continue
            rate_pct = (failed / total) * 100
            if rate_pct < threshold_pct:
                continue

            alert_key = f"delivery_health_alerted:{campaign_id}"
            if not await r.set(alert_key, "1", ex=DELIVERY_HEALTH_ALERT_COOLDOWN_SECONDS, nx=True):
                continue  # already alerted recently for this campaign

            campaign = await session.get(Campaign, campaign_id)
            await notifications.alert_delivery_failure_rate(campaign.name if campaign else str(campaign_id), rate_pct)
