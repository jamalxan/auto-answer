/** ETAP 8 subscription filters: schema, the matching matrix, the Uzbek description. */

import { describe, expect, it } from "vitest";
import { sampleEvent, type OutboundPayloadV1 } from "../lib/integrations2/events";
import {
  DEFAULT_SUBSCRIPTION_FILTER,
  describeFilter,
  matchesSubscription,
  readSubscriptionFilter,
  subscriptionFilterSchema,
} from "../lib/integrations2/subscriptions";
import { buildHotLeadText, shouldSendHotCard } from "../lib/integrations2/connectors/telegram-hot-text";

/** The sample is a test event; most cases want a real one. */
const real = (type: Parameters<typeof sampleEvent>[0] = "lead.created"): OutboundPayloadV1 => ({ ...sampleEvent(type), is_test: false });

describe("schema", () => {
  it("accepts the documented shape and rejects unknown keys / bad values", () => {
    expect(subscriptionFilterSchema.safeParse({ v: 1 }).success).toBe(true);
    expect(
      subscriptionFilterSchema.safeParse({
        v: 1,
        temperatures: ["HOT", "WARM"],
        min_score: 60,
        accounts: ["ig1"],
        include_test: true,
        channels: ["ad", "comment"],
        tags: ["vip"],
        stages: ["s1"],
        include_transcript: true,
      }).success
    ).toBe(true);
    expect(subscriptionFilterSchema.safeParse({ v: 2 }).success).toBe(false);
    expect(subscriptionFilterSchema.safeParse({ v: 1, min_score: 101 }).success).toBe(false);
    expect(subscriptionFilterSchema.safeParse({ v: 1, temperatures: ["LUKEWARM"] }).success).toBe(false);
    expect(subscriptionFilterSchema.safeParse({ v: 1, channels: ["sms"] }).success).toBe(false);
    expect(subscriptionFilterSchema.safeParse({ v: 1, extra: true }).success).toBe(false);
    expect(readSubscriptionFilter("garbage")).toBe(DEFAULT_SUBSCRIPTION_FILTER);
    expect(readSubscriptionFilter({ v: 1, min_score: 10 })).toEqual({ v: 1, min_score: 10 });
  });
});

describe("matchesSubscription", () => {
  it("empty filter: everything except test events", () => {
    expect(matchesSubscription({ v: 1 }, real())).toBe(true);
    expect(matchesSubscription({ v: 1 }, sampleEvent("lead.created"))).toBe(false);
    expect(matchesSubscription({ v: 1, include_test: true }, sampleEvent("lead.created"))).toBe(true);
    expect(matchesSubscription({ v: 1 }, real("broadcast.completed"))).toBe(true);
  });

  it("matrix: every present condition must pass", () => {
    const hot = real("lead.hot"); // score 72 HOT, account ig_sample01, channel ad, tags ielts/hot
    const cases: Array<[Parameters<typeof matchesSubscription>[0], OutboundPayloadV1, boolean]> = [
      [{ v: 1, temperatures: ["HOT"] }, hot, true],
      [{ v: 1, temperatures: ["COLD", "WARM"] }, hot, false],
      [{ v: 1, temperatures: ["HOT"] }, real("broadcast.completed"), false],
      [{ v: 1, min_score: 72 }, hot, true],
      [{ v: 1, min_score: 73 }, hot, false],
      [{ v: 1, min_score: 0 }, real("broadcast.completed"), false],
      [{ v: 1, accounts: ["ig_sample01"] }, hot, true],
      [{ v: 1, accounts: ["other"] }, hot, false],
      [{ v: 1, accounts: [] }, hot, true],
      [{ v: 1, channels: ["ad"] }, hot, true],
      [{ v: 1, channels: ["comment"] }, hot, false],
      [{ v: 1, tags: ["HOT"] }, hot, true],
      [{ v: 1, tags: ["vip"] }, hot, false],
      [{ v: 1, tags: ["vip"] }, real("contact.tagged"), true],
      [{ v: 1, stages: ["Taklif yuborildi"] }, real("deal.stage_changed"), true],
      [{ v: 1, stages: ["stage_sample02"] }, real("deal.stage_changed"), true],
      [{ v: 1, stages: ["Yangi"] }, real("deal.stage_changed"), false],
      [{ v: 1, stages: ["Yangi"] }, hot, false],
      [{ v: 1, temperatures: ["HOT"], min_score: 60, accounts: ["ig_sample01"], channels: ["ad"], tags: ["ielts"] }, hot, true],
      [{ v: 1, temperatures: ["HOT"], min_score: 60, accounts: ["ig_sample01"], channels: ["ad"], tags: ["none"] }, hot, false],
    ];
    for (const [filter, payload, expected] of cases) {
      expect(matchesSubscription(filter, payload), JSON.stringify(filter)).toBe(expected);
    }
  });
});

