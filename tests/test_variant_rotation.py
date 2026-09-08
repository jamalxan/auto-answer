from types import SimpleNamespace

from app.services.conversation_engine import pick_variant


def make_template(step: str, body: str, sort_order: int = 0):
    return SimpleNamespace(step=step, body=body, sort_order=sort_order, quick_replies=[])


async def test_single_variant_always_returned(fake_redis):
    templates = [make_template("public_reply", "Rahmat!")]
    for _ in range(3):
        chosen = await pick_variant(fake_redis, "camp-1", "public_reply", templates)
        assert chosen.body == "Rahmat!"


async def test_no_variant_for_step_returns_none(fake_redis):
    templates = [make_template("opening", "Salom")]
    chosen = await pick_variant(fake_redis, "camp-1", "public_reply", templates)
    assert chosen is None


async def test_multiple_variants_rotate_in_order(fake_redis):
    templates = [
        make_template("public_reply", "A", sort_order=0),
        make_template("public_reply", "B", sort_order=1),
        make_template("public_reply", "C", sort_order=2),
    ]
    seen = [
        (await pick_variant(fake_redis, "camp-1", "public_reply", templates)).body
        for _ in range(6)
    ]
    assert seen == ["A", "B", "C", "A", "B", "C"]


async def test_rotation_is_isolated_per_campaign(fake_redis):
    templates = [make_template("public_reply", "A", 0), make_template("public_reply", "B", 1)]
    first_campaign = [
        (await pick_variant(fake_redis, "camp-1", "public_reply", templates)).body for _ in range(2)
    ]
    second_campaign = [
        (await pick_variant(fake_redis, "camp-2", "public_reply", templates)).body for _ in range(2)
    ]
    assert first_campaign == ["A", "B"]
    assert second_campaign == ["A", "B"]
