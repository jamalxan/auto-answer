/**
 * `runJavobAiTurn` on its own (no database, fake model): grounding, scoring,
 * qualification → phone → lead → handoff, the handoff triggers, post-handoff
 * replies, template mode and the post-filter.
 */

import { describe, expect, it, vi } from "vitest";
import type { LLMProvider } from "../lib/assistant/llm/provider";
import type { ProfileSnapshot } from "../lib/assistant/prompt";
import { DEFAULT_JAVOBAI_CONFIG, type JavobAiConfig } from "../lib/javobai/config";
import { buildKnowledgeBlock } from "../lib/javobai/knowledge";
import { DEFAULT_SCORING_CONFIG } from "../lib/javobai/scoring";
import { runJavobAiTurn, type JavobAiTurnContext } from "../lib/javobai/turn";

type Out = Partial<{
  reply: string;
  intent: string;
  confidence: number;
  used_facts: string[];
  extracted: Partial<Record<"name" | "email" | "product" | "interest" | "budget" | "location" | "extra_field", string | null>>;
  handoff_request: { needed: boolean; reason: string | null };
  unknown_question: string | null;
  memory_note: string | null;
}>;

function llm(outputs: Array<Out | "throw">): LLMProvider & { complete: ReturnType<typeof vi.fn> } {
  let i = 0;
  return {
    name: "fake",
    model: "gemini-3.1-flash-lite",
    costUsd: (inp: number, out: number) => (inp * 0.25 + out * 1.5) / 1_000_000,
    complete: vi.fn(async () => {
      const step = outputs[Math.min(i++, outputs.length - 1)];
      if (step === "throw") throw new Error("provider down");
      return {
        json: {
          reply: step.reply ?? "Tushundim.",
          intent: step.intent ?? "other",
          confidence: step.confidence ?? 0.9,
          used_facts: step.used_facts ?? [],
          extracted: { name: null, email: null, product: null, interest: null, budget: null, location: null, extra_field: null, ...step.extracted },
          language: "uz_latn",
          handoff_request: step.handoff_request ?? { needed: false, reason: null },
          unknown_question: step.unknown_question ?? null,
          memory_note: step.memory_note ?? null,
        },
        inputTokens: 1000,
        outputTokens: 100,
        model: "gemini-3.1-flash-lite",
        latencyMs: 20,
      };
    }),
  };
}

const profile = (over: Partial<ProfileSnapshot> = {}): ProfileSnapshot => ({
  companyName: "Mebel Plus",
  description: "Divan va kreslolar",
  pricePolicy: "EXACT",
  tone: "FRIENDLY",
  personaName: null,
  extraFieldLabel: null,
  address: null,
  delivery: "Toshkent bo'ylab bepul",
  workingHours: null,
  paymentMethods: [],
  categories: [],
  faqs: [],
  products: [{ name: "Milan", note: null, price: 4_500_000, priceIsFrom: false, currency: "UZS", unit: null }],
  finalMessageTemplate: null,
  ...over,
});

type State = JavobAiTurnContext["state"];

function ctx(
  text: string,
  provider: LLMProvider | null,
  over: { state?: Partial<State>; config?: Partial<JavobAiConfig>; profile?: Partial<ProfileSnapshot>; collected?: JavobAiTurnContext["collected"]; rules?: JavobAiTurnContext["rules"]; templateOnly?: boolean; history?: JavobAiTurnContext["history"]; memory?: Partial<JavobAiTurnContext["memory"]>; context?: JavobAiTurnContext["context"] } = {}
): JavobAiTurnContext {
  return {
    kb: buildKnowledgeBlock(profile(over.profile), [], text),
    config: { ...DEFAULT_JAVOBAI_CONFIG, ...over.config },
    scoring: DEFAULT_SCORING_CONFIG,
    rules: over.rules ?? [],
    state: {
      handoffState: "AI_ACTIVE",
      score: 0,
      extracted: {},
      unknownStreak: 0,
      turns: 0,
      countedSignals: [],
      phoneAskCount: 0,
      askedFields: [],
      postHandoffReplies: 0,
      ...over.state,
    },
    collected: over.collected ?? {},
    memory: { summary: "", facts: {}, returning: false, ...over.memory },
    context: over.context ?? {},
    history: over.history ?? [],
    customerText: text,
    hasMedia: false,
    igName: null,
    lastBotMessage: null,
    templateOnly: over.templateOnly ?? false,
    now: new Date("2026-10-16T12:00:00+05:00"),
    llm: provider,
  };
}

