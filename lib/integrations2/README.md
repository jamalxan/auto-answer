# Integrations 2.0 (ETAP 8) — pure logic

Design and owner decisions: `docs/developer/etap-8-integrations.md` (TZ 41–42, 63).

Everything in this folder is **schema-independent**: no Prisma, no Redis, no
queue, no outgoing request without an injected `fetchImpl`. The bus tables
(`OutboundEvent`, `OutboundDelivery`, `IntegrationSubscription`) and the new
`IntegrationType` values (WEBHOOK, GOOGLE_SHEETS, MAKE, ZAPIER) are added in a
later migration; until then the modules work on the explicit shapes in
`events.ts`, and the DB / worker layer (written later) maps rows onto them.
The existing lead pipeline (`lib/leads/delivery.ts`, TELEGRAM / AMOCRM /
BITRIX24) is not touched.

```
emit (app code, fire-and-forget like crmTouch)
   isOutboundBusEnabled() ─▶ dedupeKeyFor(type, subject…) ─▶ OutboundEvent { type, subject, dedupeKey } (payload null)
materialise (worker, MATERIALIZE_DELAY_MS later for lead events)
   DB loads lead / insight / contact / deal / handoff / broadcast ─▶ buildPayload(input) ─▶ freeze into OutboundEvent.payload
   for each active IntegrationSubscription of the event type:
     readSubscriptionFilter(row.filter) ─▶ matchesSubscription(filter, payload) ─▶ OutboundDelivery PENDING
deliver (worker, lease-claim + the LeadDelivery retry schedule)
   WEBHOOK / MAKE / ZAPIER  assertOutboundUrl(url) ─▶ buildWebhookRequest ─▶ sendWebhook(req, fetch) ─▶ classification
   GOOGLE_SHEETS            token cache miss ─▶ buildJwtAssertion ─▶ buildTokenRequest ─▶ parseTokenResponse
                            buildHeaderReadRequest (+ buildAddSheetRequest / buildHeaderWriteRequest once) ─▶ payloadToRow ─▶ buildAppendRequest
                            non-2xx ─▶ classifySheetsError
   TELEGRAM HOT             shouldSendHotCard(filter, payload) ─▶ buildHotLeadText ─▶ sendWithRetry
   outcome                  sent → SENT · retry → FAILED + nextAttemptAt (retryAfterMs or RETRY_DELAYS_MS) · dead → DEAD
                            dead_disable → DEAD + subscription.active = false · DEAD_AUTO_DISABLE consecutive DEAD → disable
   responseSnippet          maskSnippet(body) (phones masked, ≤ RESPONSE_SNIPPET_MAX)
```

