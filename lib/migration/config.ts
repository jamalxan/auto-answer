/**
 * ETAP 11 — ManyChat assisted migration: switches and limits.
 *
 * MIGRATION_DISABLED=1 is the kill switch: connect / analyze / mapping /
 * conversion / import stop (reading a project and deleting it, which wipes
 * the stored ManyChat key, always work).
 */

export function isMigrationEnabled(): boolean {
  const flag = (process.env.MIGRATION_DISABLED ?? "").trim().toLowerCase();
  return !(flag === "1" || flag === "true" || flag === "yes");
}

/** Pasted flow text stored per item (characters). */
export const MAX_FLOW_TEXT = 12000;
/** Screenshots per flow; read by the vision model, never stored. */
export const MAX_SCREENSHOTS = 6;
/** One screenshot, decoded bytes. */
export const MAX_SCREENSHOT_BYTES = 4_000_000;
/** AI calls (conversion + screenshot reading) per workspace per rolling hour. */
export const CONVERSIONS_PER_HOUR = 20;
/** Usage kind of every migration LLM call (lib/javobai/usage). */
export const USAGE_KIND_MIGRATION = "javobai_migration" as const;
/** Items per project are capped so a huge ManyChat page cannot flood the table. */
export const MAX_ITEMS_PER_KIND = 500;
/** Migration projects per workspace (deleting one frees a slot). */
export const MAX_PROJECTS_PER_WORKSPACE = 5;
/** ManyChat connect attempts (valid or not) per workspace per rolling hour. */
export const CONNECTS_PER_HOUR = 3;
/** AI calls running at the same moment per workspace (per server process). */
export const MAX_CONCURRENT_AI_CALLS = 2;
