import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, Boolean, ForeignKey, func, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Lead(Base):
    """FR-9.4: one row per user who engaged a campaign's funnel, for export."""

    __tablename__ = "leads"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    campaign_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("campaigns.id", ondelete="CASCADE"))
    ig_user_id: Mapped[str] = mapped_column(String, index=True, nullable=False)
    ig_username: Mapped[str | None] = mapped_column(String, nullable=True)

    first_triggered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # pass | fail | pending | not_applicable
    gate_result: Mapped[str] = mapped_column(String, default="pending")
    link_delivered: Mapped[bool] = mapped_column(Boolean, default=False)
    link_clicked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (UniqueConstraint("campaign_id", "ig_user_id", name="uq_lead_campaign_user"),)
