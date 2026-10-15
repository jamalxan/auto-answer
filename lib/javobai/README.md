# JavobAI (ETAP 4, DEV)

The second "brain" next to the production lead assistant (`lib/assistant`).
Switched on per Instagram account from `/developer/javobai`; every account
without a `JavobAiAccount` row is answered by production exactly as before.
Design and owner decisions: `docs/developer/etap-4-javobai.md`.

```
Instagram ─▶ /api/webhook ─▶ ETAP 2/3 claims ─▶ gate.ts: routeAssistantInbound
                                                   │ OFF    → queue "lead-assistant" (production, unchanged)
                                                   │ SHADOW → "lead-assistant" + "javobai" {shadow:true}
                                                   │ LIVE   → "javobai" only
                                                   ▼
                                 worker.ts ─▶ runtime.ts (inbound → media → debounce → budget → reply → persist)
                                                   │          attachments.ts / stt-gemini.ts / vision.ts (4.3)
                                                   │          budget.ts / routing.ts / usage.ts (4.4)
                                                   │          memory.ts (4.2)
                                        turn.ts (the decision) ◀── knowledge.ts (KB block) ◀── retrieval.ts (4.2)
                                                   │               prompt.ts / schema.ts / templates.ts / language.ts (4.2)
                                                   ├─▶ scoring.ts (signals → score → band)
                                                   ├─▶ leads.ts  (Lead + AiLeadInsight, "🧪 TEST · 🔥 HOT 72")
                                                   └─▶ handoff.ts (AiHandoff + alert with jai: buttons)
```

