"""FastAPI application entrypoint: `uvicorn app.main:app`."""
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.routers import accounts, auth, campaigns, events, health, leads, media, webhooks

logging.basicConfig(level=logging.INFO)
settings = get_settings()

app = FastAPI(title="Instagram Comment-to-DM Automation — Backend", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(auth.router)
app.include_router(webhooks.router)
app.include_router(accounts.router)
app.include_router(media.router)
app.include_router(campaigns.router)
app.include_router(events.router)
app.include_router(leads.router)
