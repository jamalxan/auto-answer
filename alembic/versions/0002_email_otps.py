"""email otps

Revision ID: 0002
Revises: 0001
Create Date: 2026-08-14
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql as pg

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "email_otps",
        sa.Column("id", pg.UUID(as_uuid=True), primary_key=True),
        sa.Column("email", sa.String, nullable=False),
        sa.Column("code_hash", sa.String, nullable=False),
        sa.Column("purpose", sa.String, nullable=False, server_default="register"),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_email_otps_email", "email_otps", ["email"])


def downgrade() -> None:
    op.drop_table("email_otps")
