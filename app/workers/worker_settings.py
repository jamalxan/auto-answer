"""ARQ worker process entrypoint: `arq app.workers.worker_settings.WorkerSettings`."""
import logging

from arq.connections import RedisSettings
from arq.cron import cron

from app.config import get_settings
from app.workers.tasks import (
    check_delivery_health_job,
    check_webhook_subscriptions_job,
    process_comment_event,
    process_message_event,
    reconciliation_poll_job,
    refresh_tokens_job,
    sweep_abandoned_conversations_job,
)

logging.basicConfig(level=logging.INFO)
settings = get_settings()


class WorkerSettings:
    redis_settings = RedisSettings.from_dsn(settings.redis_url)
    functions = [
        process_comment_event,
        process_message_event,
        refresh_tokens_job,
        reconciliation_poll_job,
        sweep_abandoned_conversations_job,
        check_webhook_subscriptions_job,
        check_delivery_health_job,
    ]
    cron_jobs = [
        cron(refresh_tokens_job, hour=set(range(24)), minute=0, run_at_startup=False),
        cron(reconciliation_poll_job, minute=set(range(0, 60, 15)), run_at_startup=False),
        # A6: sweep for timed-out conversations a few times a day is plenty --
        # the default window is measured in days, not minutes.
        cron(sweep_abandoned_conversations_job, hour={2, 8, 14, 20}, minute=30, run_at_startup=False),
        # FR-10.1 health checks: hourly is enough to catch sustained issues
        # without adding meaningful Graph API call volume.
        cron(check_webhook_subscriptions_job, minute=0, run_at_startup=False),
        cron(check_delivery_health_job, minute=set(range(0, 60, 30)), run_at_startup=False),
    ]
    max_jobs = 20
    job_timeout = 60
