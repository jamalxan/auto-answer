import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, ForeignKey, Text, func, Index
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class CommentEvent(Base):
    """FR-9.1 / NFR-4: one row per processed Instagram comment, keyed for idempotency."""

    __tablename__ = "comment_events"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    campaign_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("campaigns.id", ondelete="SET NULL"), nullable=True
    )

    ig_comment_id: Mapped[str] = mapped_column(String, unique=True, index=True, nullable=False)
    ig_media_id: Mapped[str] = mapped_column(String, index=True, nullable=False)
    ig_user_id: Mapped[str] = mapped_column(String, index=True, nullable=False)
    ig_username: Mapped[str | None] = mapped_column(String, nullable=True)

    comment_text: Mapped[str] = mapped_column(Text, nullable=False)
    matched_keyword: Mapped[str | None] = mapped_column(String, nullable=True)

    # matched | no_match | self_comment | spam_guard | duplicate | cooldown
    match_result: Mapped[str] = mapped_column(String, nullable=False)

    # pending | sent | failed | disabled | skipped
    public_reply_status: Mapped[str] = mapped_column(String, default="pending")
    public_reply_error: Mapped[str | None] = mapped_column(String, nullable=True)

    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (Index("ix_comment_events_campaign_user", "campaign_id", "ig_user_id"),)
