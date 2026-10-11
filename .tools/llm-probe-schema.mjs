// The assistant's real JSON schema (lib/assistant/llm-output.ts) against
// LLM_MODEL and each fallback, with max_tokens 600 as in production.
const key = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY;
const base = process.env.LLM_BASE_URL;
const models = [process.env.LLM_MODEL, ...(process.env.LLM_FALLBACK_MODELS ?? "").split(",")]
  .map((m) => (m ?? "").trim())
  .filter(Boolean);
const INTENTS = ["product_question", "price_question", "greeting", "gives_contact", "refuses_contact", "complaint", "spam_or_irrelevant", "asks_if_bot", "wants_human", "other"];
const schema = {
  type: "object",
  properties: {
    reply: { type: "string", description: "Short reply to the customer, max 300 chars, in the customer's language" },
    extracted: {
      type: "object",
      properties: {
        name: { type: ["string", "null"] },
        product_interest: { type: ["string", "null"] },
        extra_field: { type: ["string", "null"] },
      },
      required: ["name", "product_interest", "extra_field"],
    },
    intent: { type: "string", enum: INTENTS },
    language: { type: "string", enum: ["uz_latn", "uz_cyrl", "ru", "other"] },
    summary: { type: ["string", "null"] },
    unknown_question: { type: ["string", "null"] },
  },
  required: ["reply", "extracted", "intent", "language", "summary", "unknown_question"],
};
for (const model of models) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: 600,
        messages: [
          { role: "system", content: "Sen Promtchi kompaniyasining Instagram assistentisan. Javobni JSON qilib ber." },
          { role: "user", content: "menga onlayn do'kon sayti kerak, qancha vaqtda tayyor bo'ladi?" },
        ],
        response_format: { type: "json_schema", json_schema: { name: "assistant_turn", schema } },
      }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => null);
    const c = j?.choices?.[0];
    console.log(`${r.status} ${Date.now() - t0}ms ${model} finish=${c?.finish_reason} usage=${JSON.stringify(j?.usage ?? null)} :: ${JSON.stringify(c?.message?.content ?? j).slice(0, 350)}`);
  } catch (e) {
    console.log(`ERR ${Date.now() - t0}ms ${model} :: ${e.name} ${e.message}`);
  }
}
