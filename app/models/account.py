import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, Boolean, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Account(Base):
    """A connected Instagram Business/Creator account (FR-1)."""

    __tablename__ = "accounts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    ig_user_id: Mapped[str] = mapped_column(String, unique=True, index=True, nullable=False)
    ig_username: Mapped[str] = mapped_column(String, nullable=False)

    access_token_encrypted: Mapped[str] = mapped_column(String, nullable=False)
    token_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    page_id: Mapped[str | None] = mapped_column(String, nullable=True)

    # active | expired | revoked | disconnected
    status: Mapped[str] = mapped_column(String, default="active", nullable=False)
    webhook_subscribed: Mapped[bool] = mapped_column(Boolean, default=False)

    connected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    campaigns: Mapped[list["Campaign"]] = relationship(back_populates="account", cascade="all, delete-orphan")
