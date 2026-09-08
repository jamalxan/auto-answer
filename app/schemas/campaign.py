import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class KeywordIn(BaseModel):
    keyword: str
    is_negative: bool = False

    # from_attributes=True so this same schema can also read straight off the
    # ORM CampaignKeyword object when nested inside CampaignOut -- pydantic v2
    # does NOT propagate the parent model's from_attributes setting down into
    # list-item submodels, each one needs its own.
    class Config:
        from_attributes = True


class TemplateIn(BaseModel):
    step: Literal["public_reply", "opening", "gate", "reward", "retry", "decline"]
    body: str
    quick_replies: list[dict] = Field(default_factory=list)
    sort_order: int = 0

    class Config:
        from_attributes = True


class MediaTargetIn(BaseModel):
    ig_media_id: str
    media_type: str | None = None
    permalink: str | None = None
    thumbnail_url: str | None = None


class CampaignCreate(BaseModel):
    account_id: str
    name: str
    status: Literal["draft", "active", "paused", "archived"] = "draft"
    priority: int = 100
    target_mode: Literal["specific", "all"] = "specific"
    reply_enabled: bool = True
    match_mode: Literal["exact", "contains", "word"] = "word"
    case_insensitive: bool = True
    cyrillic_normalise: bool = True
    min_comment_length: int = 1
    max_comment_length: int = 300
    gate_strategy: Literal["none", "self_confirm", "external_db", "engagement"] = "self_confirm"
    gate_config: dict = Field(default_factory=dict)
    reward_link: str = ""
    utm_params: dict = Field(default_factory=dict)
    cooldown_hours: int = 24
    gate_max_retries: int = 3
    abandon_after_days: int = 7

    keywords: list[KeywordIn] = Field(default_factory=list)
    templates: list[TemplateIn] = Field(default_factory=list)
    media_targets: list[MediaTargetIn] = Field(default_factory=list)


class CampaignUpdate(BaseModel):
    name: str | None = None
    status: Literal["draft", "active", "paused", "archived"] | None = None
    priority: int | None = None
    target_mode: Literal["specific", "all"] | None = None
    reply_enabled: bool | None = None
    match_mode: Literal["exact", "contains", "word"] | None = None
    case_insensitive: bool | None = None
    cyrillic_normalise: bool | None = None
    min_comment_length: int | None = None
    max_comment_length: int | None = None
    gate_strategy: Literal["none", "self_confirm", "external_db", "engagement"] | None = None
    gate_config: dict | None = None
    reward_link: str | None = None
    utm_params: dict | None = None
    cooldown_hours: int | None = None
    gate_max_retries: int | None = None
    abandon_after_days: int | None = None

    keywords: list[KeywordIn] | None = None
    templates: list[TemplateIn] | None = None
    media_targets: list[MediaTargetIn] | None = None


class CampaignOut(BaseModel):
    # uuid.UUID, not str -- see note in schemas/account.py::AccountOut.id
    id: uuid.UUID
    account_id: uuid.UUID
    name: str
    status: str
    priority: int
    target_mode: str
    reply_enabled: bool
    match_mode: str
    case_insensitive: bool
    cyrillic_normalise: bool
    gate_strategy: str
    gate_config: dict
    reward_link: str
    cooldown_hours: int
    gate_max_retries: int
    abandon_after_days: int
    created_at: datetime
    updated_at: datetime
    keywords: list[KeywordIn] = Field(default_factory=list)
    templates: list[TemplateIn] = Field(default_factory=list)

    class Config:
        from_attributes = True


class CampaignPreview(BaseModel):
    step: str
    body: str
    quick_replies: list[dict]


class CampaignTestRequest(BaseModel):
    ig_user_id: str
    ig_username: str | None = None
    comment_text: str
