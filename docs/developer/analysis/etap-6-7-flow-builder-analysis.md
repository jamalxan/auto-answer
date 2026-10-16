# ETAP 6/7 — Flow Builder + AI Flow Builder/Auditor: architecture proposal (read-only)

Repo: `C:\Users\Jamolxon\PycharmProjects\auto-answer`. Everything below is additive (new tables, new `lib/flows/`, new `/developer/flows` screens) plus a short list of small, explicitly named branches in existing files. Facts about the existing code are cited by file; design choices are labelled as recommendations.

## 0. What the engine must sit on (verified facts)

| Capability | Where | What the flow engine reuses |
|---|---|---|
| Event storage + per-person claim | `lib/triggers/ingest.ts` (`ingestWebhookPayload`, `claimAndStoreDmEvent` with `pg_advisory_xact_lock`), `lib/triggers/claim.ts` (`decideDmTrigger`, `findActiveConversations`, `isCommentClaimedByCommentEngine`) | The ONE decision per DM stays in the webhook; a flow must be claimable through the same path |
| Matching/priority | `lib/triggers/matching.ts` — pure functions over structural interfaces `CommentMatchableCampaign`, `DmMatchableCampaign`, `MatchableCampaign` | Same selection order (EXACT > CONTAINS > INTENT > EVERY, specific post, priority, oldest); any object with those fields can be a candidate |
| Account gate | `ingest.ts loadAccountGate` — events are stored only for accounts with ≥1 `TriggerCampaign` | A flow must make its account "engaged" |
| Send path | `lib/triggers/delivery.ts sendGuarded` (workspace quota → 750/h slot → send; token failures mark BROKEN), execution lifecycle `beginExecution/markExecutionSending/markExecutionSent/skipExecution/failExecution` | Every flow send |
| Window rule | `lib/triggers/followups.ts isWindowOpen/windowAnchor` (24h − 5 min, anchors `openedAt`/`lastInboundAt`) | Delay node, every send after a wait |
| In-window idempotent send | `lib/triggers/direct-handler.ts replyOnce` — OUTBOUND `TriggerMessage` marker `pending:<event>:<kind>` written in `beforeSend`, swapped for Meta's mid; `@@unique([conversationId, mid])` | Same marker technique, keyed by run+seq |
| Ownership of the thread | `TriggerExecution` fields `openedAt/lastInboundAt/handedOffAt/stoppedAt`; `isActiveCommentConversation` (< 24h since last activity, handoff keeps it taken) | JavobAI (`lib/javobai/runtime.ts:321-341`) and `decideDmTrigger` already go silent/skip on these rows |
| Payloads | `lib/triggers/normalize.ts` accepts only `c2:` postbacks/quick replies (`isC2Payload`, lines 197, 306); `ingest.ts findClaimedC2Messages` claims them from production; `direct-handler.ts parseC2Payload` routes them | A `fl:` prefix must be added in the same three places |
| Phone chips without payload | `lib/triggers/lead-capture.ts findPendingLeadExecution` + `ingest.ts findClaimedLeadPhoneMessages` | A flow waiting for a phone needs the same two-sided rule |
| JavobAI entry points | `handJavobAiThread` (`lib/javobai/runtime.ts:1210`), `openHandoff` (`lib/javobai/handoff.ts:93`), `captureTriggerLead` (`lib/javobai/leads.ts:97`, creates a real `Lead` + deliveries), `enforceBudgetBeforeCall`, `recordJavobAiUsage`, `getJavobAiMode` | AI / Operator / Lead nodes |
| LLM with JSON schema | `lib/assistant/llm/provider.ts` (`getLlmProviderFor(model)`, `LlmRequest.schema` = tool input / response_format), pattern in `lib/triggers/ai-variants.ts:194-221` and `lib/javobai/schema.ts` (zod + hand-written JSON schema + forgiving parser) | AI Flow Builder, AI extract node, LLM-assisted audit |
| Telegram | `lib/telegram/notify.ts alertWorkspace / notifyWorkspaceChats` | Operator node, Action notify |
| SSRF guard | `lib/integrations/net.ts isInternalHostname/isPrivateAddress`; DNS-resolve pattern in `lib/javobai/attachments.ts:184-189` | Webhook node |
| Content filter | `lib/assistant/post-filter.ts filterReply` (phone, foreign URL, price policy NEVER/FROM_ONLY/EXACT, >300 chars), `lib/assistant/price.ts extractPriceMentions` | Auditor "forbidden content" / "price under NEVER" |
| Condition DSL precedent | `lib/crm/segments.ts` (`{v:1, all, any}`, `FIELD_SPECS`, zod superRefine, Uzbek messages) | Flow condition DSL mirrors it |
| CRM | tables exist (`prisma/schema.prisma:1825-2130`: `CrmContact`, `CrmTag`, `CrmContactTag`, `CrmDeal`, `CrmStage`, `CrmAssignmentRule`, `CrmActivity`); `lib/crm/` is pure only (no DB service yet — being built) | Tag/CRM nodes need DB functions that do not exist yet (interface stated in §2.6) |
| Dev area scaffolding | `lib/developer/access.ts requireDeveloper(manage)`, `lib/developer/modules.ts` (flow-builder / ai-flow-builder entries already PLANNED), `components/developer/ui.tsx`, route pattern `app/api/developer/comments/campaigns/route.ts`, page pattern `app/developer/(secure)/javobai/page.tsx` | Same for `/developer/flows` |
| Worker | `worker/dm-worker.ts` registers per-engine workers + 60s maintenance; `lib/triggers/worker.ts` sweep pattern | Flow queue + sweep |
| Tests | `__tests__/helpers/memory-db.ts` (RELATIONS / UNIQUE_KEYS registries), e2e style `__tests__/etap3-engine.test.ts` | New models must be registered there |

Meta constraints already encoded (docs/developer/etap-2, etap-3): one private reply per comment within 7 days (`comment-handler.ts PRIVATE_REPLY_WINDOW_MS`); quick replies only inside an open window, ≤13 × 20 chars (`lib/meta/client.ts MAX_QUICK_REPLIES`); button template text ≤640 (`sendPrivateReplyWithButton`), one postback button; live-comment replies only during the broadcast; nothing is ever forced outside the 24h window.

## 1. Data model (new tables only)

Recommendation: **graph as immutable JSON on `FlowVersion`**, not node/edge rows. Reasons: 13 node types with different fields would be an EAV or a very wide table; the graph is validated by one zod discriminated union at save time; a canonical serialisation (nodes sorted by id, edges sorted by `from,handle,to`, keys sorted) gives a stable `hash` and a cheap node-level diff; nothing queries individual nodes except the engine, which loads the whole version anyway. Rows would be justified only for cross-flow node analytics, which can be computed from `FlowRunStep`.

