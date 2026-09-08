"""
Isolated Meta Graph API client (Section 10 risk: "Meta changes API/permission
names or windows" -> mitigation is "isolate all Meta calls behind a single
client module", which is exactly this file).

IMPORTANT — re-verify before go-live (per TZ section 7.3 / 2.3):
  * Exact endpoint paths for private replies to comments and DM sends
    change between Graph API versions; the ones below reflect the
    Instagram Messaging API shape as of the last verified docs pass.
  * Exact permission/scope names (`instagram_business_basic`,
    `instagram_business_manage_comments`, `instagram_business_manage_messages`,
    or their successors) must be confirmed in the Meta App Dashboard at
    build time — Meta has renamed these before.
  * Webhook field names (`comments`, `messages`, `messaging_postbacks`)
    and window durations (24h standard / 7d human-agent tag) must be
    re-checked against current docs.
"""
import logging
from typing import Any, Optional

import httpx
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_random_exponential

from app.config import get_settings
from app.services import notifications
from app.services.rate_limiter import RateLimitExceeded, check_and_increment, note_meta_throttle

logger = logging.getLogger("meta_client")
settings = get_settings()

# Meta error codes that indicate throttling (A9) — not exhaustive, verify against current docs.
RATE_LIMIT_ERROR_CODES = {4, 17, 32, 613}

# FR-1.4 / Section 7.3: webhook fields this app subscribes accounts to.
# Single source of truth -- also used by the FR-10.1 "webhook subscription
# lost" health check to know what SHOULD be subscribed.
REQUIRED_WEBHOOK_FIELDS = ["comments", "messages", "messaging_postbacks"]


class MetaAPIError(Exception):
    def __init__(self, message: str, code: Optional[int] = None, subcode: Optional[int] = None):
        super().__init__(message)
        self.code = code
        self.subcode = subcode

    @property
    def is_rate_limit(self) -> bool:
        return self.code in RATE_LIMIT_ERROR_CODES


class MetaRetryableError(Exception):
    """Raised to trigger tenacity backoff (rate limit or transient network error)."""