| File | Role |
|---|---|
| `config.ts` | Per-account config (`javobAiConfigSchema`, defaults), TZ 24 signals/thresholds, intents, handoff reasons (Uzbek, incl. `budget`), `JAVOBAI_DISABLED`, `JAVOBAI_MODEL`. Pure. |
| `gate.ts` | Mode per account (30s cache, kill switch, errors → OFF; LIVE/SHADOW also need a live `AssistantProfile`), `routeAssistantInbound` / `routeAssistantEcho` for the webhook. |
| `queue.ts` / `worker.ts` | Queue "javobai" (inbound, reply, echo), worker (concurrency 3) registered in `worker/dm-worker.ts`. |
| `runtime.ts` | Engine: mirrors `lib/assistant/engine.ts` (same `Conversation` record, same lock `conv:<id>:lock`, 4s debounce, 24h window, idempotent message store, typing delay, quota). Media at inbound time, budget gate, memory loaders, usage rows, SHADOW turns, echo → OPERATOR_ACTIVE, `handJavobAiThread` (AI quick reply), maintenance. |
| `state.ts` | Shared persistence: `upsertConversation`, `ensureAiState` (resets per lead cycle, saves the old summary to the contact memory first), signals, account / scoring / rule loaders. |
| `knowledge.ts` | KB block with ids: `B#` profile facts, `P#` products (top 15 via `selectProductsV2`), `F#` FAQs (top 20 via `selectFaqsV2`), `K#` verified entries; ≤ `maxChars` (6000, 4000 under the soft budget); `previewKnowledge` for the UI. |
| `retrieval.ts` | 4.2 transliteration-aware ranking (`normalizeForMatch` both sides, stems, Levenshtein ≤ 1, phrase bonus): `selectProductsV2`, `selectFaqsV2`, `rankByQuery`. Pure. |
| `language.ts` | 4.2 detector v2 (`detectLanguageV2`: letters + stoplists + suffixes, majority script, previous turn breaks Cyrillic ties, `unknown` for emoji/numbers), `replyLanguageInstruction` ("JAVOB TILI"), legacy `Lang` bridges. Pure. |
| `memory.ts` | 4.2 three memory levels: rolling summary (`buildSummaryUpdate`, `compactSummaryIfNeeded`, `saveConversationSummary`), conversation window (`loadConversationMemory`, `toLlmMessages`), contact memory (`loadContactMemory`, `upsertContactMemory`, `contactMemoryBlock`, `factsFromTurn`, `isReturningContact`). |
| `prompt.ts` / `schema.ts` | Sales-agent system prompt (static rules → KB → "MIJOZ HAQIDA" → contact block → campaign → photo note → next step) and the v2 output schema (reply, intent, confidence, used_facts, extracted, handoff_request, unknown_question, memory_note). |
| `turn.ts` | `runJavobAiTurn`: grounding rule (photo matches count as cited facts), extraction (phone by `extractPhone`, email by regex), scoring, qualification → phone → lead → handoff, post-handoff replies, one smart-model retry of a low-confidence factual answer, per-turn caps, `filterReply` last. Pure apart from the model calls. |
| `scoring.ts` | `computeScore`, `bandFor`, `temperatureFor`, `scoreLabel`, `signalsFromTurn`. Pure. |
| `handoff.ts` | State machine (`openHandoff`, `acceptHandoff`, `closeHandoff` → saves the summary to the contact memory, `reopenAi`), Telegram alert with "Qabul qildim" / "Yopish", inactivity auto-close. |
| `leads.ts` | `captureJavobAiLead` (production `createLeadForConversation` + prefix + `AiLeadInsight` + contact memory lead id / summary), `captureTriggerLead` (LEAD_CAPTURE chip on a LIVE account). |
| `attachments.ts` | 4.3 `classifyAttachments` (audio / images / other), `fetchAudioAttachment` / `fetchImageAttachment` (https only, SSRF guard, 8 MB / 5 MB caps, 15s, magic-byte sniffing), `acquireMediaSlot` (3 per conversation per 10 min, Redis, fails open), `describeMediaUrl` (hostname only for logs). |
| `stt-gemini.ts` | 4.3 native Gemini audio transcription (`transcribeWithGemini`, JSON transcript + confidence, `STT_LOW_CONFIDENCE` 0.4), `sttUsageRecord` (kind `javobai_stt`), `GeminiSttProvider`. `lib/assistant/stt.ts` `transcribeVoice` picks Gemini first, Whisper as fallback. |
| `vision.ts` | 4.3 `describeAndMatchImage` (one provider call with the photo + catalog names), `decideImageOutcome` (answer_from_catalog / ask / handoff), `visionSystemNote`, `visionUsageRecord` (kind `javobai_vision`). |
| `usage.ts` | 4.4 `recordJavobAiUsage` (never throws), `monthlyUsage` / `dailySeries` per Tashkent calendar month, the `javobai_*` kinds and labels. |
| `budget.ts` | 4.4 `AiBudget` per workspace (soft / hard USD, whole-workspace spend), `enforceBudgetBeforeCall` (fails open), `runBudgetAlerts` (50 / 80 / 100 % once per month, reset on the 1st), `saveBudget` / `getBudget`. |
| `routing.ts` | 4.4 `pickModel` (reply / summary → default; stt / vision / retry_low_confidence → smart; soft → default; hard → null), `perTurnCaps` (12 / 6000 / 400 → 8 / 4000 / 300), `modelForTask` (env + status → id for `getLlmProviderFor`). Pure. |
| `sandbox.ts` | `runJavobAiSandbox`: same turn, in-memory transcript, no sends, budget gate + caps, only an `LlmUsage` row (kind `javobai_sandbox`). |
| `templates.ts` | Fixed replies of the agent (unknown, qualification questions, phone asks, handoff closings, `voice_unclear`, `budget_paused`) in uz-Latn / uz-Cyrl / ru. |
| `service.ts` | Data access for the dev UI / API (modes, config, entries, scoring, rules, conversations, shadow turns, leads, usage via `monthlyUsage` + `getBudget`, sandbox). |

## Modes

| Mode | Who answers | What JavobAI does |
|---|---|---|
| OFF (no row) | production | nothing |
| SHADOW | production | the job runs 20s after the webhook, computes its reply from the history up to the customer's message (read-only on `Conversation`, no memory reads or writes, media ignored), stores `AiShadowTurn` (customer text, production reply if already stored, AI reply, intent, confidence, score, handoff, cost) + `LlmUsage` kind `javobai_shadow`. Stateless: the score is this turn's own signals. Never counts the quota. Under the hard budget it skips silently. |
| LIVE | JavobAI | answers; `LlmUsage` kind `javobai_reply` (+ `javobai_stt` / `javobai_vision` / `javobai_summary`); counts `aiConversationsThisPeriod` once per conversation after the first delivered model reply, like production. |