```prisma
enum FlowStatus      { DRAFT REVIEW PUBLISHED ARCHIVED }
enum FlowMode        { SIMPLE ADVANCED }
enum FlowVersionSource { MANUAL AI TEMPLATE IMPORT }
enum FlowRunStatus   { ACTIVE WAITING_TAP WAITING_INBOUND WAITING_DELAY DONE FAILED CANCELLED }
enum FlowStepStatus  { DONE SKIPPED FAILED WAITING }

model Flow {
  id                 String     @id @default(cuid())
  workspaceId        String
  instagramAccountId String
  name               String
  mode               FlowMode   @default(SIMPLE)
  status             FlowStatus @default(DRAFT)
  // Trigger summary mirrored from the version's Trigger node, for lists/claims
  triggerType        InstagramEventType
  draftVersionId     String?    @unique
  publishedVersionId String?    @unique
  // The hidden TriggerCampaign row that gives this flow a seat in the existing
  // claim / matching / gate logic (see §2.1). FK on the NEW table only.
  proxyCampaignId    String?    @unique
  createdByUserId    String?
  archivedAt         DateTime?
  createdAt          DateTime   @default(now())
  updatedAt          DateTime   @updatedAt
  workspace        Workspace        @relation(...)
  instagramAccount InstagramAccount @relation(...)
  proxyCampaign    TriggerCampaign? @relation(fields: [proxyCampaignId], references: [id], onDelete: SetNull)
  versions FlowVersion[]
  runs     FlowRun[]
  @@index([workspaceId, status])
  @@index([instagramAccountId, status, triggerType])
}

model FlowVersion {
  id            String  @id @default(cuid())
  flowId        String
  version       Int
  schemaVersion Int     @default(1)
  graph         Json              // { v, trigger, nodes[], edges[], variables[] , layout? }
  hash          String            // sha256 of canonical JSON
  source        FlowVersionSource @default(MANUAL)
  prompt        String?           // AI builder input (TZ: Generate step is reproducible)
  changeNote    String?
  auditResult   Json?             // { errors[], warnings[], suggestions[], at }
  policyResult  Json?             // { verdict: PASS|WARNING|BLOCKED, checks[] }
  testedAt      DateTime?         // last successful sandbox run of this exact hash
  approvedAt    DateTime?  approvedByUserId String?
  publishedAt   DateTime?  publishedByUserId String?
  retiredAt     DateTime?         // superseded or unpublished
  createdAt     DateTime @default(now())
  flow Flow @relation(...)
  runs FlowRun[]
  @@unique([flowId, version])
}

model FlowRun {
  id                 String        @id @default(cuid())
  workspaceId        String
  flowId             String
  versionId          String        // pinned: running runs keep their graph
  instagramAccountId String
  igUserId           String
  contactId          String?       // InstagramContact
  conversationId     String?       // TriggerConversation (messages stored there)
  eventId            String        // the InstagramEvent that started it
  executionId        String?       @unique // TriggerExecution of the proxy campaign = window anchor + thread ownership
  status             FlowRunStatus @default(ACTIVE)
  currentNodeId      String?
  seq                Int           @default(0)   // monotonic step counter, optimistic concurrency token
  variables          Json          @default("{}")
  waitNodeId         String?
  waitUntil          DateTime?     // WAITING_DELAY
  waitKind           String?       // "tap" | "inbound" | "phone" | "delay"
  sendsSinceInbound  Int           @default(0)
  isTest             Boolean       @default(false)  // sandbox runs are NOT stored; this marks dev-account runs
  endReason          String?
  lastError          String?
  startedAt          DateTime      @default(now())
  finishedAt         DateTime?
  updatedAt          DateTime      @updatedAt
  @@index([instagramAccountId, igUserId, status])
  @@index([status, waitUntil])
  @@index([flowId, startedAt])
  @@index([workspaceId, startedAt])
}

model FlowRunStep {
  id         String         @id @default(cuid())
  runId      String
  seq        Int
  nodeId     String
  nodeType   String
  status     FlowStepStatus
  input      Json?          // rendered text, evaluated condition inputs, payload sent
  output     Json?          // branch taken, mid, variable written, http status
  reason     String?        // Uzbek, for the logs (why skipped / failed)
  startedAt  DateTime @default(now())
  finishedAt DateTime?
  @@unique([runId, seq])
  @@index([runId, startedAt])
}

model FlowTemplate {             // user-saved templates; the 5 starters live in code (lib/flows/templates/)
  id String @id @default(cuid())  workspaceId String?  key String @unique
  name String  description String?  category String  locale String @default("uz")
  graph Json  schemaVersion Int @default(1)  sort Int @default(0)  createdAt DateTime @default(now())
}
```

Not altered: `TriggerCampaign`, `InstagramEvent`, `TriggerExecution`. Optional additive enum value `TriggerQuickReplyAction.FLOW` (TZ §12) is deferred.

### 1.1 Graph + node schema (zod, `lib/flows/schema.ts`)

```ts
const nodeId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const text = (max: number) => z.string().min(1).max(max);          // MAX_RESPONSE_LENGTH 1000 for DMs
const templateText = (max: number) => text(max);                    // {{var}} allowed, validated separately

const triggerNode = z.object({
  id: nodeId, type: z.literal("trigger"),
  triggerType: z.enum(["COMMENT","LIVE_COMMENT","DIRECT_MESSAGE","STORY_MENTION","STORY_REPLY"]),
  // exactly the TriggerCampaign matching fields, so the proxy row is a 1:1 copy
  matchingMode: z.enum(["EVERY","CONTAINS","EXACT"]).default("CONTAINS"),
  keywords: z.array(z.string().max(60)).max(50).default([]),
  intents: z.array(z.string()).default([]),                         // BUILT_IN_INTENTS keys
  mediaScope: z.enum(["ANY","SPECIFIC"]).default("ANY"), mediaIds: z.array(z.string()).default([]),
  storyScope: z.enum(["ALL","SPECIFIC"]).default("ALL"), storyIds: z.array(z.string()).default([]),
  audience: z.enum(["ANY","NEW_CONTACT","RETURNING_CONTACT","REOPENED"]).default("ANY"),
  reopenAfterHours: z.number().int().min(1).max(720).default(72),
  cooldownHours: z.number().int().min(0).max(720).default(24),
  sourceFilter: z.enum(["ANY","ADS","LINK"]).default("ANY"), adIds: z.array(z.string()).default([]), refs: z.array(z.string()).default([]),
  priority: z.number().int().min(-100).max(100).default(0),
  publicReply: templateText(300).optional(),                        // COMMENT only
});
const messageNode = z.object({
  id: nodeId, type: z.literal("message"),
  text: templateText(1000),
  // One postback button (button template, text ≤ 640). After a COMMENT trigger
  // this is the only way to open the 24h window; elsewhere it is optional.
  button: z.object({ label: text(20), id: z.string().max(16) }).optional(),
  typingDelayMs: z.number().int().min(0).max(5000).default(0),
});
const buttonNode = z.object({                                        // quick replies, needs an open window
  id: nodeId, type: z.literal("button"),
  text: templateText(1000),
  buttons: z.array(z.object({
    id: z.string().max(16), label: text(20),
    kind: z.enum(["text","phone","email"]).default("text"),         // phone → content_type user_phone_number → saves vars.phone
    saveAs: z.string().max(32).optional(),                          // vars.<key> = label (or the shared phone/email)
  })).min(1).max(13),
  // What a plain typed reply (not a tap) does: treat as "other" edge or wait again
  onText: z.enum(["other_edge","keep_waiting"]).default("other_edge"),
  timeoutMinutes: z.number().int().min(1).max(10080).optional(),    // optional "no tap" edge after N min (24h window still checked)
});
const aiNode = z.object({
  id: nodeId, type: z.literal("ai"),
  mode: z.enum(["takeover","ask"]),
  // takeover: handJavobAiThread; the run ends (JavobAI owns the thread)
  intro: templateText(1000).optional(),
  // ask: send `question`, wait for inbound, extract `saveAs` with code (phone/email) or a small LLM call
  question: templateText(1000).optional(),
  saveAs: z.string().max(32).optional(),
  extract: z.enum(["phone","email","name","city","product","free_text","yes_no","number"]).optional(),
  retries: z.number().int().min(0).max(2).default(1),
  retryText: templateText(1000).optional(),
});
const conditionNode = z.object({
  id: nodeId, type: z.literal("condition"),
  branches: z.array(z.object({ id: z.string().max(16), label: z.string().max(40), when: flowFilterSchema })).min(1).max(8),
  // edges: one per branch id + mandatory "else"
});
const delayNode = z.object({
  id: nodeId, type: z.literal("delay"),
  minutes: z.number().int().min(1).max(7 * 24 * 60),
  ifWindowClosed: z.enum(["end","skip_sends","wait_for_inbound"]).default("end"),
  cancelOnReply: z.boolean().default(false),                        // = stopOnReply semantics (follow-up NO_REPLY)
});
const tagNode = z.object({ id: nodeId, type: z.literal("tag"), action: z.enum(["add","remove"]), tagSlugs: z.array(z.string()).min(1).max(10) });
const leadNode = z.object({
  id: nodeId, type: z.literal("lead"),
  phoneFrom: z.string().default("vars.phone"),                      // variable path; must be set, else "missing" edge
  summary: templateText(300).optional(), thanks: templateText(1000).optional(),
});
const webhookNode = z.object({
  id: nodeId, type: z.literal("webhook"),
  url: z.string().url().max(500), method: z.enum(["POST"]).default("POST"),
  body: z.record(z.string(), z.string().max(500)).default({}),      // values are templates
  saveAs: z.string().max(32).optional(), savePath: z.string().max(100).optional(),  // JSON path of the response
  timeoutMs: z.number().int().min(1000).max(10000).default(5000),
});
const crmNode = z.object({
  id: nodeId, type: z.literal("crm"),
  action: z.enum(["move_stage","create_deal","assign","set_field"]),
  stageId: z.string().optional(), pipelineId: z.string().optional(),
  assignStrategy: z.enum(["rules","member"]).optional(), memberId: z.string().optional(),
  field: z.string().max(32).optional(), value: z.string().max(200).optional(),
});
const operatorNode = z.object({
  id: nodeId, type: z.literal("operator"),
  reply: templateText(1000).optional(), note: templateText(300).optional(),
  reason: z.enum(["wants_human","complaint","purchase_ready","flow_rule"]).default("flow_rule"),
});
const actionNode = z.object({
  id: nodeId, type: z.literal("action"),
  action: z.enum(["set_variable","increment","notify_telegram","opt_out","stop_followups","mark_test"]),
  key: z.string().max(32).optional(), value: z.string().max(500).optional(), text: templateText(1000).optional(),
});
const endNode = z.object({ id: nodeId, type: z.literal("end"), reason: z.string().max(80).optional() });

export const flowNodeSchema = z.discriminatedUnion("type", [triggerNode, messageNode, buttonNode, aiNode, conditionNode, delayNode, tagNode, leadNode, webhookNode, crmNode, operatorNode, actionNode, endNode]);

export const flowEdgeSchema = z.object({
  from: nodeId, to: nodeId,
  // which output of `from`: "next" | "tap" | "tap:<buttonId>" | "other" | "timeout" | "branch:<id>" | "else" | "missing" | "error" | "window_closed"
  handle: z.string().max(40).default("next"),
});
export const flowGraphSchema = z.object({
  v: z.literal(1),
  nodes: z.array(flowNodeSchema).min(2).max(120),
  edges: z.array(flowEdgeSchema).max(300),
  variables: z.array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), label: z.string().max(40), kind: z.enum(["string","number","boolean","phone","email"]) })).max(50).default([]),
  layout: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).optional(),   // UI only, ignored by the engine
}).superRefine(structuralChecks); // exactly one trigger, unique ids, edges reference existing nodes, required handles present
```

