"""
Central application configuration.
All values are read from environment variables (see .env.example).
"""
from functools import lru_cache
from typing import List

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # App
    app_env: str = "development"
    app_secret_key: str = "dev-secret-change-me"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 1440

    token_encryption_key: str = ""

    # Database
    database_url: str = "postgresql+asyncpg://igdm:igdm@localhost:5432/igdm"

    # Redis
    redis_url: str = "redis://localhost:6379/0"

    # Meta
    meta_app_id: str = ""
    meta_app_secret: str = ""
    meta_webhook_verify_token: str = "change-me"
    meta_graph_api_version: str = "v21.0"
    meta_oauth_redirect_uri: str = ""

    meta_rate_limit_per_account_per_hour: int = 180

    # Notifications
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    alert_email_to: str = ""
    telegram_bot_token: str = ""
    telegram_alert_chat_id: str = ""
    # FR-10.1: alert when a campaign's public-reply failure rate crosses this,
    # measured over the last hour with a minimum sample size (see workers/tasks.py).
    delivery_failure_alert_threshold_pct: float = 20.0

    # Defaults (overridable per-campaign)
    default_cooldown_hours: int = 24
    default_gate_max_retries: int = 3
    default_abandon_after_days: int = 7
    log_retention_months: int = 12

    cors_origins: str = "http://localhost:3000"

    @property
    def cors_origin_list(self) -> List[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def graph_api_base(self) -> str:
        # Instagram API with Instagram Login (direct, no Facebook Login) serves
        # every authenticated Graph call from graph.instagram.com -- NOT
        # graph.facebook.com, which is the separate Facebook Login/Pages flow.
        return f"https://graph.instagram.com/{self.meta_graph_api_version}"


@lru_cache
def get_settings() -> Settings:
    return Settings()