The worker re-checks the mode at job time, so LIVE → OFF makes pending jobs
no-ops. Operator echoes still go through production's `handleEcho` (hard
mute); the LIVE copy moves a pending handoff to OPERATOR_ACTIVE.

JavobAI stays silent while a Comment 2.0 / Direct / live trigger execution
(`findActiveConversations`) has handed the person to an operator (HANDOFF
chip) or a LEAD_CAPTURE chip is still waiting for the number
(`findPendingLeadExecution`) — the trigger engine never answers a plain DM
after a MESSAGE chip, so JavobAI does — under `botPaused` /
`operatorActiveUntil`, while an operator owns the handoff, and whenever
production's own rules say so (the profile's `handleInboundDm` /
`handleCampaignReplies` switches, a legacy keyword campaign that answers the
DM itself, the dmLog → `campaignId` link for campaign replies).

## Turn

1. Phone by `extractPhone`, email by regex, language by `detectLanguageV2`
   (the previous turn's language breaks Cyrillic ties; emoji / numbers keep it;
   a fresh thread falls back to Uzbek Latin). The prompt carries
   `replyLanguageInstruction` so the reply comes back in the same script.
2. Code chooses the next step (answer → qualification question → phone once
   WARM or when every qualification field is known/asked → lead → handoff) and
   writes it as "KEYINGI QADAM"; the model writes the reply, cites `used_facts`
   and extracts fields.
3. Grounding: a product / price answer with no cited fact or `confidence <
   threshold` (or an explicit `unknown_question`) becomes the unknown template
   and a knowledge gap; `unknownStreak ≥ N` hands off. A price question under
   the NEVER policy is not a gap; neither is the clarifying question about a
   photo. A confident photo match (4.3) counts as the cited fact; an unreadable
   photo counts as one unknown.
4. Signals (never from the model) → `AiScoreEvent` once per cycle → score /
   temperature. Purchase / payment intent asks for the phone; phone known +
   purchase → lead + handoff `purchase_ready` (owner decision 2). Any phone →
   lead + handoff `phone_captured`. `returning_contact` comes from the contact
   memory of an earlier lead cycle.
5. Handoff reasons, first wins: wants_human / complaint / sensitive → unknown
   streak → purchase_ready → phone_captured → `handoffAtScore` → `AiHandoffRule`
   (KEYWORD / INTENT / SCORE / UNKNOWN_COUNT / OFF_HOURS = the off-hours
   window) → max turns (checked first, before the model). `budget` is opened
   by the engine, not the turn (see Cost).
6. `filterReply` (production post-filter) on every model-written reply;
   blocked → template. Counters that the engine needs (phone asks, asked
   qualification fields, post-handoff replies, the budget notice) live in
   `ConversationMessage.llmMeta` of JavobAI's own replies, so a retry never
   double-counts.
7. 4.4 caps: the history window and `maxTokens` come from `perTurnCaps`; with a
   distinct `JAVOBAI_MODEL_SMART` and an `ok` budget, a factual answer the
   default model could not ground gets one retry on the smart model and the
   better-cited answer wins (`retry_low_confidence` event).

## Handoff state machine

```
AI_ACTIVE ──trigger──▶ HANDOFF_PENDING   (AiHandoff OPEN, handoff reply, Telegram alert + email, Conversation HANDED_OFF)
HANDOFF_PENDING ──echo / Telegram "Qabul qildim" / acceptHandoff──▶ OPERATOR_ACTIVE (operatorActiveUntil = +24h)
HANDOFF_PENDING ──customer writes──▶ ≤ postHandoffReplies grounded short replies, then silence
OPERATOR_ACTIVE ──"Yopish" / closeHandoff / inactivity resumeAfterCloseHours──▶ CLOSED (summary → contact memory)
CLOSED ──next customer message (AiHandoff.resumeAi)──▶ AI_ACTIVE (memory kept)
```

