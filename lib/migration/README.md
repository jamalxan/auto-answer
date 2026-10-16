# lib/migration — ManyChat assisted migration (ETAP 11)

Design and decision: `docs/developer/etap-11-migration.md`. Kill switch `MIGRATION_DISABLED=1`
(connect / analyse / convert / import stop; reading and deleting a project still work).

ManyChat has no flow export and its Page API does not return flow contents, so a flow is a
checklist item until the owner pastes its text (or screenshots). Everything else (tags, custom
fields, bot fields, flow and growth-tool lists) is read automatically.

| File | Role |
|---|---|
| `config.ts` | switch, limits (`MAX_FLOW_TEXT` 12000, `MAX_SCREENSHOTS` 6, `MAX_SCREENSHOT_BYTES` 4 MB, 20 AI calls/hour) |
| `errors.ts` | `MigrationServiceError(status, uzbekMessage)` |
| `manychat-types.ts` | tolerant response shapes — UNVERIFIED against the live API, every field optional |
| `manychat-client.ts` | read-only client: fixed base URL, Bearer key, 8 req/s, 10 s timeout, 5xx x2 / 429 retry, no key in errors, injectable `fetchImpl` |
| `catalog.ts` | feature catalogue (SUPPORTED / PARTIAL / UNSUPPORTED, uz/ru/en patterns, Uzbek message + suggestion) |
| `analyzer.ts` | pure `analyzeFlowText(text)` → triggers, nodes, unsupported, notes, language |
| `mapping.ts` | pure: tag slugs, custom-field keys, bot-field variable keys, checklist, contact guidance |
| `converter.ts` | text → graph through the Flow Builder prompt + merge-field translation, audit, policy (preview only) |
| `importer.ts` | persistence helpers: views, idempotent item sync, tag/field imports, hourly counter |
| `limits.ts` | in-process guards: AI attempts floor, 2 concurrent AI calls, connect throttle |
| `service.ts` | workspace-scoped operations used by the routes, `run()` façade, zod schemas |

## Rules

- The ManyChat key is stored with `encryptToken`, shown only as its last 4 characters, and is never in any returned object, log or error.
- `analyzeProject` is idempotent on `(projectId, kind, sourceId)`: owner edits (mapping, status, text) survive, vanished items become SKIPPED with a note (imported ones only get the note).
- Custom fields need no table: the mapping on the item (`contact.customFields.<key>`, type) is the import; converted flows declare the fields they use as `vars.<key>`.
- Bot fields become `vars.<key>`; their value is injected as the template fallback (`{{vars.shop|Mebel Uz}}`) in converted flows.
- Screenshots are read by the vision model and dropped; only text is stored (<= 12000 chars).
- Conversion and screenshot reading are budget-gated, recorded as usage kind `javobai_migration` and limited to 20 calls per workspace per hour (both kinds count).
- `importFlow` creates a DRAFT flow (source AI, prompt = the pasted text, cut to the 2000 characters `createFlow` allows) and never publishes; AI versions still need test + approval in Flows.

## Limits and hardening

- Request bodies are read with `readJsonLimited` (lib/developer/migration-guard): the stream is counted and cut with 413 past the cap, whatever Content-Length says. Caps: 64 KB (connect, mapping patch, import-basics, analyze-text, convert), 1 MB (import with a graph), about 34 MB (flow text with screenshots).
- AI cap (20/hour/workspace) is checked against `LlmUsage` rows AND an in-process list of attempts of the last hour (a failed usage write still counts); at most 2 AI calls run at once per workspace. Residual bound: the in-process floor is per web process, so with N processes a burst can reach about N x 20 until the usage rows land.
- At most 5 migration projects per workspace (delete one to free a slot) and 3 ManyChat connect attempts per workspace per hour (failed ones count; in-process).
- `importFlow` claims the item first (`importClaimedAt`, stale after 5 minutes, released if creating the flow fails): of two parallel imports exactly one creates a Flow, the other gets 409.
- Duplicate ids (or equal name keys) inside one ManyChat snapshot keep the first row and note the dropped one; a unique violation on one row never aborts the sync.
- Pasted text is embedded between `"""`; runs of quote lookalikes are collapsed so it cannot close the block. Field / bot names and values are one line, no control characters, at most 120 characters.
- Provider errors never reach the client (generic Uzbek message, same status); the log has only the error class and HTTP status.
