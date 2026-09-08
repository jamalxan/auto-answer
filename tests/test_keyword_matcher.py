from types import SimpleNamespace

from app.services.keyword_matcher import match_comment


def make_kw(keyword: str, is_negative: bool = False):
    return SimpleNamespace(keyword=keyword, is_negative=is_negative)


def make_campaign(
    keywords,
    match_mode="word",
    case_insensitive=True,
    cyrillic_normalise=True,
    min_comment_length=1,
    max_comment_length=300,
):
    return SimpleNamespace(
        keywords=keywords,
        match_mode=match_mode,
        case_insensitive=case_insensitive,
        cyrillic_normalise=cyrillic_normalise,
        min_comment_length=min_comment_length,
        max_comment_length=max_comment_length,
    )


# ---- word mode (FR-3.5 default) ----

def test_word_mode_matches_whole_word():
    campaign = make_campaign([make_kw("tizim")])
    result = match_comment("men tizim so'radim", campaign)
    assert result.matched is True
    assert result.keyword == "tizim"
    assert result.reason == "matched"


def test_word_mode_does_not_match_substring_inside_longer_word():
    # "tizim" must NOT match inside "tizimli" as a standalone word (FR-3.5).
    campaign = make_campaign([make_kw("tizim")])
    result = match_comment("tizimli dastur", campaign)
    assert result.matched is False
    assert result.reason == "no_match"


def test_word_mode_case_insensitive_and_punctuation():
    campaign = make_campaign([make_kw("tizim")])
    result = match_comment("TIZIM!!!", campaign)
    assert result.matched is True


# ---- contains mode ----

def test_contains_mode_matches_substring():
    campaign = make_campaign([make_kw("tizim")], match_mode="contains")
    result = match_comment("tizimli dastur kerak", campaign)
    assert result.matched is True
    assert result.keyword == "tizim"


# ---- exact mode ----

def test_exact_mode_requires_full_comment_match():
    campaign = make_campaign([make_kw("tizim")], match_mode="exact")
    assert match_comment("tizim", campaign).matched is True
    assert match_comment("tizim kerak", campaign).matched is False


# ---- negative keywords (FR-3.6) ----

def test_negative_keyword_suppresses_trigger():
    campaign = make_campaign([make_kw("tizim"), make_kw("narxi", is_negative=True)], match_mode="contains")
    result = match_comment("tizim narxi qancha", campaign)
    assert result.matched is False
    assert result.reason == "negative_keyword"


def test_negative_keyword_does_not_affect_unrelated_comment():
    campaign = make_campaign([make_kw("tizim"), make_kw("narxi", is_negative=True)], match_mode="contains")
    result = match_comment("tizim kerak", campaign)
    assert result.matched is True


# ---- length guard (FR-3.7) ----

def test_length_guard_rejects_too_short():
    campaign = make_campaign([make_kw("t")], min_comment_length=3)
    result = match_comment("t", campaign)
    assert result.matched is False
    assert result.reason == "length_guard"


def test_length_guard_rejects_too_long():
    campaign = make_campaign([make_kw("tizim")], max_comment_length=5)
    result = match_comment("tizim juda uzun izoh", campaign)
    assert result.matched is False
    assert result.reason == "length_guard"


def test_length_guard_measures_normalized_text():
    # Leading/trailing punctuation and whitespace are stripped before the
    # length check runs, so a comment that's only "too long" because of
    # padding should still pass.
    campaign = make_campaign([make_kw("tizim")], max_comment_length=5)
    result = match_comment("   tizim   ", campaign)
    assert result.matched is True


# ---- multiple keywords / first match wins ----

def test_multiple_positive_keywords_first_match_returned():
    campaign = make_campaign([make_kw("tizim"), make_kw("tizimly")], match_mode="word")
    result = match_comment("tizimly kerak", campaign)
    assert result.matched is True
    assert result.keyword == "tizimly"


# ---- Cyrillic normalisation integration (FR-3.4) ----

def test_cyrillic_comment_matches_latin_keyword_when_enabled():
    campaign = make_campaign([make_kw("tizim")], match_mode="word", cyrillic_normalise=True)
    result = match_comment("тизим керак", campaign)
    assert result.matched is True


def test_cyrillic_comment_does_not_match_when_normalise_disabled():
    campaign = make_campaign([make_kw("tizim")], match_mode="word", cyrillic_normalise=False)
    result = match_comment("тизим керак", campaign)
    assert result.matched is False


# ---- no keywords configured ----

def test_no_positive_keywords_never_matches():
    campaign = make_campaign([])
    result = match_comment("tizim kerak", campaign)
    assert result.matched is False
    assert result.reason == "no_match"


def test_empty_comment_text():
    campaign = make_campaign([make_kw("tizim")], min_comment_length=1)
    result = match_comment("", campaign)
    assert result.matched is False
    assert result.reason == "length_guard"
