# ETAP 4 — JavobAI (developer area)

Master TZ: sections 19–26, 54, 66 and 63 (ETAP 4). Built as a second
"brain" next to the production lead assistant (`lib/assistant`), switched on
per Instagram account from `/developer/javobai`. Production keeps answering
every account that is not switched on.

## Why not rewrite the assistant

Most ETAP 4 building blocks already run in production: the knowledge base
(profile, products, FAQs), the "only verified facts" prompt + post-filter,
three-language handling, knowledge gaps with a Telegram digest, lead creation
and delivery, inbox pause/resume, LLM usage logging and the monthly quota.
What is missing is on top of that: a confidence/grounding signal, lead scoring,
a real handoff lifecycle, contact-level memory, voice/image in Direct, and
correct Gemini cost accounting. JavobAI 2.0 reuses the production conversation
record and KB and adds those pieces in its own tables (`lib/javobai`).

## Modes (per account, dev only)

| Mode | Who answers | What JavobAI does |
|---|---|---|
| OFF (default) | production assistant | nothing — exactly as before |
| SHADOW | production assistant | computes its own reply, sends nothing, writes nothing to the conversation; stores an `AiShadowTurn` (customer text, production reply, JavobAI reply, score, handoff decision, cost) for side-by-side review |
| LIVE | JavobAI | answers; operator echoes keep working through the shared `Conversation` |

Routing happens in the webhook's assistant block after every ETAP 2/3 claim
(trigger precedence is kept). The gate is cached 30s and fails to production
on any error. `JAVOBAI_DISABLED=1` forces every account to production; the
JavobAI worker re-checks the mode at job time, so a LIVE → OFF switch makes
pending jobs no-ops. LIVE requires a live `AssistantProfile`.

Shared with production, by design: `Conversation` / `ConversationMessage`
(same lock key `conv:<id>:lock`, so a mode switch mid-burst cannot produce
two replies), `handleEcho` (operator detection — JavobAI stores its sends as
ASSISTANT messages with the Meta mid so they are never mistaken for an
operator), `botPaused` / `operatorActiveUntil` (hard mute; inbox buttons keep
working), `createLeadForConversation` and the delivery pipeline.

## Decisions (owner, 2026-10-16)

1. **Sales agent.** JavobAI recommends products, may state discounts that
   exist as verified knowledge entries, asks qualification questions (product,
   budget, location) and then asks for the phone. Every fact still comes from
   the KB; the post-filter stays the last gate.
2. **Purchase-ready → phone → immediate handoff** as a 🔥 HOT lead; JavobAI
   then stays silent.
3. **Dev-account leads go to the tenant's real Telegram / CRM**, marked
   "🧪 TEST" in the summary, so the whole chain is exercised.
4. **Voice = Gemini** native audio transcription with the existing LLM key
   (`GeminiSttProvider`); Whisper stays available if `STT_*` is configured.

Technical decisions: new tables only (no column changes on `Lead`;
`AiLeadInsight` carries score/temperature/email/budget/location); "Very hot"
is a score band, not a status; trigger `LEAD_CAPTURE` on a LIVE account also
creates a real `Lead` (score signal `phone_provided`); while a Comment 2.0 /
live execution has handed the person to an operator or waits for a
LEAD_CAPTURE number, JavobAI stays silent (after a MESSAGE chip nobody else
would answer, so it does); SHADOW calls are logged
in `LlmUsage` with their own kind and do not count against
`aiConversationsThisPeriod`; Telegram take/close buttons are added as new
`jai:` callbacks (small additive change in `lib/telegram/bot.ts`).

## Turn (v2)

The LLM writes the reply and extracts fields; **code** owns state, leads and
handoff — same principle as production `turn.ts`.

Output schema: `reply`, `intent` (production values + `purchase_intent`,
`payment_intent`, `sensitive`), `confidence` 0–1, `used_facts` (ids of KB
lines: `P3` product, `F7` FAQ, `K2` knowledge entry), `extracted` {name, email,
product, interest, budget, location, extra_field}, `language`,
`handoff_request` {needed, reason}, `unknown_question`, `memory_note`.

Grounding rule: a product / price / policy answer with empty `used_facts`, or
`confidence` below the threshold, is treated as unknown → gap recorded,
template "Bu ma'lumot menda yo'q, menejerimiz aniqlab beradi", and after
`unknownStreak ≥ N` (default 2) a handoff. Phone from `extractPhone`, email
by regex. `filterReply` runs last.

Flow: answer from KB → qualification question → ask phone once WARM or on
purchase/payment intent → lead → handoff.

## Scoring (TZ §24)

