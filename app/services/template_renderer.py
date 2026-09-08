"""
FR-6.5: placeholder substitution in message templates.
Unknown placeholders are left untouched rather than raising, so a typo
in the admin panel never breaks message delivery.
"""
import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

_PLACEHOLDER = re.compile(r"\{(\w+)\}")


def render_template(body: str, context: dict) -> str:
    def _sub(match: re.Match) -> str:
        key = match.group(1)
        return str(context.get(key, match.group(0)))

    return _PLACEHOLDER.sub(_sub, body)


def apply_utm(link: str, utm_params: dict | None) -> str:
    """
    FR-7.2: append the campaign's configured UTM parameters to the reward
    link. Existing query params on the link are preserved; a UTM key already
    present on the link itself is left as-is (campaign config does not
    override an explicitly hand-built link).
    """
    if not link or not utm_params:
        return link or ""

    parts = urlsplit(link)
    existing = dict(parse_qsl(parts.query, keep_blank_values=True))
    merged = {**{str(k): str(v) for k, v in utm_params.items() if v not in (None, "")}, **existing}
    new_query = urlencode(merged)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, new_query, parts.fragment))


def build_context(*, username: str | None, first_name: str | None, link: str, keyword: str | None) -> dict:
    return {
        "username": username or "",
        "first_name": first_name or (username or ""),
        "link": link or "",
        "keyword": keyword or "",
    }
