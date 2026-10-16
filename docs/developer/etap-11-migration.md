# ETAP 11 — ManyChat migration (developer area)

Master TZ: section 58 and 63 (ETAP 11). Built at `/developer/migration`.
Kill switch `MIGRATION_DISABLED=1`.

## What is and is not possible (verified 2026-10-17)

ManyChat has **no flow export/import format** (community moderators say the
feature does not exist) and its public Page API cannot read flow contents:

| Object | Via ManyChat API | Migration approach |
|---|---|---|
| Tags | list (`getTags`) | imported automatically → CRM tags |
| Custom user fields | list (`getCustomFields`, with types) | imported as a mapping to contact custom fields / flow variables |
| Bot (global) fields | list with values | imported as flow variables with their values |
| Flows | list only: `ns` (id), name, folder | imported as a **checklist**; contents are NOT available |
| Growth tools | list only | checklist (rules/keywords are NOT exposed) |
| Keyword / comment-automation rules | no endpoint | entered by hand or described in the flow text |
| Subscribers | read | **not migrated**: Instagram contacts must opt in again on a new account; the wizard explains how (ig.me link with `ref`, comment/story triggers) |

The TZ's "Upload / Connect → Analyze → Mapping → Preview → Warnings → Import →
Test → Activate" is therefore realised as **assisted migration**.

## Decision (owner, 2026-10-17)

Assisted migration with API + AI: connect the ManyChat API key → tags, fields,
bot fields and the flow list are read automatically → for each flow the owner
pastes its text (or uploads screenshots) → the AI Flow Builder (ETAP 7) turns
it into a SocialAuto flow → audit (TZ 40) + policy (TZ 55) → sandbox test →
publish through the normal Flows screen. Unsupported elements are always
listed explicitly.

## Pipeline (TZ 58 mapped)

1. **Connect** — API key (Settings → API in ManyChat), stored encrypted, never
   returned; only `api.manychat.com` is ever called; reads only; ≤ 10 req/s.
2. **Analyze** — page info, tags, custom fields, bot fields, flow list,
   growth tools; counts + what is automatic vs manual.
3. **Mapping** — tags → CRM tags (name/slug, merge on conflict); custom fields →
   `contact.customFields` keys (type shown); bot fields → flow variables with
   default values; flows → "to convert" items.
4. **Preview** — per item: what will be created, what is unsupported.
5. **Warnings** — a catalogue of ManyChat features with no SocialAuto
   equivalent (Messenger / WhatsApp / Telegram channels, payments, external
   request steps, Smart Delay variants, sequences, AI steps of ManyChat,
   Live Chat, sharing flows, …) detected in the pasted text and listed per flow.
6. **Import** — tags and variables are created; each flow becomes a DRAFT flow
   (source AI) with a link to its audit/policy result. Nothing is published.
7. **Test** — the existing Flows sandbox console.
8. **Activate** — publish via Flows (AI versions require test + approval).

## Flow text → graph

Input per flow: pasted text (steps, messages, buttons, conditions, delays,
actions in any order/format) and/or up to 6 screenshots. Screenshots are read
by the vision model and reduced to text; **images are never stored**, only the
extracted text. The text is analysed for ManyChat vocabulary (pure analyser:
trigger kinds, node kinds, unsupported features), then sent with the node
schema and few-shot examples to the AI builder. The result is validated
(zod), repaired once, audited and policy-checked; the user sees the graph,
the findings and the list of manual follow-ups before it is saved as a draft.
Budget-gated, usage recorded as `javobai_migration`.

## Data model (new tables only)

`MigrationProject` (workspace, source MANYCHAT, status, encrypted API key,
page snapshot, counters) and `MigrationItem` (kind TAG / CUSTOM_FIELD /
BOT_FIELD / FLOW / GROWTH_TOOL, source id/name/folder, status, mapping,
pasted source text, warnings, converted flow id).

## Sub-phases

| Phase | Scope | Done when |
|---|---|---|
| 11.0 | ManyChat client, analyser, mapping, import of tags / fields / variables, checklist, wizard | a test page's tags and fields appear in SocialAuto; flow list is a checklist |
| 11.1 | flow text/screenshot → graph, warnings, draft import | a pasted ManyChat flow becomes a valid draft with audit + policy and an explicit unsupported list |
