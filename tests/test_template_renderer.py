from urllib.parse import parse_qs, urlsplit

from app.services.template_renderer import apply_utm, build_context, render_template


def test_render_template_substitutes_known_placeholders():
    body = "Salom {username}! Mana havola: {link}"
    context = build_context(username="aziz_uz", first_name=None, link="https://x.uz", keyword="tizim")
    assert render_template(body, context) == "Salom aziz_uz! Mana havola: https://x.uz"


def test_render_template_leaves_unknown_placeholder_untouched():
    body = "Hello {nonexistent}"
    result = render_template(body, {"username": "aziz"})
    assert result == "Hello {nonexistent}"


def test_render_template_handles_missing_username_gracefully():
    context = build_context(username=None, first_name=None, link="https://x.uz", keyword=None)
    assert context["username"] == ""
    assert context["first_name"] == ""
    assert render_template("Hi {username}", context) == "Hi "


def test_build_context_first_name_falls_back_to_username():
    context = build_context(username="aziz_uz", first_name=None, link="", keyword=None)
    assert context["first_name"] == "aziz_uz"


# ---- FR-7.2 UTM parameter application ----

def test_apply_utm_appends_params_to_plain_link():
    result = apply_utm("https://example.uz/link", {"utm_source": "instagram", "utm_campaign": "tizim"})
    parts = urlsplit(result)
    qs = parse_qs(parts.query)
    assert qs["utm_source"] == ["instagram"]
    assert qs["utm_campaign"] == ["tizim"]
    assert result.startswith("https://example.uz/link?")


def test_apply_utm_preserves_existing_query_params():
    result = apply_utm("https://example.uz/link?ref=abc", {"utm_source": "instagram"})
    qs = parse_qs(urlsplit(result).query)
    assert qs["ref"] == ["abc"]
    assert qs["utm_source"] == ["instagram"]


def test_apply_utm_does_not_override_existing_param_with_same_key():
    result = apply_utm("https://example.uz/link?utm_source=manual", {"utm_source": "instagram"})
    qs = parse_qs(urlsplit(result).query)
    assert qs["utm_source"] == ["manual"]


def test_apply_utm_with_no_params_returns_link_unchanged():
    assert apply_utm("https://example.uz/link", {}) == "https://example.uz/link"
    assert apply_utm("https://example.uz/link", None) == "https://example.uz/link"


def test_apply_utm_with_empty_link_returns_empty_string():
    assert apply_utm("", {"utm_source": "instagram"}) == ""
    assert apply_utm(None, {"utm_source": "instagram"}) == ""


def test_apply_utm_skips_none_or_empty_values():
    result = apply_utm("https://example.uz/link", {"utm_source": "instagram", "utm_medium": ""})
    qs = parse_qs(urlsplit(result).query)
    assert "utm_medium" not in qs
    assert qs["utm_source"] == ["instagram"]
