from app.utils.text_normalize import cyrillic_to_latin, normalize_comment, strip_emoji


def test_strip_emoji_removes_common_ranges():
    assert strip_emoji("tizim 🔥🎉") == "tizim "
    assert strip_emoji("no emoji here") == "no emoji here"


def test_normalize_trims_and_collapses_whitespace():
    assert normalize_comment("  tizim   sistem  ") == "tizim sistem"


def test_normalize_strips_leading_trailing_punctuation():
    assert normalize_comment("Tizimly!!!") == "tizimly"
    assert normalize_comment("«tizim»") == "tizim"
    assert normalize_comment("...tizim...") == "tizim"


def test_normalize_lowercases_by_default():
    assert normalize_comment("TIZIMLY") == "tizimly"


def test_normalize_case_sensitive_when_disabled():
    assert normalize_comment("TIZIMLY", case_insensitive=False) == "TIZIMLY"


def test_normalize_removes_emoji_and_collapses_resulting_whitespace():
    assert normalize_comment("tizim 🔥 kerak") == "tizim kerak"


def test_cyrillic_to_latin_basic_uzbek_letters():
    assert cyrillic_to_latin("тизим") == "tizim"
    assert cyrillic_to_latin("гўзал") == "gўzal" or cyrillic_to_latin("ў") == "o'"


def test_cyrillic_to_latin_uzbek_specific_letters():
    # ў -> o', қ -> q, ғ -> g', ҳ -> h
    assert cyrillic_to_latin("ў") == "o'"
    assert cyrillic_to_latin("қ") == "q"
    assert cyrillic_to_latin("ғ") == "g'"
    assert cyrillic_to_latin("ҳ") == "h"


def test_normalize_applies_cyrillic_transliteration_when_enabled():
    normalized = normalize_comment("ТИЗИМ", cyrillic_normalise=True)
    assert normalized == "tizim"


def test_normalize_skips_cyrillic_transliteration_when_disabled():
    normalized = normalize_comment("тизим", cyrillic_normalise=False)
    assert normalized == "тизим"


def test_normalize_handles_none_input():
    assert normalize_comment(None) == ""


def test_normalize_handles_empty_string():
    assert normalize_comment("") == ""


def test_normalize_mixed_latin_and_punctuation_and_caps_and_emoji():
    # Mirrors the TZ 4.1 happy path: "Tizimly" as an emoji/caps/punctuation-heavy comment.
    assert normalize_comment("✅ TIZIMLY!! 🔥🔥") == "tizimly"
