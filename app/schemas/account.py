import uuid
from datetime import datetime

from pydantic import BaseModel


class AccountOut(BaseModel):
    # NOTE: must be uuid.UUID, not str -- pydantic v2 does not coerce a
    # uuid.UUID ORM attribute into a `str` field (raises "Input should be
    # a valid string" on every response). UUID serialises to a JSON string
    # automatically, so the API shape on the wire is unchanged.
    id: uuid.UUID
    ig_user_id: str
    ig_username: str
    status: str
    webhook_subscribed: bool
    token_expires_at: datetime | None
    connected_at: datetime

    class Config:
        from_attributes = True


class AccountConnectRequest(BaseModel):
    code: str  # OAuth authorization code returned by Meta after login


class MediaItemOut(BaseModel):
    ig_media_id: str
    caption: str | None = None
    media_type: str | None = None
    permalink: str | None = None
    thumbnail_url: str | None = None
