import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, Text, ForeignKey, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class MessageLog(Base):
    """FR-6.6 / FR-9.1: every inbound and outbound DM."""

    __tablename__ = "messages_log"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE")
    )

    direction: Mapped[str] = mapped_column(String, nullable=False)  # in | out
    step: Mapped[str | None] = mapped_column(String, nullable=True)  # opening | gate | reward | retry | decline
    body: Mapped[str] = mapped_column(Text, nullable=False)

    # queued | sent | delivered | failed
    delivery_status: Mapped[str] = mapped_column(String, default="queued")
    meta_error_code: Mapped[str | None] = mapped_column(String, nullable=True)
    meta_error_message: Mapped[str | None] = mapped_column(String, nullable=True)

    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
