"""FR-1: Meta account connection / disconnection."""
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.deps import get_current_admin, get_db
from app.models.account import Account
from app.schemas.account import AccountConnectRequest, AccountOut
from app.security import encrypt_token, decrypt_token
from app.services.meta_client import REQUIRED_WEBHOOK_FIELDS, MetaAPIError, MetaClient

logger = logging.getLogger("accounts")
router = APIRouter(prefix="/api/accounts", tags=["accounts"], dependencies=[Depends(get_current_admin)])


@router.get("", response_model=list[AccountOut])
async def list_accounts(db: AsyncSession = Depends(get_db)):
    res = await db.execute(select(Account).order_by(Account.connected_at.desc()))
    return [AccountOut.model_validate(a) for a in res.scalars().all()]


@router.post("/connect", response_model=AccountOut)
async def connect_account(payload: AccountConnectRequest, db: AsyncSession = Depends(get_db)):
    """
    OAuth callback handler (FR-1.1 - FR-1.4). The panel's frontend redirects
    the admin through Meta's login flow and lands here with `code`.
    """
    bootstrap_client = MetaClient(access_token="", account_id_for_ratelimit="oauth")
    try:
        short_lived = await bootstrap_client.exchange_code_for_short_lived_token(payload.code)
        long_lived = await bootstrap_client.exchange_for_long_lived_token(short_lived["access_token"])
    except MetaAPIError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Meta OAuth exchange failed: {exc}") from exc

    access_token = long_lived["access_token"]
    expires_in = long_lived.get("expires_in", 60 * 24 * 3600)

    info_client = MetaClient(access_token=access_token, account_id_for_ratelimit="oauth")
    try:
        info = await info_client.get_account_info()
    except MetaAPIError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Could not fetch account info: {exc}") from exc

    res = await db.execute(select(Account).where(Account.ig_user_id == info["id"]))
    account = res.scalar_one_or_none()
    if account is None:
        account = Account(ig_user_id=info["id"], ig_username=info.get("username", ""), access_token_encrypted="")
        db.add(account)

    account.ig_username = info.get("username", account.ig_username)
    account.access_token_encrypted = encrypt_token(access_token)
    account.token_expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in)
    account.status = "active"
    await db.flush()

    try:
        await info_client.subscribe_webhooks(account.ig_user_id, REQUIRED_WEBHOOK_FIELDS)  # FR-1.4
        account.webhook_subscribed = True
    except MetaAPIError as exc:
        logger.error("Webhook subscription failed for %s: %s", account.ig_username, exc)
        account.webhook_subscribed = False

    await db.commit()
    await db.refresh(account)
    return AccountOut.model_validate(account)


@router.delete("/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
async def disconnect_account(account_id: str, db: AsyncSession = Depends(get_db)):
    """FR-1.5: disconnect deactivates all campaigns and removes webhook subscriptions."""
    # `account.campaigns` is accessed below, and AsyncSession does not support
    # implicit lazy-loading (it raises MissingGreenlet) -- the relationship
    # must be eagerly loaded up front via selectinload.
    res = await db.execute(select(Account).options(selectinload(Account.campaigns)).where(Account.id == account_id))
    account = res.scalar_one_or_none()
    if account is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Account not found")

    for campaign in account.campaigns:
        campaign.status = "archived"

    # Unsubscribing requires the account's own (real) access token -- calling
    # this with an empty token would always fail Meta's auth check, silently
    # leaving the subscription live server-side while the local admin panel
    # believes it's gone. A corrupted/undecryptable stored token shouldn't
    # block the local disconnect, so this is best-effort.
    try:
        token = decrypt_token(account.access_token_encrypted)
    except ValueError:
        token = None
        logger.warning("Stored token for %s is unreadable; skipping remote webhook unsubscribe", account.ig_username)

    if token:
        try:
            client = MetaClient(token, account_id_for_ratelimit=str(account.id), label=account.ig_username)
            await client.unsubscribe_webhooks(account.page_id or account.ig_user_id)
        except MetaAPIError as exc:
            logger.warning("Could not unsubscribe webhooks for %s on disconnect: %s", account.ig_username, exc)

    account.status = "disconnected"
    account.webhook_subscribed = False
    await db.commit()
