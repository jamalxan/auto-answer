"""FR-9: filterable, searchable event log."""
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_current_admin, get_db
from app.models.event import CommentEvent
from app.schemas.event import CommentEventOut

router = APIRouter(prefix="/api/events", tags=["events"], dependencies=[Depends(get_current_admin)])


@router.get("", response_model=list[CommentEventOut])
async def list_events(
    campaign_id: str | None = None,
    status_filter: str | None = Query(default=None, alias="status"),
    username: str | None = None,
    search: str | None = Query(default=None, description="Full-text search on comment text"),
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    limit: int = Query(default=100, le=500),
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
):
    stmt = select(CommentEvent)
    if campaign_id:
        stmt = stmt.where(CommentEvent.campaign_id == campaign_id)
    if status_filter:
        stmt = stmt.where(CommentEvent.match_result == status_filter)
    if username:
        stmt = stmt.where(CommentEvent.ig_username == username)
    if search:
        stmt = stmt.where(CommentEvent.comment_text.ilike(f"%{search}%"))
    if date_from:
        stmt = stmt.where(CommentEvent.received_at >= date_from)
    if date_to:
        stmt = stmt.where(CommentEvent.received_at <= date_to)

    stmt = stmt.order_by(CommentEvent.received_at.desc()).limit(limit).offset(offset)
    res = await db.execute(stmt)
    return [CommentEventOut.model_validate(e) for e in res.scalars().all()]