Handles per node type (what the validator enforces): message → `next` (+ `tap` when `button` set; then `next` is forbidden: after a COMMENT private reply nothing can be sent until the tap); button → `tap:<id>` for every button, `other`, optional `timeout`; condition → `branch:<id>` for every branch + `else`; delay → `next` (+ optional `window_closed`); ai.ask → `next`, `missing`; ai.takeover → none (terminal); lead → `next`, `missing`; webhook → `next`, optional `error`; operator → optional `next` (default terminal); end → none.

### 1.2 Variables and templating (`lib/flows/variables.ts`, pure)

Vocabulary (resolved lazily by the engine into a `FlowContext`):
- `contact.name`, `contact.username`, `contact.phone`, `contact.email`, `contact.language` (`InstagramContact` + `CrmContact` when present)
- `vars.<key>` (run variables; Button `saveAs`, AI ask, webhook `saveAs`, Action set)
- `trigger.text` (comment / DM text), `trigger.keyword`, `trigger.intent`, `trigger.source` (ADS/LINK/organic), `trigger.mediaId`
- `last_message.text`, `last_message.at`
- `tags` (slugs; `CrmContactTag` via `CrmContact(instagramAccountId, igUserId)`)
- `score`, `temperature` (`AiConversationState` through `upsertConversation`-style lookup, else `CrmContact.score`; 0/COLD when none)
- `audience` (`NEW|RETURNING|REOPENED`, from the claim note / event history), `window.open` (bool), `time.hour`, `time.weekday` (Asia/Tashkent), `run.sends`

Templates: `{{name}}` is shorthand for `{{contact.name}}`; `{{product}}` for `{{vars.product}}`; `{{x|fallback}}` syntax; rendering = plain text substitution (DMs are plain text), unknown key = validation error at save (auditor rule "incorrect variable"), empty value at runtime = fallback or "" (never the raw braces). `renderTemplate(text, ctx) → { text, missing[] }`.

Condition DSL (`lib/flows/conditions.ts`, pure): `{ v:1, all:[{field, op, value}], any:[...] }` exactly like `lib/crm/segments.ts` but compiled to an in-memory predicate, with `FIELD_SPECS` for the vocabulary above and operators `eq | neq | in | gte | lte | contains | is_set | not_set | keyword | intent | regex_safe(no)`. `keyword` and `intent` on text fields reuse `findKeyword` / `findIntent` from `lib/triggers/keywords.ts` (same normaliser as campaigns, so "Narxi??" behaves identically). Branch evaluation order = array order, first match wins, else `else`.

## 2. Execution engine (`lib/flows/`)

### 2.1 How a published flow becomes the handler for its trigger — recommendation: **proxy TriggerCampaign**

Chosen option: on publish, the engine creates/updates one hidden `TriggerCampaign` row (`Flow.proxyCampaignId`) whose matching columns are a copy of the Trigger node (`triggerType`, keywords, matchingMode, intents, mediaScope/mediaIds, storyScope/storyIds, audience, reopenAfterHours, cooldownHours, sourceFilter/adIds/refs, priority; `responseMessage` = first message text or `"(flow)"`, `active` = published). Unpublish/archive → `active=false`; delete → row deleted (FK `SetNull` on `InstagramEvent.claimedCampaignId` behaves as today).

Why this beats "new campaign kind selected by the same matching":
- the webhook decision (`claimAndStoreDmEvent` → `decideDmTrigger`), the per-person advisory lock, `claimedCampaignId` (FK to `TriggerCampaign` — a flow id cannot be stored there without altering the table), cooldown and audience computation, `isCommentClaimedByCommentEngine` (production stepping aside), `loadAccountGate` ("engaged" accounts), `findActiveConversations` (thread ownership for JavobAI and Direct triggers), `findPendingLeadExecution` — all keep working with **zero changes**;
- `TriggerExecution` (unique per event+campaign, SENDING/SENT lifecycle) gives the flow run its idempotent first send and its window anchor (`openedAt`, `lastInboundAt`) and the `handedOffAt` flag that already silences JavobAI — the run just keeps updating that row;
- priority between flows and legacy campaigns is the existing rule (EXACT > CONTAINS > …), so the auditor can report overlaps deterministically.

