# lib/mcp — ETAP 12 MCP / AI control layer

Design, tools, auth, confirmation flow and limits: `docs/developer/etap-12-mcp.md`.
Endpoint: `app/api/mcp/route.ts` -> `http.ts`. Kill switch: `MCP_DISABLED=1` (`.env.example`).

| File | Job |
|---|---|
| `config.ts` | kill switch, limits (rate, body, TTL, caps), protocol versions |
| `http.ts` | HTTP edge: kill switch -> cheap size check -> auth -> streamed body cap -> JSON-RPC |
| `protocol.ts` | JSON-RPC 2.0 handler: initialize, notifications, ping, tools/list, tools/call |
| `auth.ts` | bearer token -> workspace + scope; hash lookup, constant-time compare, revoked / expired, 60 req/min |
| `tokens.ts` | create (raw value returned once), list, revoke (developer area) |
| `tools.ts` | registry: zod input schema (-> JSON Schema), scope, `run` or `propose` + `execute` |
| `confirm.ts` | propose -> confirm -> execute, single-use code, atomic claim, audit log reader |
| `service.ts` | workspace-scoped data layer over existing services (read views, previews, executors) |
| `errors.ts` | `McpServiceError`, safe messages (unknown errors are never echoed) |

## Rules for changes

1. **Tenant isolation first.** Every service function takes the token's `workspaceId` and passes it
   to an existing workspace-scoped service. Ids from the client are only ever looked up together with
   that workspaceId. Add no raw cross-workspace query. The isolation tests must stay green.
2. **Writes never execute in the tool.** A write tool is `propose` (validate, check ownership,
   build a preview, no side effect) + `execute` (runs only from `confirm_action`). Execute must
   re-validate the stored input and scope everything by the token's workspace.
3. **Read views are whitelists.** No phone / e-mail / Instagram ids / tokens / encrypted columns /
   platform-wide numbers (see `kpiView`, `listLeadsView`).
4. **No publish tools.** Flow publishing, unpublish, archive and delete are not available over MCP.
5. Secrets: the raw token, `tokenHash` and `confirmCodeHash` never go into a response, log line or
   error. `listActions` selects neither the hash nor the stored input.
6. Descriptions (LLM-facing) are English; previews / errors / results for people are Uzbek Latin.

## Limits that are per process

The per-token rate limiter (`auth.ts`) keeps its window in memory. With several web processes the
real ceiling is about N x 60 per minute; the confirmation and pending caps are database-backed.