Signals computed by code from the turn (never a score from the LLM), each
counted once per lead cycle (`AiScoreEvent @@unique(conversationId, leadCycle,
signal)`): `product_selected +10`, `price_asked +15`, `phone_provided +20`,
`purchase_intent +25`, `payment_intent +30`, `email_provided +5`,
`budget_given +10`, `location_given +5`, `returning_contact +5`,
`came_from_ad +5`, `complaint −20`. Rules and thresholds (warm 30, hot 60,
very hot 80) live in `AiScoringConfig` per workspace. Temperature
COLD/WARM/HOT follows the band; CUSTOMER/LOST only by operator action (or
LOST after N days of silence). The score appears in the lead summary
("🔥 HOT 72"), so Telegram/CRM show it without delivery changes.

## Handoff (TZ §25)

```
AI_ACTIVE ──trigger──▶ HANDOFF_PENDING   (handoff template, alert + lead, AiHandoff OPEN)
HANDOFF_PENDING ──echo / inbox reply / Telegram "Qabul qildim"──▶ OPERATOR_ACTIVE
HANDOFF_PENDING ──customer writes──▶ silent (≤3 grounded short replies allowed)
OPERATOR_ACTIVE ──"Yopish" (dev UI / Telegram) or inactivity N h──▶ CLOSED
CLOSED ──next customer message (resumeAi)──▶ AI_ACTIVE   (memory kept)
```

Triggers: `wants_human` / `complaint` / `sensitive` intents, unknown streak,
purchase / payment intent (after the phone), score ≥ `handoffAtScore`,
`AiHandoffRule` (keyword / intent / score / unknown count / off-hours),
trigger HANDOFF button, max turns.

## Memory (TZ §22)

- Conversation: last 12 messages + rolling `summary` built from `memory_note`
  deltas, compacted with one cheap call when it exceeds ~800 chars.
- Contact: `AiContactMemory` per (account, igUserId) — facts, last summary,
  lead ids — survives the 30-day cycle; injected as "MIJOZ HAQIDA".
- Business: KB + verified `AiKnowledgeEntry` (discounts, contacts, terms,
  branches, policies). Learned style stays off (owner decision, earlier).

## Multilingual (TZ §21)

`detectLanguage` per turn (fix: Cyrillic Uzbek without ў/қ/ғ/ҳ), retrieval of
products / FAQs / entries through `normalizeForMatch` (Latin-folded,
transliterated), reply in the customer's script. Test set: "Narxi qancha? /
Нархи канча? / Сколько стоит?" → same intent, right script.

## Voice and image (TZ §26)

Attachments (type + url) are passed through `InboundJob` (optional field,
ignored by production). Voice: download (size/duration caps) → Gemini native
transcription → the transcript becomes the customer message ("🎤 …"); empty
or low-quality → "please write it" template. Image: download now (CDN urls
expire), vision call with the catalog names → confident match answers from
the catalog under the price policy, otherwise a question or handoff. Customer
media is never stored (only a description). Real attachment shapes are
confirmed in observation mode first (the trigger engine already stores raw
payloads for engaged accounts).

## Cost (TZ §66)

Gemini prices per model in `provider.ts` (today Gemini usage logs $0);
`getLlmProviderFor(model)` for routing (`JAVOBAI_MODEL`, `JAVOBAI_MODEL_SMART`
for vision/voice); `AiBudget` per workspace with soft/hard USD limits and
alerts at 50/80/100 %; per-turn caps (history 12, KB ≤ 6000 chars, 400
tokens); static rules + KB first in the prompt, per-message selection last.

## Sub-phases

| Phase | Scope | Done when |
|---|---|---|
| 4.0 Plumbing | `JavobAiAccount` + webhook gate, `javobai` queue/worker, kill switch, Gemini pricing + provider factory, dev pages skeleton | OFF accounts identical (existing tests green); SHADOW logs without sending; gate errors fall back |
| 4.1 KB + agent + scoring + handoff | knowledge entries, v2 schema/prompt/grounding, scoring, handoff machine + rules + Telegram buttons, lead with score, sandbox v2, AI quick-reply action | TZ §64 Scenario B and C pass in sandbox and LIVE; no invented answers on the test set; no double replies on mode switch |
| 4.2 Memory + multilingual | rolling summary, contact memory, transliterated retrieval, detector fix | 20-turn test keeps turn-1 facts; returning contact after 30 days recognised; latn/cyrl/ru set |
| 4.3 Voice + image | attachment pass-through, Gemini STT, vision + catalog match | real shapes documented; voice samples transcribed; image → catalog or handoff |
| 4.4 Cost + promotion prep | budgets, alerts, routing, usage page, TESTING.md J-scenarios | per-tenant USD correct; alerts fire; module TESTING |