describe("describeFilter", () => {
  it("renders Uzbek", () => {
    expect(describeFilter({ v: 1 })).toBe("Barcha hodisalar (testdan tashqari)");
    expect(
      describeFilter(
        { v: 1, temperatures: ["HOT", "WARM"], min_score: 60, accounts: ["ig1", "ig2"], channels: ["ad"], tags: ["vip"], stages: ["s1"], include_test: true, include_transcript: true },
        { accounts: { ig1: "demo" }, stages: { s1: "Yangi" } }
      )
    ).toBe("Hot / Iliq · ball ≥ 60 · @demo, @ig2 · kanal: Reklama · teglar: vip · bosqich: Yangi · test hodisalar bilan · suhbat matni bilan");
  });
});

describe("telegram HOT card", () => {
  it("builds the TZ 41.1 card with HTML escaping", () => {
    const payload = real("lead.hot");
    payload.lead!.name = "Ali <b>& Vali</b>";
    payload.lead!.product = "A & B";
    const text = buildHotLeadText(payload);
    expect(text.split("\n").slice(0, 6)).toEqual([
      "🔥 <b>HOT LEAD</b> — @demo.markaz",
      "👤 Ism: Ali &lt;b&gt;&amp; Vali&lt;/b&gt; (@dilnoza.k)",
      "📞 Telefon: +998901234567",
      "🛋 Mahsulot: A &amp; B",
      "📊 Score: <b>72</b> (hot)",
      '📍 Manba: Kampaniya "Kuzgi aksiya" (ielts)',
    ]);
    expect(text).toContain("💰 Byudjet: 1 mln so'mgacha");
    expect(text).toContain('<a href="https://app.socialauto.uz/inbox?conversation=conv_sample01">Instagram suhbat</a>');
    expect(buildHotLeadText(sampleEvent("lead.hot")).startsWith("🔥 [TEST] <b>HOT LEAD</b>")).toBe(true);
  });

  it("very hot marker, missing phone, non-campaign sources", () => {
    const payload = real("lead.hot");
    payload.score!.band = "very_hot";
    payload.lead!.phone = null;
    payload.source = { kind: "inbound_dm", channel: "comment", campaign: null, keyword: null, ad_id: null, ref: null };
    const text = buildHotLeadText(payload);
    expect(text.startsWith("🔥🔥 <b>HOT LEAD</b>")).toBe(true);
    expect(text).toContain("📞 Telefon: berilmadi");
    expect(text).toContain("📊 Score: <b>72</b> (very hot)");
    expect(text).toContain("📍 Manba: Instagram izoh");
    const bare = real("broadcast.completed");
    expect(buildHotLeadText(bare)).toContain("📍 Manba: Noma'lum");
    expect(buildHotLeadText(bare)).toContain("📊 Score: —");
  });

  it("shouldSendHotCard: HOT temperature and the filter", () => {
    const hot = real("lead.hot");
    expect(shouldSendHotCard({ v: 1 }, hot)).toBe(true);
    expect(shouldSendHotCard({ v: 1, min_score: 90 }, hot)).toBe(false);
    expect(shouldSendHotCard({ v: 1 }, sampleEvent("lead.hot"))).toBe(false); // test event
    const warm = real("lead.created");
    warm.score!.temperature = "WARM";
    expect(shouldSendHotCard({ v: 1 }, warm)).toBe(false);
    expect(shouldSendHotCard({ v: 1 }, real("broadcast.completed"))).toBe(false);
  });
});
