import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, Integer, ForeignKey, func, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Conversation(Base):
    """FR-6 state machine: tracks one user's progress through one campaign's funnel."""

    __tablename__ = "conversations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    campaign_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("campaigns.id", ondelete="CASCADE"))
    ig_user_id: Mapped[str] = mapped_column(String, index=True, nullable=False)
    ig_username: Mapped[str | None] = mapped_column(String, nullable=True)

    # opened | awaiting_confirm | gate_pending | completed | declined | abandoned | failed
    state: Mapped[str] = mapped_column(String, default="opened", nullable=False)
    gate_retry_count: Mapped[int] = mapped_column(Integer, default=0)

    triggering_comment_id: Mapped[str | None] = mapped_column(String, nullable=True)
    matched_keyword: Mapped[str | None] = mapped_column(String, nullable=True)

    last_user_message_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # end of the current Meta messaging window we believe we're inside (24h std / 7d human-agent)
    window_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (UniqueConstraint("campaign_id", "ig_user_id", name="uq_conversation_campaign_user"),)
