"""FR-9.4: leads table + CSV export."""
import csv
import io

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_current_admin, get_db
from app.models.lead import Lead
from app.schemas.lead import LeadOut

router = APIRouter(prefix="/api/leads", tags=["leads"], dependencies=[Depends(get_current_admin)])


async def _query_leads(db: AsyncSession, campaign_id: str | None):
    stmt = select(Lead)
    if campaign_id:
        stmt = stmt.where(Lead.campaign_id == campaign_id)
    stmt = stmt.order_by(Lead.first_triggered_at.desc())
    res = await db.execute(stmt)
    return res.scalars().all()


@router.get("", response_model=list[LeadOut])
async def list_leads(campaign_id: str | None = None, db: AsyncSession = Depends(get_db)):
    return [LeadOut.model_validate(l) for l in await _query_leads(db, campaign_id)]


@router.get("/export")
async def export_leads(campaign_id: str | None = None, db: AsyncSession = Depends(get_db)):
    leads = await _query_leads(db, campaign_id)

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        ["ig_username", "ig_user_id", "campaign_id", "first_triggered_at", "completed_at", "gate_result", "link_delivered", "link_clicked_at"]
    )
    for lead in leads:
        writer.writerow(
            [
                lead.ig_username or "",
                lead.ig_user_id,
                str(lead.campaign_id),
                lead.first_triggered_at.isoformat() if lead.first_triggered_at else "",
                lead.completed_at.isoformat() if lead.completed_at else "",
                lead.gate_result,
                lead.link_delivered,
                lead.link_clicked_at.isoformat() if lead.link_clicked_at else "",
            ]
        )
    buffer.seek(0)
    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=leads_export.csv"},
    )
