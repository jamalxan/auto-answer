# ETAP 12 — MCP / AI control layer (developer area)

Master TZ: sections 59 and 63 (ETAP 12). Built at `/developer/mcp`, endpoint `POST /api/mcp`.
Kill switch `MCP_DISABLED=1`.

## What it is

An MCP server (Model Context Protocol, Streamable HTTP, JSON responses) that lets Claude Desktop,
Claude Code, ChatGPT-style clients or any MCP client read a workspace and propose changes to it.
Reading is immediate. **Every write is two steps**: the tool returns a PREVIEW and a one-time code;
nothing happens until `confirm_action` is called with that code.

No MCP SDK is installed and none was added: the minimal protocol is implemented by hand
(`lib/mcp/protocol.ts`): `initialize`, `notifications/initialized`, `ping`, `tools/list`,
`tools/call`. Protocol versions `2025-03-26` (default) and `2024-11-05` are negotiated at
`initialize`. POST only, JSON responses only, no sessions, no SSE, no server-initiated requests,
JSON-RPC batches are refused (-32600). `GET` and `DELETE` answer 405 JSON.

## Auth

- Bearer token `sa_mcp_<32 random chars>` (`Authorization: Bearer ...`), created only in
  `/developer/mcp` by a workspace OWNER / ADMIN. Scope `READ` or `WRITE` (WRITE includes READ).
- Only `sha256(token)` and the last 4 characters are stored (`McpToken`). The raw token is in the
  creation answer once, never in a list, log or later response.
- Lookup is by the unique hash (the secret itself is never compared), then the stored hash is
  compared in constant time. Revoked and expired tokens are refused with a specific Uzbek message.
- The token fixes the workspace; no tool takes a workspace id from the client.
- Rate limit: 60 requests per rolling minute per token (429 + `Retry-After`). It is per server
  process (like the other in-process guards); with N web processes the bound is about N x 60.
- The route is not behind the developer login or the app session: the token is the credential.
  `proxy.ts` only guards listed page prefixes, so `/api/mcp` needs no exemption (same as
  `/api/webhooks`). No CORS headers are sent; bearer tokens are not ambient credentials.

## Tools

