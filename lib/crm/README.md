# CRM / Lead Management (ETAP 5) — pure logic

Design and owner decisions: `docs/developer/etap-5-crm.md` (TZ 27–33, 53).

Everything in this folder is **schema-independent**: no Prisma import, no
database, no queue. The CRM tables (`CrmContact`, `CrmTag`, `CrmSegment`,
`CrmPipeline` / `CrmStage` / `CrmDeal`, `CrmAssignmentRule`, `CrmActivity`,
`CrmBroadcast` / `CrmBroadcastRecipient`) are added after the ETAP 4 commits;
until then the modules work on the row shapes declared in `types.ts`, and the
DB layer (service / worker, written later) maps Prisma rows onto them.

```
contacts list / segment preview / broadcast audience
   segments.ts  compileSegmentWhere(filter, now) ─▶ prisma.crmContact.findMany({ where: { workspaceId, ...where } })
contact detail
   DB reads 4 stores + CrmActivity ─▶ TimelineItem[][] ─▶ timeline-merge.ts mergeTimeline ─▶ pageByTime
HOT / lead / handoff / stage event
   DB loads rules + operators ─▶ assignment-logic.ts pickRule / rulesFor ─▶ chooseAssignee ─▶ persist nextCursor
broadcast send tick
   DB loads recipient facts ─▶ broadcast-policy.ts evaluateRecipient ─▶ store snapshot / reason, sendGuarded if eligible
API / page guard
   lib/workspace-permissions.ts can(role, permission) (MEMBER = OPERATOR, unknown = VIEWER)
```

| File | Exports | Row shape it expects |
|---|---|---|
| `types.ts` | String unions + Uzbek label maps: `WorkspaceRole`, `CrmTemperature`, `CrmContactStatus`, `CrmContactSource`, `CrmTagOrigin`, `CrmStageKind`, `CrmAssignmentStrategy` / `Trigger`, `CrmActivityType` / `Actor`, `TimelineSourceTable`, `CrmBroadcastStatus`, `CrmRecipientStatus`, `IneligibilityReason` (+ `INELIGIBILITY_LABELS`); row interfaces `CrmContactSummary`, `CrmTagRow`, `CrmStageRow`, `CrmAssignmentRuleRow`. | Mirrors the planned columns; Prisma enums should use the same value names so rows are assignable without mapping. |
| `segments.ts` | `segmentFilterSchema` / `parseSegmentFilter` (zod, `{ v:1, all, any? }`), `FIELD_SPECS`, `compileSegmentWhere(filter, now)`, `describeFilter(filter, names?)`, `WINDOW_OPEN_MS`. | `CrmContact` with columns `score`, `temperature`, `status`, `language`, `source`, `instagramAccountId`, `assignedMemberId`, `phoneE164`, `email`, `lastInteractionAt`, `lastInboundAt`, `optedOutAt`, `customFields` (Json), relations `tags → CrmContactTag → tag (slug)` and `deals → CrmDeal (stageId, stage.pipelineId)`. |
| `broadcast-policy.ts` | `evaluateRecipient(input)` → `{ eligible, reason?, label?, snapshot }`, `summarizeEligibility(results)`, `isBroadcastWindowOpen`, `windowClosesAt`, `isUnderFrequencyCap`, `isActiveHandoff`, `OPT_OUT_WORDS` / `isOptOutMessage(text)`, `batchSize(throttlePerHour, intervalMinutes)`. | Per recipient: workspace `suspended`, `InstagramAccount.tokenStatus`, contact `lastInboundAt` / `optedOutAt`, last `CrmBroadcastRecipient.sentAt` for the contact, broadcast `frequencyCapHours`, `AiConversationState.handoffState`, whether a recipient row already exists. `snapshot` is JSON-ready for `CrmBroadcastRecipient.snapshot`. |
| `assignment-logic.ts` | `pickRule(rules, trigger, stageId?)`, `rulesFor`, `sortRules`, `chooseAssignee({ rule, candidates, cursor, context })` → `{ memberId, nextCursor, matchedKeyword? } \| null`, `roundRobin`, `assignmentPool`, `matchSpecialistKeyword`. | `CrmAssignmentRuleRow` (strategy, memberIds, productKeywords, priority, cursor, createdAt) and operators as `{ memberId, active }` in `createdAt` order. The caller persists `nextCursor` with `updateMany({ where: { id, cursor: old }, data: { cursor: nextCursor } })` and retries on a lost race. |
| `timeline-merge.ts` | `mergeTimeline(sources, { dedupeByMid })`, `pageByTime(items, before, limit)`, `TimelineItem`. | Each store is mapped to `TimelineItem` by the DB layer: `ConversationMessage` (mid, author → actorKind), `TriggerMessage` (mid, direction), `DmLog`, `Lead`, `LeadDelivery`, `InstagramEvent` (comments), `CrmActivity`. Same `mid` in two stores keeps the `ConversationMessage` copy. |
| `defaults.ts` | `DEFAULT_PIPELINE_NAME`, `DEFAULT_STAGES` (key / name / kind / isEntry / sort / color), `STAGE_KIND_TEMPERATURE` (WON → CUSTOMER, LOST → LOST), `DEFAULT_TAGS`, `tagSlug(name)`, `DEFAULT_BROADCAST`, `CRM_RECONCILE_INTERVAL_MS`. | Seeded lazily per workspace on the first CRM visit when no pipeline / tags exist. |
| `../workspace-permissions.ts` | `Permission`, `PERMISSION_MATRIX`, `can(role, permission)`, `permissionsOf`, `normalizeRole`, `isReadOnlyRole`, `canChangeRole`, `ROLE_LABELS`, `PERMISSION_LABELS`. | Takes the role as a string: Prisma's `WorkspaceRole` gains MANAGER / OPERATOR / VIEWER with the enum migration; `MEMBER` maps to OPERATOR, anything unknown to VIEWER. `lib/workspace-access.ts` is unchanged. |