Telegram callbacks `jai:take:<conversationId>` / `jai:close:<conversationId>`
(`lib/telegram/bot.ts`) work in the lead delivery chat and are scoped to the
chat's workspace.

## Leads

`createLeadForConversation` (production) makes the Lead and queues the
deliveries; the summary is `"🧪 TEST · 🔥 HOT 72 · <summary>"` (`isTest` from
the account config, default true while the module is in the developer area),
`AiLeadInsight` keeps score / temperature / email / budget / location /
signals. A trigger LEAD_CAPTURE chip on a LIVE account creates the same lead
(`captureTriggerLead`, signal `phone_provided`).

## Comment 2.0 quick reply "AI"

`TriggerQuickReplyAction.AI` (`lib/triggers/direct-handler.ts`): on a LIVE
account the optional response text goes out, follow-ups are cancelled
("JavobAI'ga o'tkazildi" — which also releases the thread from the
trigger-owns-thread rule), the production conversation becomes CAMPAIGN, the
campaign context is stored in `AiConversationState.context` and the tap's
label is answered by JavobAI through its inbound path. Not LIVE → HANDOFF.

## Integration points (4.2 – 4.4, all in the engine)

### Memory (4.2, TZ 22)

- **Prompt.** `replyInner` loads `loadContactMemory(account, igUserId)` and
  `loadConversationMemory(conversationId, caps.maxHistory + pending)`; the
  history handed to the model is `toLlmMessages(window minus this turn's
  messages)` (operator lines prefixed `[Operator]`), the summary is the
  state's rolling summary, and `contactMemoryBlock(contact)` is rendered
  verbatim under "MIJOZ HAQIDA" ("oldingi suhbatlardan"). `returning` =
  `isReturningContact(contact) && contact.facts.cycle !== leadCycle`.
- **After each LIVE turn** (`persistTurn`): `buildSummaryUpdate` appends the
  dated `memory_note`; once a note pushes the summary past 90 % of
  `SUMMARY_MAX_CHARS`, `compactSummaryIfNeeded` makes one cheap call on the
  routed `summary` model (usage kind `javobai_summary`; out of budget / failed
  → truncated to the newest lines, event `summary_compaction_failed`);
  `saveConversationSummary` stores it with `summaryUpToMessageId` = the last
  customer message of the turn. `upsertContactMemory` merges
  `factsFromTurn(extracted, language)` + `cycle`.
- **Lead / close / cycle.** `captureJavobAiLead` adds `leadId` + the lead
  summary as `lastSummary`; `closeHandoff` and the 30-day rollover in
  `ensureAiState` save the rolling summary as `lastSummary` before it resets.
- SHADOW reads and writes no memory.

### Multilingual (4.2, TZ 21)

`turn.ts` detects with `detectLanguageV2(text, fromLegacyLang(collected.language))`
and keeps production's `Lang` for templates / `Lead.language`; `prompt.ts`
renders `replyLanguageInstruction`. `knowledge.ts` ranks products and FAQs
with `selectProductsV2` / `selectFaqsV2` ("Нархи дивана" → "Divan Milan").
Production's own `detectLanguage` was fixed on the way (Cyrillic word
boundaries) — see `lib/assistant/language.ts`.

### Voice and image (4.3, TZ 26)

In `handleJavobAiInbound` (LIVE only; SHADOW ignores media), when the job
carries attachments: the message is checked for a Meta redelivery, then
`processInboundMedia` runs **under the conversation lock** (bounded wait,
then fails open) before the CUSTOMER message is stored, so the reply job sees
the result and never answers the typed text first:

- budget gate once (`enforceBudgetBeforeCall`; hard → media skipped), then
  `acquireMediaSlot` (3 / 10 min) per attachment;
- **voice** (`media.audio[0]`): `fetchAudioAttachment` → `transcribeVoice(…,
  { preferred: "gemini" })` with the contact's language as hint →
  `recordJavobAiUsage(sttUsageRecord(…))` (failures with `ok: false`) → the
  stored text is `🎤 <transcript>` (+ the typed text); empty / confidence <
  `STT_LOW_CONFIDENCE` / error / cap / not configured → text
  `[ovozli xabar]` and the reply job sends the `voice_unclear` template with no
  model call (silent while a handoff is pending — the manager hears the note);
