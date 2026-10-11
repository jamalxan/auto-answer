// Run inside the web container: lists Gemini "flash" models available to the
// configured key and sends each a one-word prompt. Prints only model names,
// HTTP status and latency — never the key.
const key = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY;
const base = (process.env.LLM_BASE_URL ?? "").replace(/\/openai\/?$/, "");
if (!key || !base) {
  console.log("LLM_API_KEY or LLM_BASE_URL missing");
  process.exit(1);
}
console.log("current LLM_MODEL:", process.env.LLM_MODEL, "| fallbacks:", process.env.LLM_FALLBACK_MODELS || "-");

const list = await fetch(`${base}/models?pageSize=200`, { headers: { "x-goog-api-key": key } }).then((r) => r.json());
const models = (list.models ?? [])
  .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
  .map((m) => m.name.replace(/^models\//, ""))
  .filter((n) => /flash/i.test(n) && !/(image|tts|audio|live|embedding|exp)/i.test(n));

for (const model of models.slice(0, 12)) {
  const t0 = Date.now();
  let status;
  try {
    const r = await fetch(`${base}/openai/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: "user", content: "Salom" }] }),
      signal: AbortSignal.timeout(15000),
    });
    status = r.status;
  } catch (e) {
    status = e.name === "TimeoutError" ? "timeout" : "error";
  }
  console.log(`${String(status).padEnd(8)} ${String(Date.now() - t0).padStart(6)}ms  ${model}`);
}