describe("KB answer → score → qualification", () => {
  it("answers from the KB, scores the product and asks the next qualification question", async () => {
    const result = await runJavobAiTurn(
      ctx("Divan bormi?", llm([{ reply: "Ha, Milan divanimiz bor.", intent: "product_question", used_facts: ["P1"], extracted: { product: "Milan" } }]))
    );
    expect(result.reply).toMatch(/^Ha, Milan divanimiz bor\.\n.*byudjet/i);
    expect(result.usedFacts).toEqual(["P1"]);
    expect(result.signals).toEqual([{ signal: "product_selected", points: 10 }]);
    expect(result.score).toBe(10);
    expect(result.askedField).toBe("budget");
    expect(result.handoff.needed).toBe(false);
    expect(result.unknownQuestion).toBeNull();
    expect(result.turns).toBe(1);
    expect(result.usages[0].costUsd).toBeGreaterThan(0);
  });

  it("asks for the phone once qualification is done (even while still COLD)", async () => {
    const result = await runJavobAiTurn(
      ctx("5 mln atrofida", llm([{ reply: "Yaxshi, Milan sizga mos keladi.", extracted: { budget: "5 mln" } }]), {
        state: { turns: 1, extracted: { product: "Milan" }, countedSignals: ["product_selected"], score: 10 },
      })
    );
    expect(result.extracted.budget).toBe("5 mln");
    expect(result.signals).toEqual([{ signal: "budget_given", points: 10 }]);
    expect(result.askedPhone).toBe(true);
    expect(result.reply).toMatch(/raqam/i);
    expect(result.phoneAskCount).toBe(1);
  });

  it("extracts the email by regex and counts it", async () => {
    const result = await runJavobAiTurn(ctx("Mening emailim Ali.K@mail.uz", llm([{ reply: "Rahmat." }])));
    expect(result.extracted.email).toBe("ali.k@mail.uz");
    expect(result.signals).toEqual([{ signal: "email_provided", points: 5 }]);
  });

  it("counts returning contacts and ad traffic from the context", async () => {
    const result = await runJavobAiTurn(ctx("Salom", llm([{ reply: "Salom!" }]), { memory: { returning: true }, context: { cameFromAd: true } }));
    expect(result.signals.map((s) => s.signal).sort()).toEqual(["came_from_ad", "returning_contact"]);
  });
});

