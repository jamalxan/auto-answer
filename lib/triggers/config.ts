/**
 * Instagram Trigger Engine — dev-mode switches.
 *
 * The engine is not part of the product yet. Two things keep it invisible:
 *
 *  - The UI and API live in the developer area (/developer/triggers,
 *    /api/developer/triggers) behind its own login (lib/developer/auth).
 *    Everyone else gets a 404.
 *  - Webhook events are stored only for Instagram accounts that already have
 *    a trigger campaign, and only the developer can create one. Every other
 *    account's webhooks pass through the engine untouched.
 *
 * TRIGGER_ENGINE_DISABLED=1 is the kill switch: no ingestion, no worker.
 */

export function isTriggerEngineEnabled(): boolean {
  const flag = (process.env.TRIGGER_ENGINE_DISABLED ?? "").trim().toLowerCase();
  return !(flag === "1" || flag === "true" || flag === "yes");
}
