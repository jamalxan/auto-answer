/**
 * Instagram Trigger Engine — dev-mode switches.
 *
 * The engine is not part of the product yet. Two things keep it invisible:
 *
 *  - The UI and API answer only for emails in TRIGGER_ENGINE_DEV_EMAILS
 *    (falls back to ADMIN_EMAILS). Everyone else gets a 404.
 *  - Webhook events are stored only for Instagram accounts that already have
 *    a trigger campaign, and only dev users can create one. Every other
 *    account's webhooks pass through the engine untouched.
 *
 * TRIGGER_ENGINE_DISABLED=1 is the kill switch: no ingestion, no worker.
 */

function parseEmails(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function isTriggerEngineEnabled(): boolean {
  const flag = (process.env.TRIGGER_ENGINE_DISABLED ?? "").trim().toLowerCase();
  return !(flag === "1" || flag === "true" || flag === "yes");
}

export function isTriggerDevEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const explicit = parseEmails(process.env.TRIGGER_ENGINE_DEV_EMAILS);
  const allowed = explicit.length > 0 ? explicit : parseEmails(process.env.ADMIN_EMAILS);
  return allowed.includes(email.toLowerCase());
}
