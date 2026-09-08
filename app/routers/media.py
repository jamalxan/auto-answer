"""FR-2.3: media picker for campaign target selection."""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_current_admin, get_db
from app.models.account import Account
from app.schemas.account import MediaItemOut
from app.security import decrypt_token
from app.services.meta_client import MetaAPIError, MetaClient

router = APIRouter(prefix="/api/media", tags=["media"], dependencies=[Depends(get_current_admin)])


@router.get("", response_model=list[MediaItemOut])
async def list_account_media(account_id: str, db: AsyncSession = Depends(get_db)):
    account = await db.get(Account, account_id)
    if account is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Account not found")

    # Rate-limit bucket key is the DB account id (matches the worker's usage in
    # app/workers/tasks.py) so admin-panel calls and background processing for
    # the same account share one budget instead of two separate ones.
    try:
        token = decrypt_token(account.access_token_encrypted)
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Stored access token for @{account.ig_username} could not be decrypted; reconnect the account.",
        ) from exc

    client = MetaClient(token, str(account.id), label=account.ig_username)
    try:
        data = await client.list_media(account.ig_user_id)
    except MetaAPIError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Meta API error: {exc}") from exc

    return [
        MediaItemOut(
            ig_media_id=item["id"],
            caption=item.get("caption"),
            media_type=item.get("media_type"),
            permalink=item.get("permalink"),
            thumbnail_url=item.get("thumbnail_url"),
        )
        for item in data.get("data", [])
    ]
