"""
FR-10: admin alerts. Email via SMTP + optional Telegram bot.
Both are best-effort — a failed alert must never crash the worker.
"""
import logging
import smtplib
from email.mime.text import MIMEText

import httpx

from app.config import get_settings

logger = logging.getLogger("notifications")
settings = get_settings()


async def _send_telegram(text: str) -> None:
    if not (settings.telegram_bot_token and settings.telegram_alert_chat_id):
        return
    url = f"https://api.telegram.org/bot{settings.telegram_bot_token}/sendMessage"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(url, json={"chat_id": settings.telegram_alert_chat_id, "text": text})
    except httpx.HTTPError as exc:
        logger.error("Telegram alert failed: %s", exc)


def _send_email(subject: str, body: str) -> None:
    if not (settings.smtp_host and settings.alert_email_to):
        return
    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = settings.smtp_user or "noreply@localhost"
    msg["To"] = settings.alert_email_to
    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as server:
            server.starttls()
            if settings.smtp_user:
                server.login(settings.smtp_user, settings.smtp_password)
            server.send_message(msg)
    except Exception as exc:  # noqa: BLE001 - alerting must never raise
        logger.error("Email alert failed: %s", exc)


def send_otp_email(to_email: str, code: str) -> None:
    """Registration OTP delivery. Unlike admin alerts, this must surface
    failures to the caller -- a silently undelivered code just looks like a
    hang to the person registering."""
    if not settings.smtp_host:
        raise RuntimeError("SMTP sozlanmagan (SMTP_HOST bo'sh). .env faylida SMTP_* qiymatlarini kiriting.")
    msg = MIMEText(f"Tasdiqlash kodingiz: {code}\n\nKod 10 daqiqa amal qiladi.")
    msg["Subject"] = "IGDM — tasdiqlash kodi"
    msg["From"] = settings.smtp_user or "noreply@localhost"
    msg["To"] = to_email
    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as server:
        server.starttls()
        if settings.smtp_user:
            server.login(settings.smtp_user, settings.smtp_password)
        server.send_message(msg)


async def alert(subject: str, body: str) -> None:
    logger.warning("ADMIN ALERT: %s - %s", subject, body)
    _send_email(subject, body)
    await _send_telegram(f"{subject}\n{body}")


async def alert_token_expiry(account_username: str) -> None:
    await alert("Instagram token expiring/revoked", f"Account @{account_username} needs to be reconnected.")


async def alert_sustained_rate_limit(account_username: str) -> None:
    await alert("Sustained Meta API rate limiting", f"Account @{account_username} is being throttled by Meta.")


async def alert_webhook_subscription_lost(account_username: str) -> None:
    await alert("Webhook subscription lost", f"Account @{account_username} is no longer receiving webhooks.")


async def alert_delivery_failure_rate(campaign_name: str, rate_pct: float) -> None:
    await alert("High delivery failure rate", f"Campaign '{campaign_name}' failure rate is {rate_pct:.1f}%.")