class MetaClient:
    def __init__(self, access_token: str, account_id_for_ratelimit: str, label: Optional[str] = None):
        self._token = access_token
        self._account_id = account_id_for_ratelimit
        # Human-readable identifier (e.g. the IG @username) used only in admin
        # alert text -- falls back to the rate-limit bucket key if not given.
        self._label = label or account_id_for_ratelimit
        self._base = settings.graph_api_base

    async def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=15.0)

    @retry(
        retry=retry_if_exception_type(MetaRetryableError),
        wait=wait_random_exponential(multiplier=1, max=60),
        stop=stop_after_attempt(5),
        reraise=True,
    )
    async def _call(self, method: str, path: str, **kwargs) -> dict:
        try:
            await check_and_increment(self._account_id)
        except RateLimitExceeded as exc:
            logger.warning("Local rate limit hit for account %s: %s", self._account_id, exc)
            raise MetaRetryableError(str(exc)) from exc

        # A handful of Instagram Login endpoints (long-lived token exchange,
        # refresh) live at the host root with no API-version segment -- pass
        # an absolute URL through untouched instead of joining it to `_base`.
        url = path if path.startswith("http") else f"{self._base}/{path.lstrip('/')}"
        params = kwargs.pop("params", {}) or {}
        params.setdefault("access_token", self._token)

        async with await self._client() as client:
            try:
                resp = await client.request(method, url, params=params, **kwargs)
            except httpx.TransportError as exc:
                raise MetaRetryableError(f"Transport error calling {path}: {exc}") from exc

        if resp.status_code == 429:
            raise MetaRetryableError(f"HTTP 429 from Graph API on {path}")

        # A non-JSON body (HTML error page from an edge proxy/WAF, an empty
        # body, a transient gateway response) must not surface as a raw,
        # unhandled JSONDecodeError -- every caller in this codebase only
        # catches MetaAPIError. 5xx gets treated as transient/retryable;
        # anything else is a hard failure with the raw body for debugging.
        try:
            data = resp.json() if resp.content else {}
        except ValueError as exc:
            snippet = resp.text[:200] if resp.text else "<empty body>"
            if resp.status_code >= 500:
                raise MetaRetryableError(
                    f"Non-JSON response from Graph API on {path} (HTTP {resp.status_code}): {snippet}"
                ) from exc
            raise MetaAPIError(
                f"Non-JSON response from Graph API on {path} (HTTP {resp.status_code}): {snippet}",
                code=None,
            ) from exc

        if resp.status_code >= 400 or "error" in data:
            err = data.get("error", {})
            code = err.get("code")
            api_error = MetaAPIError(
                err.get("message", f"HTTP {resp.status_code}"), code=code, subcode=err.get("error_subcode")
            )
            if api_error.is_rate_limit:
                # A9 / FR-10.1: track Meta-side throttling and alert once it
                # looks sustained rather than a single transient hit.
                if await note_meta_throttle(self._account_id):
                    await notifications.alert_sustained_rate_limit(self._label)
                raise MetaRetryableError(str(api_error)) from api_error
            raise api_error

        return data

    # ---- OAuth / token lifecycle (FR-1) ----

    async def exchange_code_for_short_lived_token(self, code: str) -> dict:
        # Unlike every other call in this client, the initial code exchange is
        # NOT a graph.instagram.com call -- Instagram Login serves it from
        # api.instagram.com as a POST with a form-encoded body, and requires
        # grant_type=authorization_code explicitly.
        async with await self._client() as client:
            try:
                resp = await client.post(
                    "https://api.instagram.com/oauth/access_token",
                    data={
                        "client_id": settings.meta_app_id,
                        "client_secret": settings.meta_app_secret,
                        "grant_type": "authorization_code",
                        "redirect_uri": settings.meta_oauth_redirect_uri,
                        "code": code,
                    },
                )
            except httpx.TransportError as exc:
                raise MetaAPIError(f"Transport error exchanging code: {exc}") from exc

        try:
            data = resp.json() if resp.content else {}
        except ValueError as exc:
            raise MetaAPIError(
                f"Non-JSON response from code exchange (HTTP {resp.status_code}): {resp.text[:200]}"
            ) from exc

        if resp.status_code >= 400 or "error_message" in data:
            raise MetaAPIError(data.get("error_message", f"HTTP {resp.status_code}"))
        return data

    async def exchange_for_long_lived_token(self, short_lived_token: str) -> dict:
        return await self._call(
            "GET",
            "https://graph.instagram.com/access_token",
            params={
                "grant_type": "ig_exchange_token",
                "client_secret": settings.meta_app_secret,
                "access_token": short_lived_token,
            },
        )

    async def refresh_long_lived_token(self) -> dict:
        return await self._call(
            "GET", "https://graph.instagram.com/refresh_access_token", params={"grant_type": "ig_refresh_token"}
        )

    async def get_account_info(self) -> dict:
        return await self._call("GET", "me", params={"fields": "id,username,account_type"})

    # ---- Webhook subscription (FR-1.4) ----

    async def subscribe_webhooks(self, page_id: str, fields: list[str]) -> dict:
        return await self._call(
            "POST",
            f"{page_id}/subscribed_apps",
            params={"subscribed_fields": ",".join(fields)},
        )

    async def unsubscribe_webhooks(self, page_id: str) -> dict:
        return await self._call("DELETE", f"{page_id}/subscribed_apps")

    async def get_subscribed_apps(self, page_id: str) -> dict:
        """FR-10.1 health check: confirms our webhook subscription is still active."""
        return await self._call("GET", f"{page_id}/subscribed_apps")

    # ---- Media (FR-2.3) ----

    async def list_media(self, ig_user_id: str, limit: int = 25) -> dict:
        return await self._call(
            "GET",
            f"{ig_user_id}/media",
            params={"fields": "id,caption,media_type,permalink,thumbnail_url,timestamp", "limit": limit},
        )

    # ---- Comments (FR-4) ----

    async def reply_to_comment(self, comment_id: str, message: str) -> dict:
        """Public reply to a comment."""
        return await self._call("POST", f"{comment_id}/replies", params={"message": message})

    async def private_reply_to_comment(
        self, comment_id: str, message: str, quick_replies: Optional[list[dict]] = None
    ) -> dict:
        """
        Private reply (DM) sent in direct response to a comment — this is the
        primary delivery mechanism referenced in TZ section 2.3, and must be
        sent within Meta's private-reply window after the comment is posted.
        """
        payload: dict[str, Any] = {"text": message}
        if quick_replies:
            payload["quick_replies"] = [
                {"content_type": "text", "title": qr["label"], "payload": qr["payload"]} for qr in quick_replies
            ]
        return await self._call(
            "POST",
            "me/messages",
            json={"recipient": {"comment_id": comment_id}, "message": payload},
        )

    async def get_media_comments(self, media_id: str, limit: int = 50) -> dict:
        """Used by the reconciliation poll (NFR-3) to catch comments a missed webhook would have delivered."""
        return await self._call(
            "GET", f"{media_id}/comments", params={"fields": "id,text,timestamp,username,from", "limit": limit}
        )

    # ---- DMs (FR-6) ----

    async def send_dm(self, recipient_ig_user_id: str, text: str, quick_replies: Optional[list[dict]] = None) -> dict:
        message: dict[str, Any] = {"text": text}
        if quick_replies:
            message["quick_replies"] = [
                {"content_type": "text", "title": qr["label"], "payload": qr["payload"]} for qr in quick_replies
            ]
        return await self._call(
            "POST",
            "me/messages",
            json={"recipient": {"id": recipient_ig_user_id}, "message": message},
        )