| File | Exports | Notes |
|---|---|---|
| `config.ts` | `isOutboundBusEnabled()`, `OUTBOUND_EVENT_TYPES` + `OUTBOUND_EVENT_INFO` (Uzbek label / description), `INTEGRATION2_TYPES` + labels, `LEAD_PIPELINE_TYPES` / `isLeadPipelineType`, limits (`RETENTION_DAYS` 30, `DEFAULT_RATE_PER_MINUTE` 60, `DEAD_AUTO_DISABLE` 5, `MATERIALIZE_DELAY_MS` 3000, `RESPONSE_SNIPPET_MAX` 300, `WEBHOOK_TIMEOUT_MS`, `RETRY_AFTER_MAX_MS`, `SIGNATURE_TOLERANCE_SEC`, `SECRET_OVERLAP_HOURS`, `SHEETS_TOKEN_CACHE_SEC`). | `enqueueLeadDeliveries` must switch to the positive `LEAD_PIPELINE_TYPES` list (production guard). |
| `events.ts` | `outboundPayloadV1Schema` / `OutboundPayloadV1`, `dedupeKeyFor`, `buildPayload(input)`, input shapes `LeadLike` / `InsightLike` / `ContactLike` / `DealLike` / `HandoffLike` / `BroadcastLike`, `bandForScore` / `normalizeBand` / `DEFAULT_BAND_THRESHOLDS`, `maskSnippet` / `maskPhoneLike`, `sampleEvent(type)`. | Input shapes mirror `Lead`, `AiLeadInsight`, `CrmContact` (+ tag slugs, assignee), `CrmDeal` (+ names), `AiHandoff`, `CrmBroadcast`; pass the workspace `bandFor` from lib/javobai/scoring when its thresholds are customised. |
| `subscriptions.ts` | `subscriptionFilterSchema` / `SubscriptionFilter`, `readSubscriptionFilter`, `matchesSubscription(filter, payload)`, `describeFilter(filter, names?)`. | Test events are excluded unless `include_test`; a condition on a missing section fails. |
| `signing.ts` | `generateWebhookSecret`, `signPayload`, `verifySignature`, `signatureHeaders`, `parseSignatureHeader`, header name constants. | Rotation: store the old secret with an expiry (24h); pass it as `previousSecret` so both signatures are sent. |
| `url-policy.ts` | `assertOutboundUrl(url, { resolve?, allowHosts?, denyHosts? })`, `readAllowHosts` / `readDenyHosts` (env `OUTBOUND_WEBHOOK_ALLOW_HOSTS` / `OUTBOUND_WEBHOOK_DENY_HOSTS`), `hostMatches`, `presetHint(url, preset)`, `URL_POLICY_REASONS`. | Run at save **and** before every send. Uses `isInternalHostname` / `isPrivateAddress` from `lib/integrations/net.ts`. |
| `connectors/webhook-request.ts` | `buildWebhookRequest`, `classifyWebhookResponse`, `parseRetryAfter`, `sendWebhook(req, fetchImpl)`. | The request owns a 10 s abort timer; call `req.release()` if you do not go through `sendWebhook`. |
| `connectors/sheets-auth.ts` | `parseServiceAccountJson`, `buildJwtAssertion`, `buildTokenRequest`, `parseTokenResponse`, `tokenCacheKey`, `parseSpreadsheetId`, `sheetRange`, `buildAppendRequest`, `buildHeaderReadRequest`, `buildHeaderWriteRequest`, `buildAddSheetRequest`, `classifySheetsError`. | Store `client_email` + `private_key` with `encryptCredentials`; cache the token in Redis under `tokenCacheKey(integrationId)` for `SHEETS_TOKEN_CACHE_SEC`. |
| `connectors/sheets-rows.ts` | `SHEET_HEADERS` (v1, frozen), `payloadToRow`, `headersMatch`, `formatTashkent`, `DEFAULT_SHEET_NAME`. | One tab per workspace, append-only. |
| `connectors/telegram-hot-text.ts` | `buildHotLeadText(payload)`, `shouldSendHotCard(filter, payload)`, `esc`. | TZ 41.1 card; the production lead card in `lib/telegram/lead-message.ts` is unchanged. |
| `payload-preview.ts` | `previewPayload(input)`, `previewSample(type)`. | Developer UI Events tab. |

## Payload v1

```json
{
  "id": "evt_…", "type": "lead.created", "version": 1,
  "occurred_at": "2026-10-16T09:05:00.000Z", "is_test": false,
  "workspace": { "id": "…", "name": "…" },
  "account": { "id": "…", "username": "…" },
  "lead": { "id", "name", "phone", "ig_username", "ig_user_id", "product", "summary", "extra_field",
            "is_repeat", "created_at", "conversation_id", "conversation_url" },
  "score": { "value": 72, "temperature": "HOT", "band": "hot", "signals": [{ "signal": "phone_provided", "points": 30 }] },
  "source": { "kind": "campaign", "channel": "ad", "campaign", "keyword", "ad_id", "ref" },
  "contact": { "id", "status", "tags": ["…"], "assigned_member": { "id", "name" } },
  "deal": { "id", "pipeline", "stage", "stage_id", "from_stage" },
  "extra": { "email", "budget", "location" },
  "handoff": { "id", "reason", "state", "opened_at" },
  "broadcast": { "id", "name", "sent", "failed", "skipped", "completed_at" },
  "transcript": "only with include_transcript"
}
```

Sections that do not apply are `null`. `phone` is the full E.164 (owner
decision). `sampleEvent(type)` returns a complete example per type.

Dedupe keys (`OutboundEvent.dedupeKey`, unique per workspace):
`lead.created:<leadId>`, `lead.hot:<leadId>`, `lead.updated:<leadId>:<updatedAt>`,
`contact.tagged:<contactId>:<slug>`, `deal.stage_changed:<dealId>:<stageId>:<changedAt>`,
`handoff.opened:<handoffId>`, `broadcast.completed:<broadcastId>`.

## Webhook headers

```
Content-Type: application/json; charset=utf-8
User-Agent: SocialAuto-Webhooks/1.0
X-SocialAuto-Event: lead.created
X-SocialAuto-Event-Id: <OutboundEvent.id>
X-SocialAuto-Delivery-Id: <OutboundDelivery.id>
X-SocialAuto-Timestamp: <unix seconds>
X-SocialAuto-Signature: v1=<hex hmac-sha256(secret, timestamp + "." + rawBody)>[,v1=<old secret>]
```

Responses: 2xx → SENT · 408 / 425 / 429 / 5xx / network error → retried
(`Retry-After` honoured up to 6h) · 410 → DEAD and the subscription is
disabled · other 4xx and 3xx → DEAD (redirects are never followed).
Deliveries are retried, so receivers must treat `X-SocialAuto-Event-Id` as
idempotent.

