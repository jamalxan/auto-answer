"""
Import every model here so Base.metadata is fully populated
for Alembic autogenerate / create_all.
"""
from app.models.account import Account  # noqa: F401
from app.models.admin_user import AdminUser  # noqa: F401
from app.models.email_otp import EmailOTP  # noqa: F401
from app.models.campaign import Campaign, CampaignMedia, CampaignKeyword, MessageTemplate  # noqa: F401
from app.models.event import CommentEvent  # noqa: F401
from app.models.conversation import Conversation  # noqa: F401
from app.models.message import MessageLog  # noqa: F401
from app.models.lead import Lead  # noqa: F401