describe("grounding rule", () => {
  it("a price answer without cited facts becomes the unknown template and a gap", async () => {
    const result = await runJavobAiTurn(ctx("Samarqandga yetkazib berish narxi?", llm([{ reply: "50 000 so'm", intent: "price_question", used_facts: [] }])));
    expect(result.reply).toMatch(/menda yo'q|ayta olmayman/);
    expect(result.unknownQuestion).toBe("Samarqandga yetkazib berish narxi?");
    expect(result.unknownStreak).toBe(1);
    expect(result.handoff.needed).toBe(false);
    expect(result.events.some((e) => e.type === "grounding_unknown")).toBe(true);
    expect(result.signals).toEqual([{ signal: "price_asked", points: 15 }]);
  });

  it("low confidence on a factual answer is unknown too; the N-th unknown hands off", async () => {
    const low = await runJavobAiTurn(ctx("Milan narxi?", llm([{ reply: "4 500 000 so'm", intent: "price_question", used_facts: ["P1"], confidence: 0.3 }])));
    expect(low.unknownQuestion).not.toBeNull();

    const second = await runJavobAiTurn(
      ctx("Xo'sh?", llm([{ reply: "Bilmayman", intent: "product_question", used_facts: [] }]), { state: { unknownStreak: 1, turns: 1 } })
    );
    expect(second.handoff).toEqual({ needed: true, reason: "unknown_streak" });
    expect(second.reply).toMatch(/menejerimiz/i);
    expect(second.lead).toBeNull();
  });

  it("a price question under the NEVER policy is not a gap", async () => {
    const result = await runJavobAiTurn(
      ctx("Narxi qancha?", llm([{ reply: "Narxini menejerimiz aytadi.", intent: "price_question", used_facts: [] }]), { profile: { pricePolicy: "NEVER" } })
    );
    expect(result.unknownQuestion).toBeNull();
    expect(result.reply).toContain("Narxini menejerimiz aytadi.");
  });
});

describe("purchase → phone → lead → handoff (owner decision 2)", () => {
  it("purchase intent without a number asks for the phone, no handoff yet", async () => {
    const result = await runJavobAiTurn(
      ctx("Milan divanni olmoqchiman", llm([{ reply: "Ajoyib tanlov!", intent: "purchase_intent", extracted: { product: "Milan" } }]))
    );
    expect(result.handoff.needed).toBe(false);
    expect(result.askedPhone).toBe(true);
    expect(result.reply).toMatch(/raqam/i);
    expect(result.signals.map((s) => s.signal).sort()).toEqual(["product_selected", "purchase_intent"]);
    expect(result.score).toBe(35);
  });

  it("the number after purchase intent → 🔥 lead + immediate handoff, final message with the number", async () => {
    const result = await runJavobAiTurn(
      ctx("Ali, 90 123 45 67", llm([{ reply: "Rahmat!", intent: "gives_contact", extracted: { name: "Ali" } }]), {
        state: { score: 35, countedSignals: ["product_selected", "purchase_intent"], extracted: { product: "Milan" }, turns: 1 },
      })
    );
    expect(result.phoneCaptured).toBe(true);
    expect(result.collected.phone_e164).toBe("+998901234567");
    expect(result.collected.name).toBe("Ali");
    expect(result.signals).toEqual([{ signal: "phone_provided", points: 20 }]);
    expect(result.score).toBe(55);
    expect(result.handoff).toEqual({ needed: true, reason: "purchase_ready" });
    expect(result.lead).toEqual({ summary: "Sotib olmoqchi: Milan.", flag: null });
    expect(result.reply).toContain("+998 90 123 45 67");
  });

  it("a number without purchase intent still makes a lead and hands off (flow: lead → handoff)", async () => {
    const result = await runJavobAiTurn(ctx("901234567", null, { templateOnly: true }));
    expect(result.handoff).toEqual({ needed: true, reason: "phone_captured" });
    expect(result.lead?.summary).toBe("Mijoz bog'lanish uchun raqam qoldirdi.");
    expect(result.reply).toContain("+998 90 123 45 67");
  });
});

describe("handoff triggers", () => {
  it.each([
    ["wants_human", "Operator bilan gaplashmoqchiman"],
    ["complaint", "Divan buzuq keldi, shikoyat!"],
    ["sensitive", "Pulimni yo'qotdim, sudga beraman"],
  ])("%s intent hands off at once", async (intent, text) => {
    const result = await runJavobAiTurn(ctx(text, llm([{ reply: "Tushundim.", intent }])));
    expect(result.handoff).toEqual({ needed: true, reason: intent });
    expect(result.reply).toMatch(/menejer/i);
    expect(result.lead).toBeNull();
    if (intent === "complaint") expect(result.signals).toEqual([{ signal: "complaint", points: -20 }]);
  });

  it("honours the model's handoff request only for the known reasons", async () => {
    const asked = await runJavobAiTurn(ctx("…", llm([{ reply: "x", intent: "other", handoff_request: { needed: true, reason: "wants_human" } }])));
    expect(asked.handoff).toEqual({ needed: true, reason: "wants_human" });
    const odd = await runJavobAiTurn(ctx("…", llm([{ reply: "x", intent: "other", handoff_request: { needed: true, reason: "bored" } }])));
    expect(odd.handoff.needed).toBe(false);
  });

  it("max turns → handoff without calling the model", async () => {
    const provider = llm([{ reply: "x" }]);
    const result = await runJavobAiTurn(ctx("yana", provider, { state: { turns: 12 } }));
    expect(result.handoff).toEqual({ needed: true, reason: "max_turns" });
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it("business rules (keyword) and handoffAtScore", async () => {
    const byRule = await runJavobAiTurn(ctx("Direktor bilan gaplashay", llm([{ reply: "x" }]), { rules: [{ kind: "KEYWORD", value: { keywords: ["direktor"] } }] }));
    expect(byRule.handoff).toEqual({ needed: true, reason: "rule" });
    const byScore = await runJavobAiTurn(
      ctx("Milan olaman", llm([{ reply: "x", intent: "purchase_intent", extracted: { product: "Milan" } }]), { state: { score: 30 } })
    );
    expect(byScore.handoff.needed).toBe(false);
    const c = ctx("Milan olaman", llm([{ reply: "x", intent: "purchase_intent", extracted: { product: "Milan" } }]), { state: { score: 30 } });
    c.scoring = { ...c.scoring, handoffAtScore: 60 };
    expect((await runJavobAiTurn(c)).handoff).toEqual({ needed: true, reason: "score" });
  });
});

describe("price question the model missed (B-05)", () => {
  it("'Salom, narxi qancha?' labelled OTHER still scores price_asked (+15)", async () => {
    const result = await runJavobAiTurn(ctx("Salom, narxi qancha?", llm([{ reply: "Salom!", intent: "other", used_facts: [] }])));
    expect(result.signals).toContainEqual({ signal: "price_asked", points: 15 });
    expect(result.intent).toBe("price_question");
  });

  it("forces the signal even when the model chose another intent", async () => {
    const result = await runJavobAiTurn(ctx("Milan narxi qancha? olmoqchiman", llm([{ reply: "Ha", intent: "purchase_intent", used_facts: ["P1"] }])));
    expect(result.signals.map((s) => s.signal)).toContain("price_asked");
  });

  it("a delivery-time question labelled OTHER is not a price question (no signal, no unknown streak)", async () => {
    const result = await runJavobAiTurn(ctx("Qancha vaqt ichida yetkazasiz?", llm([{ reply: "Odatda 2-3 kun.", intent: "other", used_facts: [] }])));
    expect(result.intent).toBe("other");
    expect(result.signals.map((s) => s.signal)).not.toContain("price_asked");
    expect(result.unknownStreak).toBe(0);
  });
});

describe("while a handoff is pending", () => {
  it("allows N grounded short replies, then stays silent", async () => {
    const provider = llm([{ reply: "Ha, Toshkent bo'ylab bepul.", intent: "product_question", used_facts: ["B3"] }]);
    const first = await runJavobAiTurn(ctx("Yetkazib berish bormi?", provider, { config: { postHandoffReplies: 2 }, state: { handoffState: "HANDOFF_PENDING", postHandoffReplies: 0 } }));
    expect(first.reply).toBe("Ha, Toshkent bo'ylab bepul.");
    expect(first.postHandoff).toBe(true);
    expect(first.handoff.needed).toBe(false);

    const unknown = await runJavobAiTurn(
      ctx("Samarqandga?", llm([{ reply: "Ha", intent: "product_question", used_facts: [] }]), { config: { postHandoffReplies: 2 }, state: { handoffState: "HANDOFF_PENDING", postHandoffReplies: 1 } })
    );
    expect(unknown.reply).toMatch(/Menejerimiz tez orada/);

    const silent = await runJavobAiTurn(ctx("Xo'sh?", provider, { state: { handoffState: "HANDOFF_PENDING", postHandoffReplies: 2 } }));
    expect(silent.reply).toBeNull();
  });

  it("default config (0 replies): three customer messages after a handoff get ZERO AI replies (B-06)", async () => {
    const provider = llm([{ reply: "Ha, Toshkent bo'ylab bepul.", intent: "product_question", used_facts: ["B3"] }]);
    for (const message of ["Yetkazib berish bormi?", "Samarqandga?", "Xo'sh?"]) {
      const result = await runJavobAiTurn(ctx(message, provider, { state: { handoffState: "HANDOFF_PENDING", postHandoffReplies: 0 } }));
      expect(result.reply).toBeNull();
    }
    expect(provider.complete).not.toHaveBeenCalled();
    expect(DEFAULT_JAVOBAI_CONFIG.postHandoffReplies).toBe(0);
  });

  it("the 'manager will answer' line is never repeated", async () => {
    const result = await runJavobAiTurn({
      ...ctx("Samarqandga?", llm([{ reply: "Ha", intent: "product_question", used_facts: [] }]), { config: { postHandoffReplies: 3 }, state: { handoffState: "HANDOFF_PENDING" } }),
      lastBotMessage: "Menejerimiz tez orada javob beradi.",
    });
    expect(result.reply).toBeNull();
  });

  it("the single handoff message carries the working hours", async () => {
    const result = await runJavobAiTurn(
      ctx("Operator bilan gaplashmoqchiman", llm([{ intent: "wants_human", reply: "x" }]), { profile: { workingHours: "09:00-18:00" } })
    );
    expect(result.handoff.needed).toBe(true);
    expect(result.reply).toContain("09:00-18:00");
  });

  it("a number given while pending is still captured", async () => {
    const result = await runJavobAiTurn(ctx("90 123 45 67", llm([{ reply: "x" }]), { state: { handoffState: "HANDOFF_PENDING" } }));
    expect(result.lead).not.toBeNull();
    expect(result.reply).toContain("+998 90 123 45 67");
  });
});

describe("safety nets", () => {
  it("template mode answers without the model", async () => {
    const provider = llm([{ reply: "x" }]);
    const result = await runJavobAiTurn(ctx("Salom", provider, { templateOnly: true }));
    expect(provider.complete).not.toHaveBeenCalled();
    expect(result.usedTemplate).toBe(true);
    expect(result.reply).toBeTruthy();
    expect(result.llmFailed).toBe(false);
  });

  it("a provider outage falls back to a template and reports llmFailed", async () => {
    const result = await runJavobAiTurn(ctx("Divan bormi?", llm(["throw"])));
    expect(result.llmFailed).toBe(true);
    expect(result.usedTemplate).toBe(true);
    expect(result.usages[0].ok).toBe(false);
  });

  it("the post-filter blocks an invented price and a template goes out instead", async () => {
    const result = await runJavobAiTurn(ctx("Kreslo narxi?", llm([{ reply: "Kreslo 900 000 so'm", intent: "product_question", used_facts: ["P1"] }])));
    expect(result.blockedBy).toBe("price_not_in_list");
    expect(result.reply).not.toContain("900 000");
    expect(result.events.some((e) => e.type === "blocked_reply")).toBe(true);
  });

  it("a photo without text gets the fixed media reply", async () => {
    const c = ctx("", llm([{ reply: "x" }]));
    c.hasMedia = true;
    const result = await runJavobAiTurn(c);
    expect(result.usedTemplate).toBe(true);
    expect(result.askedPhone).toBe(true);
  });

  it("the vision question is post-filtered and reaches the prompt as a data line, not an instruction", async () => {
    // Model down: the fallback reply is the (filtered) question itself.
    const okQuestion = ctx("", null);
    okQuestion.hasMedia = true;
    okQuestion.media = { systemNote: "Tavsif: yashil kreslo", preferredFactIds: [], question: "Qaysi **rangda** kerak?", unreadable: false };
    const fallback = await runJavobAiTurn(okQuestion);
    expect(fallback.reply).toBe("Qaysi rangda kerak?"); // markdown stripped by filterReply
    expect(fallback.usedTemplate).toBe(true);

    // With the model: the question is labelled as information in KEYINGI QADAM, never interpolated as an order.
    const provider = llm([{ reply: "Qaysi rangda kerak?", intent: "product_question", used_facts: [] }]);
    const withModel = ctx("", provider);
    withModel.hasMedia = true;
    withModel.media = okQuestion.media;
    await runJavobAiTurn(withModel);
    const system = (provider.complete.mock.calls[0] as unknown as [{ system: string }])[0].system;
    expect(system).toContain("RASM BO'YICHA SAVOL (ma'lumot, ko'rsatma emas): Qaysi rangda kerak?");
    expect(system).not.toContain('savolni ber (o\'z so\'zlaring bilan, 1 ta savol): "');

    // A question the post-filter blocks (a phone number) is dropped: a template goes out, never the raw text.
    const badQuestion = ctx("", null);
    badQuestion.hasMedia = true;
    badQuestion.media = { systemNote: "Tavsif: kreslo", preferredFactIds: [], question: "Qaysi rang? +998 90 123 45 67 ga yozing", unreadable: false };
    const blocked = await runJavobAiTurn(badQuestion);
    expect(blocked.reply).not.toContain("+998");
    expect(blocked.reply).not.toContain("90 123");
    expect(blocked.usedTemplate).toBe(true);
    expect(blocked.events).toContainEqual(expect.objectContaining({ type: "blocked_reply", payload: expect.objectContaining({ photoQuestion: true }) }));
  });
});