- **image** (`media.images[0]`): `fetchImageAttachment` → `describeAndMatchImage`
  on the routed `vision` model (`JAVOBAI_MODEL_SMART`) with the catalog in KB
  order (`P#` ids, up to 60) → `recordJavobAiUsage(visionUsageRecord(…))` →
  `decideImageOutcome(result, confidenceThreshold)`; the outcome, the
  `visionSystemNote`, the matched names and the clarifying question ride on the
  CUSTOMER message's `llmMeta.media`. In the reply job the matched names lead
  the retrieval query (so the products are in the KB), ids are re-resolved by
  name, and the turn gets `media: { systemNote, preferredFactIds, question,
  unreadable }`: `answer_from_catalog` grounds the answer, `ask` makes the
  question the next step, `handoff` (unreadable / vision error) counts as an
  unknown. Cap / budget / no provider → `[rasm/fayl]` + production's media
  template;
- other media (video, share, reel, file) → `[rasm/fayl]` + production's media
  template, exactly as before.

Only the hostname of a media url (`describeMediaUrl`) reaches `console.warn`;
events carry outcome, confidence and length, never bytes, urls or transcripts.

### Cost (4.4, TZ 66)

- `enforceBudgetBeforeCall(workspaceId)` runs once per job before any model /
  STT / vision call (inbound media job and reply job each call it once).
  **LIVE, hard limit:** `pauseForBudget` opens a handoff with reason `budget`
  (idempotent, alert with `BUDGET_HARD_EXCEEDED_REASON`), sends the
  `budget_paused` template once per conversation (`llmMeta.budgetNotice`), no
  model call, no usage row; later messages stay silent while the limit holds.
  **SHADOW, hard limit:** skipped silently (event `budget_hard_exceeded`).
  **Soft limit:** `perTurnCaps` → history 8, KB 4000 chars (through
  `loadKnowledgeBlock(…, maxChars)`), 300 output tokens; `modelForTask` → the
  default model for everything (event `budget_soft_exceeded`).
- `modelForTask(task, status)` + `getLlmProviderFor` route `reply` / `summary`
  to `JAVOBAI_MODEL` and `stt` / `vision` / `retry_low_confidence` to
  `JAVOBAI_MODEL_SMART` (STT reads its own `JAVOBAI_STT_MODEL` chain).
- Every call is an `LlmUsage` row through `recordJavobAiUsage` with its kind
  (`javobai_reply`, `javobai_shadow`, `javobai_summary`, `javobai_stt`,
  `javobai_vision`, `javobai_sandbox`), failures included (`ok: false`).
- `runJavobAiMaintenance` (every 60s from the worker) runs
  `autoCloseInactiveHandoffs` and `runBudgetAlerts`.
- `service.ts` `getUsage` reads `monthlyUsage` + `getBudget`, so the Xarajat
  tab and the enforcement agree on Tashkent month boundaries.

## How to extend

- A new scoring signal: add it to `SCORE_SIGNALS` and derive it in
  `signalsFromTurn`.
- A new handoff reason: `HANDOFF_REASONS` (label), the decision chain in
  `turn.ts` (or the engine, like `budget`), a closing line in `templates.ts`
  (`handoffTemplateFor`).
- A new knowledge source: a new id prefix in `knowledge.ts` and `FACT_ID` in
  `schema.ts`.
- A new media type: `classifyAttachments` in `attachments.ts`, a branch in
  `processInboundMedia`, a `JavobAiMediaMeta.kind`.
- A new usage kind: `JAVOBAI_USAGE_KINDS` + label in `usage.ts`.

Tests: `__tests__/javobai-*.test.ts` (gate, turn, runtime end to end,
integration of 4.2–4.4, language, retrieval, memory, attachments, STT, vision,
usage, budget, routing, Telegram buttons, the quick-reply action, scoring /
pricing, service).
