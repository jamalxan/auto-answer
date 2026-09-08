"""
FR-1.4 / Section 7.1: Instagram webhook receiver.

NFR-3 / A11: validate signature, respond 200 immediately, enqueue for
async processing. Never do Meta API calls or DB writes with business
logic inline in this handler -- that belongs to the ARQ worker.
"""
import base64
import hashlib
import hmac
import json
import logging

from fastapi import APIRouter, Depends, Form, Header, HTTPException, Query, Request, status
from fastapi.responses import PlainTextResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.deps import get_db
from app.models.account import Account
from app.services.arq_pool import get_arq_pool

logger = logging.getLogger("webhooks")
settings = get_settings()

router = APIRouter(prefix="/webhooks", tags=["webhooks"])


@router.get("/instagram")
async def verify_webhook(
    hub_mode: str = Query(alias="hub.mode"),
    hub_verify_token: str = Query(alias="hub.verify_token"),
    hub_challenge: str = Query(alias="hub.challenge"),
):
    """
    Meta's one-time webhook verification handshake. Must echo hub.challenge
    back verbatim as a raw text/plain body (not JSON) -- returning it as a
    JSON int/string from FastAPI's default encoder is a common source of
    handshake failures.
    """
    if hub_mode != "subscribe" or hub_verify_token != settings.meta_webhook_verify_token:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Verification token mismatch")
    return PlainTextResponse(content=hub_challenge)


def _valid_signature(raw_body: bytes, signature_header: str | None) -> bool:
    if not signature_header or not signature_header.startswith("sha256="):
        return False
    expected = hmac.new(settings.meta_app_secret.encode(), raw_body, hashlib.sha256).hexdigest()
    provided = signature_header.split("=", 1)[1]
    return hmac.compare_digest(expected, provided)


@router.post("/instagram")
async def receive_webhook(request: Request, x_hub_signature_256: str | None = Header(default=None)):
    raw_body = await request.body()

    # A11: invalid signature -> 403 + security log entry.
    if not _valid_signature(raw_body, x_hub_signature_256):
        logger.warning("SECURITY: rejected webhook with invalid signature from %s", request.client)
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Invalid signature")

    payload = await request.json()
    pool = await get_arq_pool()

    for entry in payload.get("entry", []):
        # Comment events arrive via the "changes" array.
        for change in entry.get("changes", []):
            if change.get("field") == "comments":
                await pool.enqueue_job("process_comment_event", change.get("value", {}), entry.get("id"))

        # DM / postback events arrive via the "messaging" array (Instagram Messaging API shape).
        for messaging_event in entry.get("messaging", []):
            await pool.enqueue_job("process_message_event", messaging_event, entry.get("id"))

    # A5 in NFR-3: acknowledge immediately regardless of downstream processing outcome,
    # so Meta does not treat a slow worker as a delivery failure and retry-storm us.
    return {"status": "received"}


def _b64url_decode(segment: str) -> bytes:
    padding = "=" * (-len(segment) % 4)
    return base64.urlsafe_b64decode(segment + padding)


def parse_signed_request(signed_request: str, app_secret: str) -> dict:
    """
    Decode + verify Meta's `signed_request` format used by the Deauthorize
    Callback (App Dashboard > Instagram > API setup): `<sig>.<payload>`,
    both base64url, HMAC-SHA256(payload_segment, app_secret) == sig.
    Raises ValueError on any malformed or unverifiable input.
    """
    try:
        encoded_sig, encoded_payload = signed_request.split(".", 1)
    except ValueError as exc:
        raise ValueError("signed_request missing '.' separator") from exc

    expected_sig = hmac.new(app_secret.encode(), encoded_payload.encode(), hashlib.sha256).digest()
    try:
        provided_sig = _b64url_decode(encoded_sig)
    except Exception as exc:  # noqa: BLE001 - any decode failure is an invalid request
        raise ValueError("signed_request signature is not valid base64url") from exc

    if not hmac.compare_digest(expected_sig, provided_sig):
        raise ValueError("signed_request signature mismatch")

    try:
        return json.loads(_b64url_decode(encoded_payload))
    except Exception as exc:  # noqa: BLE001 - any decode failure is an invalid request
        raise ValueError("signed_request payload is not valid JSON") from exc


@router.post("/instagram/deauthorize")
async def deauthorize(signed_request: str = Form(...), db: AsyncSession = Depends(get_db)):
    """
    Meta calls this when a user removes IGDM's access from their Instagram
    settings (independent of our own /api/accounts/{id} disconnect flow).
    Mirrors the same "mark it, don't call Meta" shape as refresh_tokens_job's
    expiry handling in workers/tasks.py -- the token is already dead, so any
    Graph call here would just fail; the local account row is the only
    reachable resource left to correct.
    """
    try:
        payload = parse_signed_request(signed_request, settings.meta_app_secret)
    except ValueError as exc:
        logger.warning("SECURITY: rejected deauthorize callback: %s", exc)
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Invalid signed_request") from exc

    ig_user_id = payload.get("user_id")
    if ig_user_id:
        res = await db.execute(select(Account).where(Account.ig_user_id == str(ig_user_id)))
        account = res.scalar_one_or_none()
        if account is not None and account.status != "disconnected":
            account.status = "revoked"
            account.webhook_subscribed = False
            await db.commit()
            logger.info("Account %s marked revoked via deauthorize callback", account.ig_username)

    # Meta only requires a 200; no particular response body is read.
    return {"status": "received"}