### Receiver verification — Node

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySocialAuto(req, rawBody, secret, toleranceSec = 300) {
  const ts = req.headers["x-socialauto-timestamp"];
  const header = req.headers["x-socialauto-signature"] ?? "";
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  return header
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("v1="))
    .some((s) => {
      const got = Buffer.from(s.slice(3), "hex");
      return got.length === 32 && timingSafeEqual(got, Buffer.from(expected, "hex"));
    });
}
// express: app.post("/hook", express.raw({ type: "*/*" }), (req, res) => {
//   if (!verifySocialAuto(req, req.body.toString("utf8"), process.env.SA_SECRET)) return res.sendStatus(401);
//   const event = JSON.parse(req.body); /* dedupe on event.id */ res.sendStatus(200);
// });
```

### Receiver verification — PHP

```php
<?php
function verify_socialauto(string $rawBody, string $secret, int $tolerance = 300): bool {
    $ts = $_SERVER['HTTP_X_SOCIALAUTO_TIMESTAMP'] ?? '';
    $header = $_SERVER['HTTP_X_SOCIALAUTO_SIGNATURE'] ?? '';
    if ($ts === '' || abs(time() - (int)$ts) > $tolerance) return false;
    $expected = hash_hmac('sha256', $ts . '.' . $rawBody, $secret);
    foreach (explode(',', $header) as $part) {
        $part = trim($part);
        if (str_starts_with($part, 'v1=') && hash_equals($expected, substr($part, 3))) return true;
    }
    return false;
}
$raw = file_get_contents('php://input');
if (!verify_socialauto($raw, getenv('SA_SECRET'))) { http_response_code(401); exit; }
$event = json_decode($raw, true); // dedupe on $event['id']
http_response_code(200);
```

Rotation: the dev UI generates a new `whsec_…`, keeps the old one for 24h;
during that window every delivery carries two `v1=` values, so a receiver
updated at any point in the window keeps verifying.

## Google Sheets

Tenant service account (Google Cloud → IAM → Service accounts → Keys → JSON)
pasted once, stored encrypted. The sheet owner shares the spreadsheet with
`client_email` as Editor; a 403 surfaces exactly that hint with the address.
Token: RS256 JWT (`buildJwtAssertion`) → `oauth2.googleapis.com/token` →
cached ~50 min. First append per tab reads row 1; if it is not
`SHEET_HEADERS` the tab is created (`buildAddSheetRequest`) and the header
row written (`buildHeaderWriteRequest`). Rows are RAW strings, dates in
`+05:00`, booleans `ha` / `yo'q`, tags joined by `, `.

## DB / worker layer (ETAP 8, built on the pure modules above)

| File | Role |
|---|---|
| `emit.ts` | `emitOutbound` (fire-and-forget, dedupe, kill switch) + the hook-site helpers `emitLeadCreated` / `emitLeadHot` / `emitHandoffOpened` / `emitContactTagged` / `emitBroadcastCompleted`. |
| `queue.ts` / `worker.ts` | BullMQ queue `integrations` (materialize + deliver jobs, deterministic ids), `createIntegrationsWorker`, `runIntegrationsMaintenance` (due sweep, lost materialise jobs, hourly retention). |
| `materialize.ts` | Loads the subject, builds + freezes the payload, matches subscriptions, creates `OutboundDelivery` rows; the lead.hot rule. |
| `deliver.ts` | Lease-claim, retry schedule, DEAD, alert throttle, rate limit, redeliver per delivery / event / all DEAD, BROKEN hold + resume. |
| `connectors/` | `index.ts` registry; `webhook.ts` (WEBHOOK / MAKE / ZAPIER), `sheets.ts`, `telegram-hot.ts`, `enrich-amo.ts` / `enrich-bitrix.ts` (+ `enrichment.ts`), contract in `types.ts`. |
| `crm-listener.ts` | `registerCrmListener` for `score.becameHot` → lead.hot and `stage_changed` → deal.stage_changed (registered by the worker). |
| `service.ts` | The developer API's rules (create / edit / test / subscriptions / enrichment / deliveries); routes in `app/api/connectors`. |
| `secrets.ts` / `kv.ts` | Encrypted credentials + rotation overlap; Redis key/value with a memory fallback (token cache, rate window, alert throttle). |

Hook sites in production code (each one `void emit…(…)` line): `lib/leads/service.ts` (lead.created, also the test lead),
`lib/javobai/handoff.ts openHandoff`, `lib/crm/tags.ts addTag`, `lib/crm/broadcast.ts` (COMPLETED). Production guards:
`enqueueLeadDeliveries` uses `LEAD_PIPELINE_TYPES`; `checkIntegration` sends bus-only types to the connector registry;
`/api/integrations` and the assistant overview list only the lead-pipeline types.
