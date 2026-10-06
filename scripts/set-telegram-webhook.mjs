// Registers the Telegram bot webhook (run once after deploy, and whenever
// TELEGRAM_WEBHOOK_SECRET or NEXTAUTH_URL changes):
//   node --env-file=.env scripts/set-telegram-webhook.mjs
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const base = process.env.NEXTAUTH_URL;

if (!token || !secret || !base) {
  console.error("TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and NEXTAUTH_URL are required");
  process.exit(1);
}

const url = `${base.replace(/\/$/, "")}/webhooks/telegram/${secret}`;
const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url,
    secret_token: secret,
    allowed_updates: ["message", "callback_query", "my_chat_member"],
    drop_pending_updates: false,
  }),
});
const result = await response.json();
console.log(result.ok ? `Webhook set: ${base}/webhooks/telegram/<secret>` : result);
process.exit(result.ok ? 0 : 1);