## Permission matrix (TZ 53)

| Permission | OWNER | ADMIN | MANAGER | OPERATOR (= MEMBER) | VIEWER |
|---|---|---|---|---|---|
| manage_instagram | ✓ | ✓ | – | – | – |
| manage_campaigns | ✓ | ✓ | ✓ | – | – |
| view_contacts | ✓ | ✓ | ✓ | ✓ | ✓ |
| assign_leads | ✓ | ✓ | ✓ | ✓ (take / release own) | – |
| manage_billing | ✓ | – | – | – | – |
| manage_ai | ✓ | ✓ | ✓ | – | – |
| export_data | ✓ | ✓ | ✓ | – | – |
| view_analytics | ✓ | ✓ | ✓ | ✓ | ✓ |

`assign_leads` for an OPERATOR means the Telegram "Qabul qildim" / release
flow for themselves; reassigning someone else's lead is a MANAGER+ action the
DB layer checks with `canManageWorkspace` / `normalizeRole(role) === "MANAGER"`.
`isReadOnlyRole` is the single check for "403 on every write".

## Segment DSL

```json
{ "v": 1,
  "all": [
    { "field": "tag", "op": "eq", "value": "hot" },
    { "field": "phone_present", "op": "is_true" },
    { "field": "custom.city", "op": "eq", "value": "Toshkent" },
    { "field": "custom.course", "op": "contains", "value": "IELTS" } ],
  "any": [ { "field": "language", "op": "eq", "value": "uz" },
           { "field": "language", "op": "eq", "value": "ru" } ] }
```

Fields and operators (`FIELD_SPECS`): tag / not_tag (eq, in — tag slug),
score (eq, neq, gte, lte), temperature / status / language / source / account
(eq, neq, in), stage (eq, neq, in — `neq` = no deal in that stage), pipeline
(eq, in), assigned (is_true, is_false, eq, neq, in — member id), phone_present
/ email_present / window_open / opted_out (is_true, is_false),
last_interaction (within_days N or lte N = active in the last N days; gte N =
silent for N days), custom.<key> (eq, neq, in, gte, lte, contains, is_true,
is_false → Prisma JSON `path` filter). `window_open` compiles to
`lastInboundAt > now − (24h − 5 min)`, the same rule as the trigger engine's
`isWindowOpen`. Compile per request: the `where` freezes `now`.

## Broadcast eligibility (owner decision 2, Meta rules 2026-10-15)

Checked in this order, first failure is the stored reason: SUSPENDED →
TOKEN_BROKEN → NO_INBOUND → WINDOW_CLOSED → OPTED_OUT → FREQUENCY_CAP →
OPERATOR_ACTIVE (HANDOFF_PENDING or OPERATOR_ACTIVE, "Operator bilan
suhbatda") → DUPLICATE. Rate-limit results from `sendGuarded` are not an
eligibility reason: the DB layer re-schedules them. `batchSize(100)` = 8 per
5-minute tick (floor, so the throttle is never exceeded).

## Tests

`__tests__/crm-segments.test.ts`, `crm-broadcast-policy.test.ts`,
`crm-assignment.test.ts`, `crm-timeline.test.ts`,
`workspace-permissions.test.ts` (also covers `defaults.ts`).
