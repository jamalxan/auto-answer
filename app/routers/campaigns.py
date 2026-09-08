"""FR-2 through FR-7: campaign CRUD, live preview, and test mode."""
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.deps import get_current_admin, get_db, get_redis
from app.models.campaign import Campaign, CampaignKeyword, CampaignMedia, MessageTemplate
from app.schemas.campaign import (
    CampaignCreate,
    CampaignOut,
    CampaignPreview,
    CampaignTestRequest,
    CampaignUpdate,
)
from app.services.keyword_matcher import match_comment
from app.services.template_renderer import apply_utm, build_context, render_template

router = APIRouter(prefix="/api/campaigns", tags=["campaigns"], dependencies=[Depends(get_current_admin)])


async def _load(db: AsyncSession, campaign_id: str) -> Campaign:
    res = await db.execute(
        select(Campaign)
        .options(selectinload(Campaign.keywords), selectinload(Campaign.templates), selectinload(Campaign.media_targets))
        .where(Campaign.id == campaign_id)
    )
    campaign = res.scalar_one_or_none()
    if campaign is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Campaign not found")
    return campaign


@router.get("", response_model=list[CampaignOut])
async def list_campaigns(account_id: str | None = None, db: AsyncSession = Depends(get_db)):
    stmt = select(Campaign).options(selectinload(Campaign.keywords), selectinload(Campaign.templates))
    if account_id:
        stmt = stmt.where(Campaign.account_id == account_id)
    stmt = stmt.order_by(Campaign.priority.asc(), Campaign.created_at.desc())
    res = await db.execute(stmt)
    return [CampaignOut.model_validate(c) for c in res.scalars().unique().all()]


@router.get("/{campaign_id}", response_model=CampaignOut)
async def get_campaign(campaign_id: str, db: AsyncSession = Depends(get_db)):
    return CampaignOut.model_validate(await _load(db, campaign_id))


@router.post("", response_model=CampaignOut, status_code=status.HTTP_201_CREATED)
async def create_campaign(payload: CampaignCreate, db: AsyncSession = Depends(get_db)):
    data = payload.model_dump(exclude={"keywords", "templates", "media_targets"})
    campaign = Campaign(**data)
    campaign.keywords = [CampaignKeyword(**k.model_dump()) for k in payload.keywords]
    campaign.templates = [MessageTemplate(**t.model_dump()) for t in payload.templates]
    campaign.media_targets = [CampaignMedia(**m.model_dump()) for m in payload.media_targets]
    db.add(campaign)
    await db.commit()
    return CampaignOut.model_validate(await _load(db, str(campaign.id)))


@router.patch("/{campaign_id}", response_model=CampaignOut)
async def update_campaign(campaign_id: str, payload: CampaignUpdate, db: AsyncSession = Depends(get_db)):
    campaign = await _load(db, campaign_id)
    data = payload.model_dump(exclude_unset=True, exclude={"keywords", "templates", "media_targets"})
    for key, value in data.items():
        setattr(campaign, key, value)

    if payload.keywords is not None:
        campaign.keywords = [CampaignKeyword(**k.model_dump()) for k in payload.keywords]
    if payload.templates is not None:
        campaign.templates = [MessageTemplate(**t.model_dump()) for t in payload.templates]
    if payload.media_targets is not None:
        campaign.media_targets = [CampaignMedia(**m.model_dump()) for m in payload.media_targets]

    await db.commit()
    return CampaignOut.model_validate(await _load(db, campaign_id))


@router.post("/{campaign_id}/duplicate", response_model=CampaignOut, status_code=status.HTTP_201_CREATED)
async def duplicate_campaign(campaign_id: str, db: AsyncSession = Depends(get_db)):
    original = await _load(db, campaign_id)
    clone = Campaign(
        account_id=original.account_id,
        name=f"{original.name} (copy)",
        status="draft",
        priority=original.priority,
        target_mode=original.target_mode,
        reply_enabled=original.reply_enabled,
        match_mode=original.match_mode,
        case_insensitive=original.case_insensitive,
        cyrillic_normalise=original.cyrillic_normalise,
        min_comment_length=original.min_comment_length,
        max_comment_length=original.max_comment_length,
        gate_strategy=original.gate_strategy,
        gate_config=dict(original.gate_config),
        reward_link=original.reward_link,
        utm_params=dict(original.utm_params),
        cooldown_hours=original.cooldown_hours,
        gate_max_retries=original.gate_max_retries,
        abandon_after_days=original.abandon_after_days,
        keywords=[CampaignKeyword(keyword=k.keyword, is_negative=k.is_negative) for k in original.keywords],
        templates=[
            MessageTemplate(step=t.step, body=t.body, quick_replies=t.quick_replies, sort_order=t.sort_order)
            for t in original.templates
        ],
        media_targets=[
            CampaignMedia(ig_media_id=m.ig_media_id, media_type=m.media_type, permalink=m.permalink, thumbnail_url=m.thumbnail_url)
            for m in original.media_targets
        ],
    )
    db.add(clone)
    await db.commit()
    return CampaignOut.model_validate(await _load(db, str(clone.id)))


@router.delete("/{campaign_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_campaign(campaign_id: str, db: AsyncSession = Depends(get_db)):
    campaign = await _load(db, campaign_id)
    await db.delete(campaign)
    await db.commit()


@router.get("/{campaign_id}/preview", response_model=list[CampaignPreview])
async def preview_campaign(campaign_id: str, db: AsyncSession = Depends(get_db)):
    """FR-8.1: chat-style preview of exactly what the end user will receive."""
    campaign = await _load(db, campaign_id)
    context = build_context(
        username="example_user",
        first_name="Aziz",
        link=apply_utm(campaign.reward_link, campaign.utm_params),
        keyword="tizim",
    )

    ordered_steps = ["public_reply", "opening", "gate", "reward", "retry", "decline"]
    by_step: dict[str, list[MessageTemplate]] = {}
    for t in campaign.templates:
        by_step.setdefault(t.step, []).append(t)

    preview = []
    for step in ordered_steps:
        for t in sorted(by_step.get(step, []), key=lambda x: x.sort_order):
            preview.append(CampaignPreview(step=step, body=render_template(t.body, context), quick_replies=t.quick_replies))
    return preview


@router.post("/{campaign_id}/test")
async def test_campaign(campaign_id: str, payload: CampaignTestRequest, db: AsyncSession = Depends(get_db)):
    """
    FR-8.2: test mode — runs keyword matching and shows what WOULD happen,
    without publishing a real public reply or sending a real DM.
    """
    campaign = await _load(db, campaign_id)
    result = match_comment(payload.comment_text, campaign)
    return {
        "matched": result.matched,
        "matched_keyword": result.keyword,
        "reason": result.reason,
        "would_send_public_reply": result.matched and campaign.reply_enabled,
        "would_open_dm_to": payload.ig_username or payload.ig_user_id if result.matched else None,
        "gate_strategy": campaign.gate_strategy,
        "note": "Test mode does not call the Meta API or notify the real user.",
    }