Cost / required small edits in existing files (all additive branches):
1. `lib/flows/bridge.ts: publishedFlowForCampaign(campaignId)` (30s cache like `gate.ts`; returns `{ flow, version }` or null).
2. `lib/triggers/comment-handler.ts handleComment`: after `beginExecution`, `if (flow) return startFlowRun(...)` instead of the variant/private-reply path.
3. `lib/triggers/dm-trigger-handler.ts runDmTrigger`: same branch after the "campaign still active" check.
4. `lib/triggers/processor.ts handleStoryReply` and `lib/triggers/live-handler.ts handleLiveComment`: same branch (STORY_REPLY uses the V1 `selectCampaign`; the proxy row's `storyScope/storyIds/keywords/matchingMode` satisfy `MatchableCampaign`).
5. `lib/triggers/normalize.ts`: add `FLOW_PAYLOAD_PREFIX = "fl:"` and `isOwnPayload = isC2Payload || isFlowPayload` at lines 197 and 306; `ingest.ts findClaimedC2Messages` and `claim.ts isClaimedC2Payload` use the same predicate (taps never reach the keyword path or the assistant).
6. `lib/triggers/direct-handler.ts routeDirectMessage`: `if (isFlowPayload(event.payload)) return resumeFlowRunFromTap(base, payload)` before `parseC2Payload`; `handlePlainMessage`: before the DM-trigger hook, `const waiting = await findWaitingFlowRun(account, sender, at)` → if found, consume the message (`resumeFlowRunFromInbound`) and return (the message is the answer to the flow, like a lead phone).
7. `lib/triggers/ingest.ts`: `findClaimedFlowMessages(payload)` (plain DMs from someone with a `WAITING_INBOUND` run, same shape as `findClaimedLeadPhoneMessages`) and one line in `app/api/webhook/route.ts` next to line 216 adding its keys to `claimedStoryReplies`.
8. `lib/triggers/claim.ts decideDmTrigger`: after the comment-thread check, `if (await flowOwnsThread(...)) return none(FLOW_OWNS_THREAD_REASON)` — a run in `ACTIVE/WAITING_*` for this person blocks other DM triggers (today a DM-trigger execution does not block a second DM trigger; a waiting flow must).
9. `lib/javobai/runtime.ts:337` area: `findWaitingFlowRun` → `trigger_owns_thread` reason `flow` (JavobAI silent while a flow waits for an answer; after a flow `end` or `message` with no wait, JavobAI answers as it does after a MESSAGE chip today).
10. `lib/triggers/comment-service.ts listCommentCampaigns` / `dm-trigger-service.ts` lists: exclude proxy rows (`where: { NOT: { flowProxy: { isNot: null } } }` through the back-relation) so they are not edited by hand.
11. `worker/dm-worker.ts`: `createFlowWorker()` + `runFlowMaintenance()` behind `FLOWS_DISABLED` (kill switch like `TRIGGER_ENGINE_DISABLED`).
12. `lib/developer/modules.ts`: status BUILDING + `href: "/developer/flows"` on the two entries.

Alternative (not recommended): store `{flowId, versionId}` in `rawPayload.dmClaim` and leave `claimedCampaignId` null. Avoids the proxy row but requires flow candidates to be merged into every selection site (`loadCampaigns` in claim.ts, `loadDmTriggerCampaigns`, `handleComment`, `findClaimedStoryReplies`, the gate, cooldown queries by `claimedCampaignId`) and a new "owns thread" query — roughly 8 touch points inside the hottest claim code versus 1 lookup at the top of each handler.

### 2.2 Run lifecycle and the step loop (`lib/flows/engine.ts`)

```
start: handler (comment/dm/story/live) → execution row exists → FlowRun.create({ executionId, versionId, eventId, seq 0, status ACTIVE })
       (unique executionId → a retried event finds the run and calls advance(), never a second run)
advance(runId): Redis lock flow:<runId>:lock (SET NX EX 90, same shape as conv:<id>:lock in lib/assistant/engine.ts:375)
  loop ≤ MAX_STEPS_PER_ADVANCE (25):
    node = graph.nodes[run.currentNodeId]; step = seq+1
    guard: run.seq === expected (updateMany where {id, seq} → count 1) else exit (another worker moved it)
    executeNode(node, ctx, effects) → { outcome: "next" | "wait" | "end" | "fail", handle, patch }
    FlowRunStep.create({ runId, seq, nodeId, ... }) (unique runId+seq)
    "next": follow edge(handle) → currentNodeId; no edge → dead-end → end(reason "dead_end") (auditor prevents this at publish)
    "wait": status WAITING_* , waitNodeId, waitUntil (delay) → schedule delayed BullMQ job flow_<runId>_<seq> (no ":" in ids) → exit
    "end"/"fail": finishedAt, endReason → exit
resume(runId, input): tap { buttonId } | inbound { text, eventId, at } | delay-due | timeout
  → touchInbound on the TriggerExecution (lastInboundAt only moves forward — reuse the rule from direct-handler.ts:215) → resolves the handle (tap:<id> / other / next / timeout / window_closed) → advance()
```

Sends (`Message`, `Button`, Lead thanks, AI ask question, Operator reply):
- First send of a COMMENT/LIVE_COMMENT run = private reply: `sendGuarded` + `markExecutionSending/Sent` on the proxy execution (identical idempotency to `comment-handler.ts`); the Message node's `button` → `sendPrivateReplyWithButton(text ≤ 640, label ≤ 20, payload "fl:<runId>:<nodeId>:<buttonId>")`; `publicReply` on the trigger → `postPublicReply`-style marker.
- First send of a DM/mention/story-reply run and every later send: `isWindowOpen(execution)` first (closed → step SKIPPED with `WINDOW_CLOSED_REASON`, run follows `window_closed` edge or ends), then marker `TriggerMessage { mid: "pending:flow:<runId>:<seq>" }` in `beforeSend`, swapped for the real mid after (exact `replyOnce` technique). Button node → `sendDirectMessageWithQuickReplies` with chips `{ title, payload: "fl:<runId>:<nodeId>:<btnId>", contentType: phone → "user_phone_number" }`; phone chips whose payload comes back as the number are matched by `findWaitingFlowRun(waitKind "phone")` + `phoneFromText` (the lead-capture rule).
- `sendsSinceInbound` increments per send and resets on inbound; `MAX_SENDS_WITHOUT_INBOUND` (default 3, from policy) stops the run with reason "spam guard" — runtime backstop for the publish-time rule.

Delay node: `waitUntil = now + minutes`; BullMQ delayed job + `runFlowMaintenance` sweep every minute (`status WAITING_DELAY, waitUntil ≤ now`, lease by `updateMany` like `runDueFollowUps`). On resume: `cancelOnReply` and `lastInboundAt > waitStartedAt` → skip to `next` without sending (NO_REPLY semantics); window closed → `ifWindowClosed`: `end` (default; reason logged), `skip_sends` (continue, every send until the next inbound is SKIPPED), `wait_for_inbound` (status WAITING_INBOUND; the next customer message reopens the window and the run continues — never a forced send). Policy at publish: a Delay > 24h followed by a send without a prior Button/AI-ask wait and with `ifWindowClosed = skip_sends` or `end` is only a Warning; with no `window_closed`/wait handling it is Blocked (see §3.3).

Condition: `evaluateCondition(branch.when, ctx)` → `branch:<id>` / `else`. Lazy loaders in ctx (score/tags/crm) are memoised per advance.

AI node: `takeover` → `handJavobAiThread({ account, igUserId, messageId: run.eventId-based, text: intro ?? trigger text, context: { campaignName: flow.name, executionId, quickReplyLabel: "flow", mainMessage } })` only when `getJavobAiMode === "LIVE"`; else follow `fallback` edge if present, otherwise Operator behaviour (mirrors `runQuickReply` action AI). Run ends `DONE reason "javobai"`; the execution stays active so `findActiveConversations` keeps Direct triggers quiet while JavobAI talks (as today after an AI chip, follow-ups cancelled). `ask` → send `question`, `WAITING_INBOUND`; on inbound: `phone` → `parsePhone`, `email` → regex (`extractEmail` in `lib/javobai/turn.ts:167`), `yes_no/number` → code; `name/city/product/free_text` → one small LLM call (`getLlmProviderFor(javobAiModel())`, JSON schema `{ value: string|null, confidence: number }`, `enforceBudgetBeforeCall` first, `recordJavobAiUsage` with a new kind `flow_extract`, `LLM_TIMEOUT` 8s; on failure/no provider → raw text stored) → `vars[saveAs]`; `retries` with `retryText`, then `missing` edge.

Tag: `CrmContact` find-or-create by `(instagramAccountId, igUserId)` (create minimal row, `source` from trigger type, origin `AUTOMATION`, `sourceRef: "flow:<flowId>"`), `CrmContactTag` upsert, `CrmActivity` TAG_ADDED/REMOVED with `sourceTable "FlowRunStep", sourceId step.id` (unique → idempotent). Lead: `captureTriggerLead({ account, igUserId, phoneE164: vars.phone, campaignName: flow.name, thresholds, isTest })` → real `Lead` + `LeadDelivery` (Telegram / amoCRM / Bitrix through the existing pipeline) — requires `loadScoringConfig` + account config as in `direct-handler.ts:336-357`; `InstagramContact.phone` updated like the LEAD_CAPTURE chip; `missing` edge when the variable is empty. Operator: `touchInbound(execution, { handedOffAt })` (silences JavobAI and Direct triggers via the existing rule), optional reply, `alertWorkspace` (same text shape as `runQuickReply` HANDOFF), and when JavobAI state exists → `openHandoff(conversationId, { reason, score, thresholds, summary, alert: false })` so the handoff state machine/Telegram take-close buttons work; run ends (or `next`). Webhook: https only, `isInternalHostname` → DNS resolve → `isPrivateAddress` (copy the guard from `javobai/attachments.ts:184-189`), no redirects, timeout, response ≤ 50 KB, `X-SocialAuto-Signature: hmac-sha256(workspace secret)` + `X-SocialAuto-Event: flow.<flowId>`, body = rendered templates + `{ contact, vars, run }`; 3 attempts (30s/2m/10m, via the run's delayed job), then `error` edge or continue with step FAILED. CRM: calls the DB-layer functions (§2.6) once they exist; until then step SKIPPED reason "CRM moduli hali ulanmagan". Action: `notify_telegram` → `notifyWorkspaceChats(workspaceId, rendered)`; `stop_followups` → `cancelFollowUps` on other active executions of the person; `opt_out` → `CrmContact.optedOutAt`. End: finish.

Guards: `MAX_STEPS_PER_RUN` 200, per-node visit cap 20 (counts kept in `variables.__visits`), `MAX_RUN_AGE_DAYS` 7 (then CANCELLED "muddati tugadi"), one ACTIVE/WAITING run per `(account, igUserId)` — a new trigger for a person with a waiting run is answered by the existing run's `other` handling, not a second run (`findWaitingFlowRun` in the handlers; decided in the webhook for DMs via the §2.1 item 8 branch).

Concurrency with other engines: Comment 2.0 / Direct campaigns: same proxy execution rules (an active execution of either kind blocks the other side exactly as today). JavobAI: silent while `WAITING_INBOUND/WAITING_TAP(phone)` or `handedOffAt`; answers after `end`. Production assistant (`lib/assistant/engine.ts`): untouched — dev accounts with flows are JavobAI accounts or trigger accounts; the webhook already keeps claimed events and `fl:` taps away from it.

Failure handling: Meta errors through `classifySendError`; retryable → the run's step stays pending with `nextRetryAt` via a delayed job (`flow_<runId>_<seq>_retry<n>`), max 5 like `TRIGGER_MAX_ATTEMPTS`; non-retryable → step FAILED, run follows `error` edge or FAILED; `OperationalEvent` on final failures (`recordBackendFailure`).

Version pinning: `FlowRun.versionId`; publish creates `FlowVersion n+1`, sets `Flow.publishedVersionId`, retires the previous version (`retiredAt`) but never deletes it; waiting runs keep their graph. Archive/unpublish: proxy `active=false`; runs in `WAITING_*` are CANCELLED with reason "flow o'chirildi" on the next sweep (owner decision 5).

### 2.3 Queue
`lib/flows/queue.ts`: queue `"flows"`, jobs `advance { runId, expectedSeq }` with ids `flow_<runId>_<seq>[_<suffix>]`, delayed for Delay/retry/timeout; worker concurrency 5; `runFlowMaintenance` = sweep due waits + stale ACTIVE runs (lease > 5 min) + age cap. The run row is the source of truth (a lost job is recovered by the sweep, as in `lib/triggers/worker.ts`).

### 2.4 Effects port (testability + sandbox)
`executeNode(node, ctx, effects: FlowEffects)` where `FlowEffects` = `{ send(kind, text, chips?) , wait(kind, until?), addTag, removeTag, captureLead, handoff, handToAi, webhook, crm, notify, now() }`. Production effects = the implementations above; sandbox effects record calls and feed scripted inputs. Node logic is written once.

### 2.5 Sandbox / Test console (`lib/flows/sandbox.ts`)
`runFlowSandbox(graph, script)`; `script = { trigger: { type, text, mediaId?, source? }, contact: { name?, username?, phone?, tags?, score?, isNew? }, inputs: Array<{ tap: string } | { text: string } | { wait: minutes } | { timeout: true }>, llm: "stub" | "real" }`. Executes the same engine with in-memory run/steps, a fake clock (window closes after 24h of script time), no DB writes, no sends, no webhooks (recorded as "would call"), AI ask with `stub` returns the typed text (real = model call logged as `flow_sandbox`). Output: transcript (bot/customer lines with chips), step trace with condition inputs/outcomes, variables, effects list, and warnings (e.g. "send skipped: window closed at +24h"). A sandbox run whose script reaches `end` without FAILED and covers every send node at least once sets `FlowVersion.testedAt` for that hash (Publish requires it, see §3.4).

### 2.6 Interfaces expected from the CRM DB layer (not yet in repo)
`lib/crm/service.ts` (to be written by the CRM work): `ensureCrmContact({ workspaceId, instagramAccountId, igUserId, username?, source })`, `addTags(contactId, slugs, { origin, sourceRef })`, `removeTags(...)`, `moveDealToStage(contactId|dealId, stageId, actor)`, `createDealForContact(contactId, pipelineId?, title)`, `assignByRules(contactId, trigger)` (wraps `assignment-logic.ts`), `setCustomField(contactId, key, value)`, `recordActivity(...)`. Flow nodes call these through `lib/flows/effects.ts`; a missing function → SKIPPED, never a crash.

## 3. Simple Mode, AI Flow Builder, publish workflow, policy engine

### 3.1 Simple Mode
A linear chain is just a graph with one `next` edge per node; the stacked-blocks editor edits `nodes[]` in order and synthesises the edges (Button nodes in Simple Mode allow only "all taps → next" + `other → next`, Condition is hidden; "Advanced" unlocks branching and shows the same graph on the canvas — no conversion step, `Flow.mode` only chooses the editor).

### 3.2 AI Flow Builder (`lib/flows/ai-builder.ts`)
1. Input: prompt (uz/ru), account, optional template hint. Context block built from the workspace: tag slugs, pipeline stages, whether JavobAI is LIVE, which integrations are ACTIVE (Telegram/amoCRM/Bitrix), the account's product names (first 20 from `AssistantProduct`, for `{{product}}` suggestions), language.
2. System prompt = node catalogue with constraints (quick replies ≤13 × 20, message ≤1000, button text ≤640, COMMENT = one private reply then a button, no sends after >24h silence, no prices unless given in the prompt, Uzbek Latin default) + 2 few-shot graphs from the starter templates + the JSON schema (`FLOW_GRAPH_JSON_SCHEMA`, hand-written like `JAVOBAI_JSON_SCHEMA`) + "return `{ name, summary, graph }`".
3. `getLlmProviderFor(javobAiSmartModel() ?? process.env.LLM_MODEL)`, temperature 0.2, maxTokens ~3000, `llmTimeoutMs(45_000)`; `enforceBudgetBeforeCall`; usage row kind `flow_builder`.
4. Parse (forgiving, as `parseJavobAiOutput`) → `flowGraphSchema.safeParse` → on failure one repair round with the zod issues appended ("fix these, same JSON") → still invalid → error `unusable` (same error vocabulary as `ai-variants.ts`).
5. Auto-layout (`lib/flows/layout.ts`, pure: longest-path layering from the trigger, x by layer, y by order, branches fanned) → `FlowVersion` DRAFT with `source: AI, prompt`.
6. Then the normal pipeline: Preview (canvas + outline text) → Validate (auditor §4 + policy §3.3, stored on the version) → Test (sandbox, `testedAt`) → Approve (`approvedAt`, by a manage-role user; REVIEW status) → Publish.

"Never silently replaces a running campaign": Publish is a separate explicit action with a dialog that lists (a) the policy verdict, (b) existing active `TriggerCampaign`s and other published flows on the same account/trigger whose keywords overlap (computed with `selectCommentCampaign`/`selectDmCampaign` on sample texts = the flow's keywords; shows who would win), (c) the currently published version being replaced and the count of its waiting runs. Publishing never deactivates another campaign; an AI-generated version can only be published after `approvedAt` is set by a human.

### 3.3 Policy engine at publish (`lib/flows/policy.ts`, pure over the graph; verdict PASS / WARNING / BLOCKED)

| # | Check (TZ §55 category) | Rule computed from the graph | Verdict |
|---|---|---|---|
| P1 | messaging window | COMMENT/LIVE_COMMENT trigger: first reachable node is not `message` → Blocked; first `message` has no `button` but a later send/button/ai.ask exists → Blocked ("private reply must carry the opening button") | Blocked |
| P2 | messaging window | COMMENT trigger: first message text > 640 chars when it has a button; LIVE_COMMENT flow with any send after the first (live window unknown) → Warning | Blocked / Warning |
| P3 | messaging window | On every path, a `delay` whose cumulative minutes since the last `button`/`ai.ask`/`WAITING_INBOUND` point exceed 24h−5min followed by a send with `ifWindowClosed` not handled (`end` is handled; `skip_sends` warning; no edge = Blocked only if `ifWindowClosed` missing — cannot happen with defaults) → Warning "xabar faqat mijoz yozsa ketadi"; a `delay` ≥ 7 days → Blocked | Warning / Blocked |
| P4 | rate limits / spam | > `MAX_SENDS_WITHOUT_INBOUND` (3) consecutive send nodes with no wait between them → Warning; > 6 → Blocked | Warning / Blocked |
| P5 | duplicate message risk | Two send nodes with identical rendered text on one path → Warning; same keywords+trigger type+account as an active campaign/flow with equal specificity and priority → Warning (ties go to the oldest = the existing one) | Warning |
| P6 | automation eligibility | `ai` node on an account whose JavobAI mode ≠ LIVE and no `fallback` edge → Warning (runtime falls back to operator); `lead` node with no `phone` chip / ai.ask phone upstream on every path → Blocked ("telefon olinmaydi"); `crm` node while CRM DB layer absent → Warning | Warning / Blocked |
| P7 | unsupported action | `button` node reachable before any window-opening point (COMMENT without tap) → Blocked; quick replies > 13 / label > 20 / message > 1000 → Blocked (zod) ; `webhook` host internal/private or non-https → Blocked; host not on the workspace allowlist (owner decision 3) → Warning | Blocked / Warning |
| P8 | content | price mention (`extractPriceMentions`) in any send while the profile `pricePolicy = NEVER` → Warning; phone number / foreign URL per `filterReply` rules → Warning | Warning |
| P9 | structure | endless loop (cycle with no wait node inside) → Blocked; cycle with a wait → Warning if no counter guard (engine caps at 20 visits) | Blocked / Warning |
| P10 | handoff | flow contains `ai` or asks for a phone but no `operator` node reachable and JavobAI not LIVE → Warning "operatorga yo'l yo'q" | Warning |

Blocked disables the Publish button (dev can still save); Warning requires an explicit checkbox in the dialog; results are stored on `FlowVersion.policyResult` with the hash so a changed graph invalidates them.

### 3.4 Publish transaction
`publishFlowVersion(workspaceId, versionId, userId)`: checks `hash` unchanged, `auditResult.errors = 0`, `policyResult.verdict ≠ BLOCKED`, `testedAt` for this hash (owner may relax to Warning), `approvedAt` set (always for `source AI`, configurable for MANUAL) → `$transaction`: upsert proxy `TriggerCampaign` from the Trigger node (+ `forgetAccountGate(account.instagramId)`, `forgetCommentClaims`), set `publishedAt`, retire previous, `Flow.status PUBLISHED`, `publishedVersionId`. Unpublish → proxy `active=false`, status DRAFT/ARCHIVED.

## 4. AI Flow Auditor (`lib/flows/audit.ts`) — TZ §40 mapping

| TZ check | Detection | Severity | Output text (uz) example |
|---|---|---|---|
| unreachable node | graph reachability from the trigger (BFS over edges) | Error | "«Katalog» bloki hech qayerdan ulanmagan" |
| dead-end | node whose required handle has no edge (per §1.1 handle table); `end` optional only after terminal nodes (`operator`, `ai.takeover`) | Error | "«Narx» xabaridan keyin davomi yo'q" |
| duplicate action | same `tag`/`crm`/`lead` action twice on one path; identical send text (P5) | Warning | |
| conflicting conditions | branch filters that are mutually exclusive with the trigger (e.g. `audience eq NEW` branch under a trigger with `audience RETURNING`), unreachable branch (same `field/op/value` as an earlier branch), `else` never reachable when branches cover `is_set`/`not_set` of the same var | Warning | |
| missing delay | ≥ 2 consecutive sends with no `delay`/wait between them → suggestion; a `delay` placed immediately before a `button` whose timeout exceeds the window → Warning | Suggestion / Warning | |
| spam risk | P4 counts; trigger `EVERY` on COMMENT with `cooldownHours 0`; DM trigger `EVERY` + `audience ANY` + `cooldownHours 0` | Warning / Error | |
| policy risk | P1–P3, P7, P9 from the policy engine (shown in both panels, computed once) | Error/Warning per §3.3 | |
| forbidden content | `filterReply` rules on every send text (phone number, URL not in profile text, price under NEVER / not in list under EXACT, >3 lines), plus a small blocklist (guaranteed income, medical claims) — heuristics; optional LLM pass (§4.1) | Warning | |
| incorrect variable | template keys not in vocabulary; `vars.x` used before any node sets it on that path (data-flow over paths); `saveAs` keys not declared in `variables[]` (auto-declare suggestion) | Error | "{{shahar}} o'zgaruvchisi hech qayerda saqlanmaydi" |
| broken integration | `webhook` URL fails the SSRF/https checks or a HEAD/preflight is not done (static only); `crm` stage/pipeline ids not found in `CrmStage`; `tag` slugs not found (suggest create); `notify_telegram` while no ACTIVE Telegram integration; `lead` while no ACTIVE integration (delivery would have no target — Warning) | Error / Warning | |
| missing handoff | P10; also `ai.ask` with `retries` exhausted and no `missing` edge | Warning | |
| endless loop | P9 (Tarjan SCC; a cycle without a wait node = Error) | Error | |
| optimisation suggestions | first message > 300 chars (readability), no `button` after the first DM (suggest chips), `lead` without `thanks`, phone asked before any value given, no `tag` on lead paths, COMMENT flow without `publicReply` | Suggestion | |

### 4.1 LLM-assisted audit (optional, ETAP 7.1)
One call with the outline text + the heuristic findings, JSON schema `{ findings: [{ nodeId, kind: "tone"|"clarity"|"policy"|"sales", severity, text }] }`, model `javobAiSmartModel()`, budget-gated, logged `flow_audit`. Shown in a separate "AI taklifi" group, never changes the verdict (deterministic rules own Blocked/Error).

## 5. Starter templates (`lib/flows/templates/*.ts`, exported as `FLOW_STARTER_TEMPLATES`)

Shown abbreviated to the schema; messages in Uzbek Latin; `layout` omitted (auto-layout at copy time).

**T1 comment → price → catalog → phone → lead → Telegram**
```json
{ "key": "comment_price_lead", "name": "Komment: narx → katalog → telefon → lead",
  "graph": { "v": 1, "variables": [{ "key": "phone", "label": "Telefon", "kind": "phone" }],
  "nodes": [
    { "id": "t", "type": "trigger", "triggerType": "COMMENT", "matchingMode": "CONTAINS", "keywords": ["narx","narxi","price","цена"], "intents": ["PRICE"], "publicReply": "Narxni Direct'ga yubordik 📩" },
    { "id": "m1", "type": "message", "text": "Salom {{name|do'stim}}! Narxlar bilan tanishish uchun tugmani bosing 👇", "button": { "id": "open", "label": "Narxni ko'rish" } },
    { "id": "m2", "type": "message", "text": "{{product|Mahsulot}} narxi: {{vars.price|so'rang}}. Katalogni ham yuboraymi?" },
    { "id": "b1", "type": "button", "text": "Tanlang:", "buttons": [ { "id": "cat", "label": "Katalog" }, { "id": "ph", "label": "Raqamimni qoldiraman", "kind": "phone", "saveAs": "phone" } ] },
    { "id": "m3", "type": "message", "text": "Katalog: {{vars.catalog_url|menejer yuboradi}}. Qiziqsa raqamingizni qoldiring 👇" },
    { "id": "b2", "type": "button", "text": "Raqamingizni qoldiring:", "buttons": [ { "id": "ph2", "label": "Raqamni yuborish", "kind": "phone", "saveAs": "phone" } ] },
    { "id": "lead", "type": "lead", "phoneFrom": "vars.phone", "summary": "Komment orqali narx so'radi", "thanks": "Rahmat! Tez orada bog'lanamiz." },
    { "id": "tag", "type": "tag", "action": "add", "tagSlugs": ["lead","narx"] },
    { "id": "tg", "type": "action", "action": "notify_telegram", "text": "🔥 Yangi lead: @{{username}} {{vars.phone}} — {{trigger.text}}" },
    { "id": "end", "type": "end" } ],
  "edges": [ ["t","m1","next"], ["m1","b1","tap"], ["b1","m3","tap:cat"], ["b1","lead","tap:ph"], ["b1","m3","other"], ["m3","b2","next"], ["b2","lead","tap:ph2"], ["b2","end","other"], ["lead","tag","next"], ["lead","end","missing"], ["tag","tg","next"], ["tg","end","next"] ] } }
```
(edges written as `[from,to,handle]` triples here for brevity; the stored form is objects. `m2` is unused in the edge list on purpose only in this abbreviation — the real template routes `m1 tap → m2 → b1`.)

**T2 story reply → DM**
```json
{ "key": "story_reply_dm", "graph": { "v": 1, "nodes": [
  { "id": "t", "type": "trigger", "triggerType": "STORY_REPLY", "matchingMode": "EVERY" },
  { "id": "m1", "type": "message", "text": "Rahmat, {{name|do'stim}}! Story'dagi taklif haqida batafsil: {{vars.offer|menejer yozadi}}" },
  { "id": "b1", "type": "button", "text": "Nima qilamiz?", "buttons": [ { "id": "info", "label": "Batafsil" }, { "id": "ph", "label": "Raqam qoldirish", "kind": "phone", "saveAs": "phone" } ] },
  { "id": "m2", "type": "message", "text": "Shartlar: {{vars.terms|menejer yozadi}}" },
  { "id": "lead", "type": "lead", "phoneFrom": "vars.phone", "thanks": "Rahmat! Bog'lanamiz." },
  { "id": "end", "type": "end" } ],
  "edges": [ ["t","m1"], ["m1","b1"], ["b1","m2","tap:info"], ["b1","lead","tap:ph"], ["b1","end","other"], ["m2","end"], ["lead","end"], ["lead","end","missing"] ] } }
```

**T3 ad message → qualification → CRM**
```json
{ "key": "ad_qualify_crm", "graph": { "v": 1, "variables": [ { "key": "need", "label": "Ehtiyoj", "kind": "string" }, { "key": "city", "label": "Shahar", "kind": "string" }, { "key": "phone", "label": "Telefon", "kind": "phone" } ],
  "nodes": [
  { "id": "t", "type": "trigger", "triggerType": "DIRECT_MESSAGE", "matchingMode": "EVERY", "sourceFilter": "ADS", "cooldownHours": 24 },
  { "id": "m1", "type": "message", "text": "Salom! Reklamadan kelganingiz uchun rahmat 🙌 Sizga qaysi biri kerak?" },
  { "id": "b1", "type": "button", "text": "Tanlang:", "buttons": [ { "id": "a", "label": "Mahsulot A", "saveAs": "need" }, { "id": "b", "label": "Mahsulot B", "saveAs": "need" }, { "id": "c", "label": "Boshqa", "saveAs": "need" } ] },
  { "id": "ai1", "type": "ai", "mode": "ask", "question": "Qaysi shahardasiz?", "saveAs": "city", "extract": "city", "retries": 1, "retryText": "Shahar nomini yozing, iltimos" },
  { "id": "c1", "type": "condition", "branches": [ { "id": "tosh", "label": "Toshkent", "when": { "v": 1, "all": [ { "field": "vars.city", "op": "contains", "value": "toshkent" } ] } } ] },
  { "id": "b2", "type": "button", "text": "Raqamingizni qoldiring, menejer bugun bog'lanadi:", "buttons": [ { "id": "ph", "label": "Raqamni yuborish", "kind": "phone", "saveAs": "phone" } ] },
  { "id": "m2", "type": "message", "text": "Hozircha faqat Toshkentda xizmat ko'rsatamiz, lekin raqamingizni qoldiring — kengayganda xabar beramiz." },
  { "id": "lead", "type": "lead", "phoneFrom": "vars.phone", "summary": "Reklama: {{vars.need}}, {{vars.city}}" },
  { "id": "crm", "type": "crm", "action": "move_stage", "stageId": "<entry stage>" },
  { "id": "tag", "type": "tag", "action": "add", "tagSlugs": ["reklama"] },
  { "id": "end", "type": "end" } ],
  "edges": [ ["t","m1"], ["m1","b1"], ["b1","ai1","tap:a"], ["b1","ai1","tap:b"], ["b1","ai1","tap:c"], ["b1","ai1","other"], ["ai1","c1"], ["ai1","b2","missing"], ["c1","b2","branch:tosh"], ["c1","m2","else"], ["m2","b2"], ["b2","lead","tap:ph"], ["b2","end","other"], ["lead","crm"], ["lead","end","missing"], ["crm","tag"], ["tag","end"] ] } }
```

**T4 FAQ with AI**
```json
{ "key": "faq_ai", "graph": { "v": 1, "nodes": [
  { "id": "t", "type": "trigger", "triggerType": "DIRECT_MESSAGE", "matchingMode": "EVERY", "audience": "NEW_CONTACT", "cooldownHours": 24 },
  { "id": "m1", "type": "message", "text": "Salom, {{name|do'stim}}! Men SocialAuto yordamchisiman. Savolingizni yozing yoki tanlang 👇" },
  { "id": "b1", "type": "button", "text": "Ko'p so'raladigan savollar:", "buttons": [ { "id": "price", "label": "Narxlar" }, { "id": "addr", "label": "Manzil" }, { "id": "time", "label": "Ish vaqti" }, { "id": "ai", "label": "Boshqa savol" } ] },
  { "id": "mp", "type": "message", "text": "Narxlar: {{vars.prices|menejer yozadi}}" },
  { "id": "ma", "type": "message", "text": "Manzil: {{vars.address|menejer yozadi}}" },
  { "id": "mt", "type": "message", "text": "Ish vaqti: {{vars.hours|9:00–18:00}}" },
  { "id": "ai", "type": "ai", "mode": "takeover", "intro": "Savolingizga JavobAI javob beradi 🤖" },
  { "id": "op", "type": "operator", "reply": "Menejerimiz tez orada javob beradi.", "reason": "flow_rule" },
  { "id": "end", "type": "end" } ],
  "edges": [ ["t","m1"], ["m1","b1"], ["b1","mp","tap:price"], ["b1","ma","tap:addr"], ["b1","mt","tap:time"], ["b1","ai","tap:ai"], ["b1","ai","other"], ["mp","end"], ["ma","end"], ["mt","end"], ["ai","op","fallback"] ] } }
```
(`fallback` is the handle taken when JavobAI is not LIVE; the auditor requires it or warns.)

**T5 giveaway announcement → participation confirm**
```json
{ "key": "giveaway_confirm", "graph": { "v": 1, "variables": [ { "key": "phone", "label": "Telefon", "kind": "phone" } ], "nodes": [
  { "id": "t", "type": "trigger", "triggerType": "COMMENT", "matchingMode": "CONTAINS", "keywords": ["ishtirok","qatnashaman","+","участвую"], "mediaScope": "SPECIFIC", "mediaIds": [], "publicReply": "Ishtirokingiz qabul qilindi ✅ Direct'ni tekshiring" },
  { "id": "m1", "type": "message", "text": "Konkursga xush kelibsiz, {{name|do'stim}}! Ishtirokni tasdiqlash uchun tugmani bosing 👇", "button": { "id": "ok", "label": "Tasdiqlayman" } },
  { "id": "c1", "type": "condition", "branches": [ { "id": "dup", "label": "Allaqachon ishtirokchi", "when": { "v": 1, "all": [ { "field": "tags", "op": "contains", "value": "konkurs" } ] } } ] },
  { "id": "mdup", "type": "message", "text": "Siz allaqachon ro'yxatdasiz 🙂 Natijalar {{vars.date|tez orada}}." },
  { "id": "tag", "type": "tag", "action": "add", "tagSlugs": ["konkurs"] },
  { "id": "m2", "type": "message", "text": "Tasdiqlandi 🎉 Shartlar: {{vars.rules|postda}}. Natijalar: {{vars.date|tez orada}}." },
  { "id": "b1", "type": "button", "text": "G'olib bo'lsangiz bog'lanishimiz uchun raqam qoldirasizmi?", "buttons": [ { "id": "ph", "label": "Raqam qoldirish", "kind": "phone", "saveAs": "phone" }, { "id": "no", "label": "Keyinroq" } ] },
  { "id": "a1", "type": "action", "action": "set_variable", "key": "has_phone", "value": "1" },
  { "id": "end", "type": "end" } ],
  "edges": [ ["t","m1"], ["m1","c1","tap"], ["c1","mdup","branch:dup"], ["c1","tag","else"], ["mdup","end"], ["tag","m2"], ["m2","b1"], ["b1","a1","tap:ph"], ["b1","end","tap:no"], ["b1","end","other"], ["a1","end"] ] } }
```
(No `lead` node on purpose: a giveaway phone is not a sales lead; the TZ §43 giveaway module can read the tag + `vars.phone` later.)

## 6. UI plan — `/developer/flows` (no new dependencies)

Routes/pages (`app/developer/(secure)/flows/`): `page.tsx` (list + templates gallery + "AI bilan yaratish"), `new/page.tsx` (mode choice → creates DRAFT), `[id]/page.tsx` (tabs via `?tab=`: `builder | versions | test | audit | runs | publish`). API under `app/api/developer/flows/`: `route.ts` (GET list/accounts/templates, POST create from blank/template), `[id]/route.ts` (GET/PATCH meta/DELETE), `[id]/versions/route.ts` (GET list, POST save draft graph → new version if hash changed), `[id]/versions/[vid]/route.ts` (GET graph+audit), `[id]/versions/[vid]/audit/route.ts` (POST run audit+policy), `[id]/versions/[vid]/test/route.ts` (POST sandbox), `[id]/versions/[vid]/approve|publish|unpublish/route.ts`, `[id]/runs/route.ts` + `[id]/runs/[rid]/route.ts` (steps), `[id]/runs/[rid]/cancel/route.ts`, `ai/generate/route.ts` (POST prompt → draft version), `diff/route.ts` (GET `?a=&b=`). All guarded by `requireDeveloper(true)` for writes (pattern of `app/api/developer/comments/campaigns/route.ts`).

Components (`components/developer/flows/`):
- `flows-dashboard.tsx` — list (name, trigger, status pill, published vN, waiting runs), templates gallery cards (copy → new flow), AI prompt box.
- `simple-editor.tsx` — Simple Mode: vertical stacked blocks (add step between, reorder by up/down buttons and drag within the list), each block = compact card with inline form; edges synthesised. Feasible with plain React.
- `canvas.tsx` — Advanced Mode: a `div` viewport with CSS `transform: translate(panX,panY) scale(zoom)`; nodes as absolutely positioned cards (`layout[nodeId]`), pointer-event drag (pointerdown/move/up with capture; keep `layout` in state and save with the graph); edges drawn in one `<svg>` overlay (same transform) as cubic Béziers from output handle ports to input ports, with an arrow marker; connecting = drag from a port draws a temp path, drop on a node's input creates the edge with the port's handle; selection → inspector; delete key removes; wheel = zoom around cursor; `autoLayout()` from `lib/flows/layout.ts` button for AI/template graphs. Scope kept small: no minimap, no grouping, no multi-select. This is realistic without react-flow for ≤ 120 nodes; the risk is polish time (hit-testing and port alignment) — budget ~3–4 days. If the owner later allows a dependency, `@xyflow/react` (MIT) replaces only `canvas.tsx`; graph JSON stays.
- `node-inspector.tsx` — right panel, one form per node type driven by the zod schema (fields, limits shown: 20/13/640/1000), variable picker (`{{...}}` insert), per-handle edge list ("tap:cat → m3").
- `version-list.tsx` + `version-diff.tsx` — versions table (vN, source, hash, audit/policy badges, tested/approved/published by+at); diff = node-level (added/removed/changed with field-by-field old→new) computed by `lib/flows/diff.ts` from the two canonical graphs, plus the two "outline" texts side by side.
- `test-console.tsx` — like `components/developer/javobai/sandbox-tab.tsx`: scenario presets (TZ §64 A: "narx" comment → DM → reply → lead), trigger form, scripted inputs (type text / tap chip / advance clock), transcript on the left, step trace + variables + effects on the right, "Save as tested" happens automatically when the run ends cleanly.
- `audit-panel.tsx` — three groups (Xatolar / Ogohlantirishlar / Takliflar), each finding links to the node (selects it on canvas / scrolls the stacked editor), policy verdict header PASS/WARNING/BLOCKED with the check table.
- `publish-dialog.tsx` — prerequisites checklist (audit 0 errors, policy, tested, approved), conflicts list (overlapping campaigns/flows and who wins), currently published version + waiting runs count, warning acknowledgements, Publish button; `Approve` is a separate button on the version (manage role).
- `runs-tab.tsx` — runs list with status/current node/waitUntil, run detail = steps timeline (reason text, rendered input, outcome), cancel button.

## 7. Sub-phases, done criteria, risks, owner decisions

| Phase | Scope | Done when |
|---|---|---|
| 6.0 Core | schema + migration, `lib/flows/{schema,variables,conditions,engine,effects,queue,worker,bridge,sandbox}`, proxy campaign publish, nodes Trigger/Message/Button/Condition/Delay/End, handler branches (§2.1 items 1–9, 11), memory-db registrations, tests (`__tests__/flows-engine.test.ts` e2e like etap3) | Scenario A end to end on a dev account: comment "narx" → private reply with button → tap → chips → tap → DM; retried events/jobs never double-send; Delay past 24h never sends (SKIPPED with reason); JavobAI and Direct triggers stay silent while the run waits; `FLOWS_DISABLED=1` leaves everything as before |
| 6.1 Nodes | Tag/Lead/Operator/Webhook/CRM/Action/AI(ask, takeover), SSRF guard, budget-gated extract, Telegram notify | Lead node creates a real `Lead` delivered to Telegram; Operator node silences JavobAI and alerts; webhook to a private host is refused; AI takeover hands to JavobAI on a LIVE account and falls back otherwise |
| 6.2 Simple Mode + templates | list, Simple editor, inspector forms, 5 starter templates, Runs tab, version save/list | Each template copies, saves, passes audit with 0 errors, and runs in the sandbox |
| 6.3 Advanced canvas + versions | canvas, auto-layout, diff, approve/publish/unpublish flow (manual source) | A branch flow (T3) built on the canvas publishes; v2 publish keeps v1 waiting runs on v1 (visible in Runs) |
| 7.0 AI builder + auditor + policy | `ai-builder`, `audit`, `policy`, test console, publish dialog with verdicts | TZ §39 prompt produces a valid graph (or a clear error), auditor flags a dead-end and an unknown variable, policy blocks a COMMENT flow without an opening button, publish requires test+approve |
| 7.1 Optimisation | LLM-assisted audit suggestions, conflict preview with sample texts, run analytics per node (counts from `FlowRunStep`) | Suggestions shown separately; verdicts unchanged by the LLM |

Risks (concrete):
- Thread ownership gaps: a flow run in WAITING_INBOUND must claim plain DMs in the webhook (§2.1 item 7) AND in the handler; if only one side is done the message gets two answers or none — the lead-phone rule shows the two-sided pattern; test both.
- `fl:` payload acceptance in `normalize.ts` changes what production ignores (today non-`c2:` postbacks stay with production's `reveal:`/`followcheck:` handling); the prefix must be unique and the change covered by `__tests__/triggers-normalize.test.ts`.
- Proxy rows appear in campaign lists/overview counts unless filtered (item 10) and in `getEngineOverview`; agree the filter before 6.0.
- Button-template private replies cap text at 640; Simple Mode must show the cap when a button is present.
- Send timeout after Meta delivered (known gap in `lib/triggers/README.md`) also applies to flows — same accepted limitation, document it.
- Canvas effort is UI-heavy; keep Advanced canvas in 6.3 so Simple Mode ships first.
- AI builder output quality on Uzbek prompts: the repair round + few-shot templates mitigate; always route through audit/policy, never auto-publish.
- CRM DB layer timing: Tag/CRM nodes depend on functions not yet written; keep them SKIPPED-safe.

Owner decisions needed:
1. Coexist vs replace: flows coexist with Comment 2.0 / Direct campaigns through the proxy row (recommended); migration of existing campaigns into flows is a later import step (TZ §58-style), not automatic.
2. AI node = JavobAI only (takeover) + a small extract call (ask); no third brain. Should `ask` be allowed on accounts where JavobAI is OFF (extract call uses the LLM key regardless of mode)? Recommended yes, budget-gated.
3. Webhook node: https only + SSRF guard always; additionally a per-workspace host allowlist (Warning when absent) or a global allowlist (`FLOW_WEBHOOK_ALLOWED_HOSTS`)? Recommended: per-workspace allowlist stored in `Integration` of a new type later (ETAP 8); until then Warning only.
4. Lead node on every account (real `Lead` + deliveries, `isTest` from JavobAI config/default true in dev) or only LIVE JavobAI accounts? Recommended: every account (templates T1–T3 depend on it).
5. Unpublish/archive with waiting runs: cancel on next sweep (recommended) vs let them finish.
6. Delay default when the window closed: `end` (recommended) vs `wait_for_inbound`.
7. Spam thresholds: 3 consecutive sends = Warning, 6 = Blocked (proposed); max run age 7 days; per-node visit cap 20.
8. Approval: required for AI-generated versions (TZ §39) — also for manual ones?
9. Model for the AI builder/audit: `JAVOBAI_MODEL_SMART` (recommended) vs production `LLM_MODEL`.
10. Whether STORY_REPLY flows are in scope now (V1 story handler would get the same branch) or deferred with Story V1 kept as is (docs/etap-3 "Not in this stage").
11. Whether proxy rows are hidden from `/developer/comments` and `/developer/triggers` lists (recommended) or shown read-only with a "Flow" badge.

### Critical Files for Implementation
- `C:\Users\Jamolxon\PycharmProjects\auto-answer\lib\triggers\direct-handler.ts` — `replyOnce` marker idempotency, `parseC2Payload`/`buildQuickReplies`, `touchInbound`, `handlePlainMessage`: the resume points for taps/inbound and the send technique the flow engine copies.
- `C:\Users\Jamolxon\PycharmProjects\auto-answer\lib\triggers\claim.ts` — `decideDmTrigger`, `findActiveConversations`, `isCommentClaimedByCommentEngine`: where the proxy campaign is matched and where `flowOwnsThread` is added.
- `C:\Users\Jamolxon\PycharmProjects\auto-answer\lib\triggers\delivery.ts` — `sendGuarded` + execution lifecycle every flow send goes through.
- `C:\Users\Jamolxon\PycharmProjects\auto-answer\lib\triggers\followups.ts` — `isWindowOpen`/`windowAnchor` (Delay node, every post-wait send) and the sweep/lease pattern for `runFlowMaintenance`.
- `C:\Users\Jamolxon\PycharmProjects\auto-answer\prisma\schema.prisma` — `TriggerCampaign`/`TriggerExecution`/`InstagramEvent` (lines 1131-1296) that the proxy design relies on, and where the new Flow* models go (after the CRM block).
- Supporting: `lib\triggers\normalize.ts` (`fl:` prefix), `lib\triggers\ingest.ts` (`findClaimedFlowMessages`), `lib\javobai\runtime.ts` (`handJavobAiThread`, silence rule at 321-341), `lib\javobai\schema.ts` + `lib\triggers\ai-variants.ts` (LLM JSON pattern), `lib\crm\segments.ts` (DSL to mirror), `__tests__\helpers\memory-db.ts` (register Flow models).