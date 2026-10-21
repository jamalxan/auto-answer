# lib/mcp — ETAP 12 MCP / AI control layer

Design, tools, auth, confirmation flow and limits: `docs/developer/etap-12-mcp.md`.
Endpoint: `app/api/mcp/route.ts` -> `http.ts`. OAuth: `app/.well-known/*`, `app/api/mcp/oauth/*`,
`app/developer/(consent)/mcp/authorize`. Kill switch: `MCP_DISABLED=1` (`.env.example`).

| File | Job |
|---|---|
| `config.ts` | kill switch, limits (rate, body, TTL, caps), protocol versions |
| `http.ts` | HTTP edge: kill switch -> cheap size check -> auth -> streamed body cap -> JSON-RPC |
| `protocol.ts` | JSON-RPC 2.0 handler: initialize, notifications, ping, tools/list, tools/call |
| `auth.ts` | bearer token -> workspace + scope; hash lookup, constant-time compare, revoked / expired, 60 req/min |
| `tokens.ts` | create (raw value returned once), list (with `source` OAUTH / MANUAL), revoke (developer area; also clears the refresh token) |
| `oauth.ts` | OAuth 2.1 for MCP clients: RFC 9728 / 8414 metadata, RFC 7591 registration, PKCE authorization codes (single use, replay revokes), token + refresh rotation, per-IP throttles |
| `oauth-http.ts` | HTTP side of `/api/mcp/oauth/register`, `/api/mcp/oauth/token` and the `/.well-known` documents (CORS on metadata only) |
| `oauth-actions.ts` | the consent screen's approve / deny server actions (`/developer/mcp/authorize`): developer login + app session + OWNER / ADMIN |
| `tools.ts` | registry: zod input schema (-> JSON Schema), scope, `run` or `propose` + `execute` |
| `confirm.ts` | cheap pre-checks (pending cap, AI-builder budget), propose -> confirm -> execute, human approval (`requireHumanApproval`, `approveActionAsDeveloper`), single-use code + 5-attempt cap, atomic claim, pruning, audit log reader |
| `service.ts` | workspace-scoped data layer over existing services (read views, previews, executors) |
| `errors.ts` | `McpServiceError`, safe messages (unknown errors are never echoed) |

## Rules for changes

1. **Tenant isolation first.** Every service function takes the token's `workspaceId` and passes it
   to an existing workspace-scoped service. Ids from the client are only ever looked up together with
   that workspaceId. Add no raw cross-workspace query. The isolation tests must stay green.
2. **Writes never execute in the tool, and nothing over MCP reaches customers.** A write tool is `propose` (validate, check ownership,
   build a preview, no side effect) + `execute` (runs only from `confirm_action`). Execute must
   re-validate the stored input and scope everything by the token's workspace.
3. **Read views are whitelists.** No phone / e-mail / Instagram ids / tokens / encrypted columns /
   platform-wide numbers (see `kpiView`, `listLeadsView`).
4. **No go-live tools.** Flow publishing, switching a campaign on (`publish` / `active`), approving reply
   texts, unpublish, archive and delete are not available over MCP. Campaigns are created paused with
   unapproved variants; reply text of an ACTIVE campaign is not editable. `create_keyword_campaign` /
   `update_campaign` schemas are `.strict()`: a stray `publish` / `active` is an error.
5. Secrets: the raw token, `tokenHash` and `confirmCodeHash` never go into a response, log line or
   error. `listActions` selects neither the hash nor the stored input.
6. Descriptions (LLM-facing) are English; previews / errors / results for people are Uzbek Latin.
7. **User-originated text is `untrusted`.** Lead names / usernames, message and comment texts, flow
   message texts and KB lines are returned only under an `untrusted` key; tools returning them say so in
   their description (`UNTRUSTED_NOTE` in `config.ts`). In previews, splice names only through
   `quote()` (`service.ts`).
8. **Human approval is the default.** `confirm_action` for a token with `requireHumanApproval` must keep
   answering "inson tasdig'i kerak" and leave the action PROPOSED; the developer approve route runs the
   stored input. Do not add a path that executes without the claim in `confirm.ts`.
9. Cheap checks (`assertCanPropose`, `assertFlowGenerationBudget`) run in `protocol.ts` BEFORE `propose`,
   so a flooded token never reaches the paid AI builder.

## Limits that are per process

The per-token rate limiter, the invalid-token IP limiter (`auth.ts`) and the in-memory floor of the AI-builder limit (`confirm.ts`) keep their windows in memory. With several web processes the
real ceiling is about N x 60 per minute; the confirmation and pending caps are database-backed.
