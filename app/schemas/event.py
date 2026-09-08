import uuid
from datetime import datetime

from pydantic import BaseModel


class CommentEventOut(BaseModel):
    # uuid.UUID, not str -- see note in schemas/account.py::AccountOut.id
    id: uuid.UUID
    campaign_id: uuid.UUID | None
    ig_comment_id: str
    ig_media_id: str
    ig_user_id: str
    ig_username: str | None
    comment_text: str
    matched_keyword: str | None
    match_result: str
    public_reply_status: str
    public_reply_error: str | None
    received_at: datetime
    processed_at: datetime | None

    class Config:
        from_attributes = True


class MessageLogOut(BaseModel):
    id: uuid.UUID
    conversation_id: uuid.UUID
    direction: str
    step: str | None
    body: str
    delivery_status: str
    meta_error_code: str | None
    meta_error_message: str | None
    sent_at: datetime

    class Config:
        from_attributes = True
