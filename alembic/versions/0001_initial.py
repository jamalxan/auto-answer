"""initial schema

Revision ID: 0001
Revises:
Create Date: 2026-08-07
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql as pg

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "admin_users",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("email", sa.String, nullable=False, unique=True),
        sa.Column("password_hash", sa.String, nullable=False),
        sa.Column("role", sa.String, nullable=False, server_default="admin"),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table(
        "accounts",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("ig_user_id", sa.String, nullable=False, unique=True),
        sa.Column("ig_username", sa.String, nullable=False),
        sa.Column("access_token_encrypted", sa.String, nullable=False),
        sa.Column("token_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("page_id", sa.String, nullable=True),
        sa.Column("status", sa.String, nullable=False, server_default="active"),
        sa.Column("webhook_subscribed", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("connected_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_accounts_ig_user_id", "accounts", ["ig_user_id"])

    op.create_table(
        "campaigns",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("account_id", pg.UUID(as_uuid=True), sa.ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String, nullable=False),
        sa.Column("status", sa.String, nullable=False, server_default="draft"),
        sa.Column("priority", sa.Integer, nullable=False, server_default="100"),
        sa.Column("target_mode", sa.String, nullable=False, server_default="specific"),
        sa.Column("reply_enabled", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("match_mode", sa.String, nullable=False, server_default="word"),
        sa.Column("case_insensitive", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("cyrillic_normalise", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("min_comment_length", sa.Integer, nullable=False, server_default="1"),
        sa.Column("max_comment_length", sa.Integer, nullable=False, server_default="300"),
        sa.Column("gate_strategy", sa.String, nullable=False, server_default="self_confirm"),
        sa.Column("gate_config", pg.JSONB, nullable=False, server_default="{}"),
        sa.Column("reward_link", sa.String, nullable=False, server_default=""),
        sa.Column("utm_params", pg.JSONB, nullable=False, server_default="{}"),
        sa.Column("cooldown_hours", sa.Integer, nullable=False, server_default="24"),
        sa.Column("gate_max_retries", sa.Integer, nullable=False, server_default="3"),
        sa.Column("abandon_after_days", sa.Integer, nullable=False, server_default="7"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table(
        "campaign_media",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("campaign_id", pg.UUID(as_uuid=True), sa.ForeignKey("campaigns.id", ondelete="CASCADE"), nullable=False),
        sa.Column("ig_media_id", sa.String, nullable=False),
        sa.Column("media_type", sa.String, nullable=True),
        sa.Column("permalink", sa.String, nullable=True),
        sa.Column("thumbnail_url", sa.String, nullable=True),
        sa.UniqueConstraint("campaign_id", "ig_media_id", name="uq_campaign_media"),
    )
    op.create_index("ix_campaign_media_ig_media_id", "campaign_media", ["ig_media_id"])

    op.create_table(
        "campaign_keywords",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("campaign_id", pg.UUID(as_uuid=True), sa.ForeignKey("campaigns.id", ondelete="CASCADE"), nullable=False),
        sa.Column("keyword", sa.String, nullable=False),
        sa.Column("is_negative", sa.Boolean, nullable=False, server_default=sa.false()),
    )

    op.create_table(
        "message_templates",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("campaign_id", pg.UUID(as_uuid=True), sa.ForeignKey("campaigns.id", ondelete="CASCADE"), nullable=False),
        sa.Column("step", sa.String, nullable=False),
        sa.Column("body", sa.String, nullable=False),
        sa.Column("quick_replies", pg.JSONB, nullable=False, server_default="[]"),
        sa.Column("sort_order", sa.Integer, nullable=False, server_default="0"),
    )

    op.create_table(
        "comment_events",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("campaign_id", pg.UUID(as_uuid=True), sa.ForeignKey("campaigns.id", ondelete="SET NULL"), nullable=True),
        sa.Column("ig_comment_id", sa.String, nullable=False, unique=True),
        sa.Column("ig_media_id", sa.String, nullable=False),
        sa.Column("ig_user_id", sa.String, nullable=False),
        sa.Column("ig_username", sa.String, nullable=True),
        sa.Column("comment_text", sa.Text, nullable=False),
        sa.Column("matched_keyword", sa.String, nullable=True),
        sa.Column("match_result", sa.String, nullable=False),
        sa.Column("public_reply_status", sa.String, nullable=False, server_default="pending"),
        sa.Column("public_reply_error", sa.String, nullable=True),
        sa.Column("received_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_comment_events_ig_comment_id", "comment_events", ["ig_comment_id"])
    op.create_index("ix_comment_events_ig_media_id", "comment_events", ["ig_media_id"])
    op.create_index("ix_comment_events_ig_user_id", "comment_events", ["ig_user_id"])
    op.create_index("ix_comment_events_campaign_user", "comment_events", ["campaign_id", "ig_user_id"])

    op.create_table(
        "conversations",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("campaign_id", pg.UUID(as_uuid=True), sa.ForeignKey("campaigns.id", ondelete="CASCADE"), nullable=False),
        sa.Column("ig_user_id", sa.String, nullable=False),
        sa.Column("ig_username", sa.String, nullable=True),
        sa.Column("state", sa.String, nullable=False, server_default="opened"),
        sa.Column("gate_retry_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("triggering_comment_id", sa.String, nullable=True),
        sa.Column("matched_keyword", sa.String, nullable=True),
        sa.Column("last_user_message_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("window_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("campaign_id", "ig_user_id", name="uq_conversation_campaign_user"),
    )
    op.create_index("ix_conversations_ig_user_id", "conversations", ["ig_user_id"])

    op.create_table(
        "messages_log",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("conversation_id", pg.UUID(as_uuid=True), sa.ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("direction", sa.String, nullable=False),
        sa.Column("step", sa.String, nullable=True),
        sa.Column("body", sa.Text, nullable=False),
        sa.Column("delivery_status", sa.String, nullable=False, server_default="queued"),
        sa.Column("meta_error_code", sa.String, nullable=True),
        sa.Column("meta_error_message", sa.String, nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table(
        "leads",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("campaign_id", pg.UUID(as_uuid=True), sa.ForeignKey("campaigns.id", ondelete="CASCADE"), nullable=False),
        sa.Column("ig_user_id", sa.String, nullable=False),
        sa.Column("ig_username", sa.String, nullable=True),
        sa.Column("first_triggered_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("gate_result", sa.String, nullable=False, server_default="pending"),
        sa.Column("link_delivered", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("link_clicked_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("campaign_id", "ig_user_id", name="uq_lead_campaign_user"),
    )
    op.create_index("ix_leads_ig_user_id", "leads", ["ig_user_id"])


def downgrade() -> None:
    op.drop_table("leads")
    op.drop_table("messages_log")
    op.drop_table("conversations")
    op.drop_table("comment_events")
    op.drop_table("message_templates")
    op.drop_table("campaign_keywords")
    op.drop_table("campaign_media")
    op.drop_table("campaigns")
    op.drop_table("accounts")
    op.drop_table("admin_users")
