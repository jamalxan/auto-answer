import uuid
from datetime import datetime

from pydantic import BaseModel


class LeadOut(BaseModel):
    # uuid.UUID, not str -- see note in schemas/account.py::AccountOut.id
    id: uuid.UUID
    campaign_id: uuid.UUID
    ig_user_id: str
    ig_username: str | None
    first_triggered_at: datetime
    completed_at: datetime | None
    gate_result: str
    link_delivered: bool
    link_clicked_at: datetime | None

    class Config:
        from_attributes = True
