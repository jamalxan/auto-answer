"""
FR-3.3 / FR-3.4: comment text normalisation before keyword matching.
"""
import re
import unicodedata

_EMOJI_PATTERN = re.compile(
    "["
    "\U0001F300-\U0001FAFF"
    "\U00002600-\U000027BF"
    "\U0001F1E6-\U0001F1FF"
    "\U00002190-\U000021FF"
    "\U00002300-\U000023FF"
    "\U0000FE00-\U0000FE0F"
    "]+",
    flags=re.UNICODE,
)

_PUNCT_STRIP = re.compile(r"^[\s!\"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~«»“”‘’]+|[\s!\"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~«»“”‘’]+$")
_MULTI_SPACE = re.compile(r"\s+")

# Minimal Cyrillic -> Latin map for common Uzbek keyword roots (FR-3.4).
# This is intentionally a simple transliteration for MATCHING purposes only,
# not a full linguistic transliterator.
_CYRILLIC_TO_LATIN_UZ = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo",
    "ж": "j", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "x", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sh",
    "ъ": "'", "ы": "i", "ь": "", "э": "e", "ю": "yu", "я": "ya",
    "ў": "o'", "қ": "q", "ғ": "g'", "ҳ": "h",
}


def strip_emoji(text: str) -> str:
    return _EMOJI_PATTERN.sub("", text)


def cyrillic_to_latin(text: str) -> str:
    return "".join(_CYRILLIC_TO_LATIN_UZ.get(ch, ch) for ch in text)


def normalize_comment(text: str, *, case_insensitive: bool = True, cyrillic_normalise: bool = True) -> str:
    """
    Trim, collapse whitespace, strip emoji, strip leading/trailing punctuation,
    optionally lowercase and transliterate Cyrillic -> Latin for matching.
    """
    if text is None:
        return ""
    normalized = unicodedata.normalize("NFC", text)
    normalized = strip_emoji(normalized)
    normalized = _MULTI_SPACE.sub(" ", normalized).strip()
    normalized = _PUNCT_STRIP.sub("", normalized)

    if case_insensitive:
        normalized = normalized.lower()
    if cyrillic_normalise:
        normalized = cyrillic_to_latin(normalized)
    return normalized
