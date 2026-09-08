"""
FR-3: keyword matching engine.
Pure functions, no DB / network access -> easy to unit test.
"""
import re
from dataclasses import dataclass

from app.models.campaign import Campaign
from app.utils.text_normalize import normalize_comment


@dataclass
class MatchResult:
    matched: bool
    keyword: str | None
    reason: str  # matched | no_match | negative_keyword | length_guard


def _word_match(haystack: str, needle: str) -> bool:
    pattern = r"(?<!\w)" + re.escape(needle) + r"(?!\w)"
    return re.search(pattern, haystack, flags=re.UNICODE) is not None


def match_comment(comment_text: str, campaign: Campaign) -> MatchResult:
    normalized = normalize_comment(
        comment_text,
        case_insensitive=campaign.case_insensitive,
        cyrillic_normalise=campaign.cyrillic_normalise,
    )

    # FR-3.7 length guard
    if len(normalized) < campaign.min_comment_length or len(normalized) > campaign.max_comment_length:
        return MatchResult(False, None, "length_guard")

    positive = [k for k in campaign.keywords if not k.is_negative]
    negative = [k for k in campaign.keywords if k.is_negative]

    def norm_kw(raw: str) -> str:
        return normalize_comment(
            raw, case_insensitive=campaign.case_insensitive, cyrillic_normalise=campaign.cyrillic_normalise
        )

    # FR-3.6 negative keywords suppress the trigger entirely
    for neg in negative:
        nk = norm_kw(neg.keyword)
        if nk and nk in normalized:
            return MatchResult(False, None, "negative_keyword")

    for kw in positive:
        nk = norm_kw(kw.keyword)
        if not nk:
            continue
        if campaign.match_mode == "exact":
            hit = normalized == nk
        elif campaign.match_mode == "word":
            hit = _word_match(normalized, nk)
        else:  # "contains"
            hit = nk in normalized
        if hit:
            return MatchResult(True, kw.keyword, "matched")

    return MatchResult(False, None, "no_match")