READ (scope READ; all strictly scoped to the token's workspace through existing services):

| Tool | Reuses | Notes |
|---|---|---|
| `list_campaigns`, `get_campaign` | `lib/triggers/comment-service` | comment-to-DM campaigns; the hidden proxy rows of published flows are not shown |
| `list_flows`, `get_flow` | `lib/flows/service` | get_flow returns a graph SUMMARY (trigger, node counts, message texts) + audit / policy findings |
| `list_leads` | `lib/crm/contacts` | filters stage / tag / search / since / until / limit <= 50 / cursor. Fields: id, name, username, stage, tags, lastMessageAt, temperature. No phone, e-mail, Instagram ids or custom fields; search matches name and username only (never phone) |
| `get_analytics_summary` | `lib/analytics/read` | tab campaign / ai / sales / funnel, period today / 7d / 30d, previous-period comparison |
| `get_kpi` | `lib/analytics/kpi` | `queueDepths` (platform-wide) is removed |
| `list_instagram_accounts` | `lib/foundation/connections` | status and token expiry; never the token |
| `run_diagnostics` | `lib/foundation/diagnostics` | connection, token expiry, queue, worker, webhook, AI |
| `generate_report` | `lib/analytics/read` | plain Uzbek text for a period |
| `search_knowledge_base` | `lib/javobai/knowledge` | the business profile / products / FAQ the AI answers from |

WRITE (scope WRITE; never execute directly):

| Tool | What it does after confirmation |
|---|---|
| `create_keyword_campaign` | comment campaign: keywords -> optional public comment replies + DM. Created PAUSED. `publish: true` makes it live only if the Instagram connection is healthy, otherwise it stays a draft and the result says why |
| `update_campaign` | rename, keywords, DM text, public replies, pause / resume (`active`); resuming needs a healthy connection |
| `pause_campaign` | pause, nothing deleted |
| `create_flow_draft` | from a description (AI Flow Builder) or a ready graph: validate + audit + policy, saved as DRAFT with source AI. The preview shows the graph summary and findings |
| `add_lead_tag` | tag a lead (tag is created if missing; origin AI) |
| `set_lead_stage` | NEW / ACTIVE / CUSTOMER / LOST / ARCHIVED, with a CRM activity row |
| `confirm_action`, `reject_action` | settle a proposal |

**Not available over MCP, on purpose:** publishing a flow (and unpublish / archive / delete of
anything). AI-made versions need a sandbox test and an approval, which only a person can do in the
Flows screen. The tool list is checked by a test to contain no publish tool.

Descriptions and schemas are English (LLM-facing; JSON Schema is generated from the zod input
schemas, with `readOnlyHint` annotations). Previews, errors and results meant for people are Uzbek
Latin. A tool failure is a result with `isError: true` (the model can read it); protocol problems
are JSON-RPC errors (-32700 / -32600 / -32601 / -32602).

## Confirmation flow

```
write tool  --validate, check ids belong to the token's workspace-->  McpAction PROPOSED
            <-- { status: "PREVIEW", actionId, preview, confirmCode, expiresAt (10 min) } --
(person reads the preview)
confirm_action { actionId, confirmCode }
   1. action must belong to the SAME token and workspace (else "not found")
   2. status PROPOSED and not expired (else already-done / expired; expired rows become EXPIRED)
   3. sha256(actionId + code) must match (else 403; the action is NOT burned)
   4. updateMany(status PROPOSED, not expired -> CONFIRMED) must hit exactly one row
      (this is what makes a double confirm / Promise.all run the action once)
   5. execute -> EXECUTED + result, or FAILED + safe Uzbek error
reject_action { actionId } -> REJECTED (conditional; same token only)
```

- The code is 8 characters (32-letter alphabet, shown `XXXX-XXXX`), case and dash insensitive,
  stored only as `sha256(actionId:code)` and cleared once the action is settled.
- A preview has no side effect (a test compares the write log). What was previewed is what is
  executed: the validated input (for flow drafts, the exact graph) is stored with the proposal and
  the AI model is not called again at confirm.
- Max 20 unsettled proposals per token. Revoking a token rejects its open proposals.
- `McpAction` is the audit log (tool, input, preview, status, result / error, timestamps). Executed
  and failed actions also write an `OperationalEvent` line (source SYSTEM) — the platform's only
  existing audit-style log; there is no separate tenant audit table.
- An unexpected error is logged as class name + status only and shown as a generic Uzbek message
  (no stack, no connection strings).

## Limits

| What | Value |
|---|---|
| Body | 256 KB, counted while streaming (a spoofed `Content-Length` or a chunked upload still gets 413) |
| Rate | 60 requests / minute / token |
| Confirmation window | 10 minutes |
| Unsettled proposals | 20 / token |
| Active tokens | 10 / workspace |
| List tools | `limit` <= 50 |
| Tool answer | cut at 60 000 characters |
| Kill switch | `MCP_DISABLED=1` -> `/api/mcp` 503; tokens can still be listed and revoked, new ones cannot be created |

## Data model (new tables only)

`McpToken` (workspace, name, `tokenHash` unique, `tokenHint`, scope READ | WRITE, createdByUserId,
lastUsedAt, revokedAt, expiresAt) and `McpAction` (workspace, token, tool, input, preview, status
PROPOSED | CONFIRMED | EXECUTED | REJECTED | EXPIRED | FAILED, confirmCodeHash, expiresAt, result,
error, createdAt, resolvedAt). Migration `20261023100000_mcp_etap12` (additive).

## Developer UI (`/developer/mcp`)

Tokens (create with name / scope / expiry, raw token shown once with copy buttons and the connection
snippets for Claude Code, Claude Desktop (via `mcp-remote`) and ChatGPT-style clients; list with last
4 characters, last used, revoke with inline confirmation), action log with status and tool filters,
"try it" (a real `tools/list` call to `/api/mcp` with a pasted token), and the tool list. Tokens are
bound to the workspace you are signed in to; switch workspace in the app to manage another one.
Creating and revoking need OWNER / ADMIN; every role can read.

## Decisions and known gaps

- **Campaigns = comment campaigns** (the Comment Automation 2.0 engine, `TriggerCampaign`). Story /
  Direct trigger campaigns and legacy `Automation` rows are not exposed yet.
- **Publish checks for campaigns:** comment campaigns have no audit / policy engine of their own
  (that exists for flows). The MCP "publish" therefore applies the account-connection check plus the
  campaign service's own validation (Meta length limits, keyword rules) and warns about keyword
  overlap with other active campaigns. Flow publishing stays in the Flows screen.
- **ChatGPT:** clients that only support OAuth (remote MCP connectors that require OAuth discovery)
  cannot connect with a static bearer token. OAuth is not implemented in this etap.
- Rate limit and the pending counter are per server process (documented above).
- Instagram login / OAuth flows, token-less access and cross-workspace "agency" tokens are out of
  scope: one token = one workspace.
