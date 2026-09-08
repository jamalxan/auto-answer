import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, Boolean, Integer, ForeignKey, JSON, func, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Campaign(Base):
    """FR-2: a configured comment->DM funnel."""

    __tablename__ = "campaigns"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("accounts.id", ondelete="CASCADE"))

    name: Mapped[str] = mapped_column(String, nullable=False)

    # draft | active | paused | archived
    status: Mapped[str] = mapped_column(String, default="draft", nullable=False)
    # lower number = higher priority when multiple campaigns could match (FR-2.5)
    priority: Mapped[int] = mapped_column(Integer, default=100)

    # specific | all
    target_mode: Mapped[str] = mapped_column(String, default="specific")

    reply_enabled: Mapped[bool] = mapped_column(Boolean, default=True)  # FR-4.4 DM-only mode

    # exact | contains | word
    match_mode: Mapped[str] = mapped_column(String, default="word")
    case_insensitive: Mapped[bool] = mapped_column(Boolean, default=True)
    cyrillic_normalise: Mapped[bool] = mapped_column(Boolean, default=True)  # FR-3.4

    min_comment_length: Mapped[int] = mapped_column(Integer, default=1)
    max_comment_length: Mapped[int] = mapped_column(Integer, default=300)

    # none | self_confirm | external_db | engagement   (FR-5.1, Section 2.2 S1/S2/S5)
    gate_strategy: Mapped[str] = mapped_column(String, default="self_confirm")
    gate_config: Mapped[dict] = mapped_column(JSONB, default=dict)  # e.g. external_db url/auth/timeout

    reward_link: Mapped[str] = mapped_column(String, nullable=False, default="")
    utm_params: Mapped[dict] = mapped_column(JSONB, default=dict)  # FR-7.2

    cooldown_hours: Mapped[int] = mapped_column(Integer, default=24)  # A3
    gate_max_retries: Mapped[int] = mapped_column(Integer, default=3)  # FR-5.7
    abandon_after_days: Mapped[int] = mapped_column(Integer, default=7)  # A6

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    account: Mapped["Account"] = relationship(back_populates="campaigns")
    media_targets: Mapped[list["CampaignMedia"]] = relationship(cascade="all, delete-orphan")
    keywords: Mapped[list["CampaignKeyword"]] = relationship(cascade="all, delete-orphan")
    templates: Mapped[list["MessageTemplate"]] = relationship(cascade="all, delete-orphan")


class CampaignMedia(Base):
    """Which Reel(s)/post(s) a campaign targets (FR-2.2 / FR-2.3)."""

    __tablename__ = "campaign_media"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    campaign_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("campaigns.id", ondelete="CASCADE"))
    ig_media_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    media_type: Mapped[str | None] = mapped_column(String, nullable=True)
    permalink: Mapped[str | None] = mapped_column(String, nullable=True)
    thumbnail_url: Mapped[str | None] = mapped_column(String, nullable=True)

    __table_args__ = (UniqueConstraint("campaign_id", "ig_media_id", name="uq_campaign_media"),)


class CampaignKeyword(Base):
    """FR-3.1 / FR-3.6: trigger + negative keywords."""

    __tablename__ = "campaign_keywords"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    campaign_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("campaigns.id", ondelete="CASCADE"))
    keyword: Mapped[str] = mapped_column(String, nullable=False)
    is_negative: Mapped[bool] = mapped_column(Boolean, default=False)


class MessageTemplate(Base):
    """FR-6.2 / FR-4.3: message copy per funnel step, with variant rotation."""

    __tablename__ = "message_templates"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    campaign_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("campaigns.id", ondelete="CASCADE"))

    # public_reply | opening | gate | reward | retry | decline
    step: Mapped[str] = mapped_column(String, nullable=False)
    body: Mapped[str] = mapped_column(String, nullable=False)
    quick_replies: Mapped[list] = mapped_column(JSONB, default=list)  # [{"label":..,"payload":..}]
    sort_order: Mapped[int] = mapped_column(Integer, default=0)  # used to rotate variants within a step
