/**
 * Real-time end-to-end check of the lead assistant against a REAL Postgres,
 * Redis and BullMQ worker. Only the external HTTP APIs (Instagram, Telegram,
 * amoCRM, Bitrix24, LLM) are replaced by an in-process fake.
 *
 *   npx tsx --env-file=.env scripts/e2e-assistant.ts
 *
 * Seeds a throw-away workspace and deletes it at the end.
 */

import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { encryptToken } from "@/lib/meta/oauth";
import { encryptCredentials } from "@/lib/integrations/crypto";
import { createAssistantWorker } from "@/lib/queue/assistant-worker";
import { getAssistantQueue } from "@/lib/queue/assistant-queue";
import { getRedisConnection } from "@/lib/queue/client";
import { POST as webhookPost } from "@/app/api/webhook/route";
import { resumeIntegration } from "@/lib/leads/delivery";

process.env.FACEBOOK_APP_SECRET ??= "e2e-secret";
process.env.INSTAGRAM_APP_ID ??= "own-app";
process.env.TELEGRAM_BOT_TOKEN = "e2e:token";
process.env.LLM_PROVIDER = "anthropic";
process.env.LLM_API_KEY = "e2e";

// ─── Fake external world ───────────────────────────────────────────────────────

const igSends: string[] = [];
const tgSends: string[] = [];
const amoRequests: string[] = [];
const bitrixCalls: string[] = [];
let amoTokenValid = false;
let midSeq = 0;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const body = init?.body ? String(init.body) : "";

  if (url.includes("graph.instagram.com")) {
    if (url.includes("/messages")) {
      const parsed = JSON.parse(body);
      if (parsed.message?.text) {
        igSends.push(parsed.message.text);
        return json({ recipient_id: "cust1", message_id: `mid-${++midSeq}` });
      }
      return json({ recipient_id: "cust1" }); // sender_action
    }
    return json({ name: "Aziz Karimov", username: "aziz_ig" });
  }

  if (url.startsWith("https://api.telegram.org")) {
    const method = url.split("/").pop();
    if (method === "sendMessage") {
      tgSends.push(JSON.parse(body).text);
      return json({ ok: true, result: { message_id: 100 + tgSends.length } });
    }
    return json({ ok: true, result: {} });
  }

  if (url.includes("amocrm.ru")) {
    amoRequests.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    if (!amoTokenValid) return json({}, 401);
    if (url.includes("/contacts?query=")) return new Response(null, { status: 204 });
    if (url.endsWith("/leads/complex")) return json([{ id: 777 }]);
    return json([{ id: 1 }]);
  }

  if (url.includes("bitrix24")) {
    const method = new URL(url).pathname.split("/").pop()!.replace(".json", "");
    bitrixCalls.push(method);
    if (method === "crm.duplicate.findbycomm") return json({ result: [] });
    if (method === "crm.lead.add") return json({ result: 555 });
    return json({ result: 1 });
  }

  if (url.includes("api.anthropic.com")) {
    const request = JSON.parse(body);
    const last = request.messages.at(-1).content as string;
    const reply = /divan/i.test(last)
      ? "Assalomu alaykum! Ha, divanlarimiz bor. Qaysi turini qidiryapsiz?"
      : /narx|price/i.test(last)
        ? "Divan 4 500 000 so'm turadi."
        : "Tushundim. Menejerimiz batafsil aytadi. Ismingiz va raqamingizni qoldirasizmi?";
    return json({
      content: [
        {
          type: "tool_use",
          input: {
            reply,
            extracted: { name: /Aziz/.test(last) ? "Aziz" : null, product_interest: /divan/i.test(last) ? "divan" : null, extra_field: null },
            intent: "other",
            language: "uz_latn",
            summary: "Mijoz divan so'radi, raqam qoldirdi.",
            unknown_question: null,
          },
        },
      ],
      usage: { input_tokens: 200, output_tokens: 50 },
    });
  }

  return realFetch(input, init);
}) as typeof fetch;

// ─── Helpers ───────────────────────────────────────────────────────────────────

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${ok || !detail ? "" : `  -> ${detail}`}`);
  if (!ok) failures++;
}

async function waitFor<T>(fn: () => Promise<T | null | false | undefined>, ms = 25_000, label = "condition"): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`  (timeout waiting for ${label})`);
  return null;
}

async function sendWebhook(messaging: unknown) {
  const raw = JSON.stringify({ object: "instagram", entry: [{ id: IG_ID, time: Date.now(), messaging: [messaging] }] });
  const signature = "sha256=" + createHmac("sha256", process.env.FACEBOOK_APP_SECRET!).update(raw).digest("hex");
  const response = await webhookPost(
    new NextRequest("http://localhost/api/webhook", { method: "POST", body: raw, headers: { "x-hub-signature-256": signature } })
  );
  return response.status;
}

const customerSays = (text: string) =>
  sendWebhook({ sender: { id: "cust1" }, recipient: { id: IG_ID }, message: { mid: `in-${Math.random().toString(36).slice(2)}`, text } });

const IG_ID = `e2e-ig-${Date.now()}`;
let workspaceId = "";

async function main() {
  const owner = await prisma.user.create({ data: { email: `e2e-${Date.now()}@example.com` } });
  const ws = await prisma.workspace.create({ data: { name: "E2E", ownerId: owner.id, members: { create: { userId: owner.id, role: "OWNER" } } } });
  workspaceId = ws.id;
  const account = await prisma.instagramAccount.create({
    data: { workspaceId, instagramId: IG_ID, username: "e2e_account", accessToken: encryptToken("ig-token") },
  });
  const profile = await prisma.assistantProfile.create({
    data: {
      workspaceId, enabled: true, approvedAt: new Date(), companyName: "Mebel Plus", description: "Divan va kreslolar",
      handleInboundDm: true, pricePolicy: "NEVER",
      products: { create: [{ name: "Milan divani", price: 4_500_000 }] },
    },
  });
  void profile;
  const tg = await prisma.integration.create({ data: { workspaceId, type: "TELEGRAM", name: "Telegram" } });
  await prisma.telegramChat.create({ data: { integrationId: tg.id, chatId: "-100500" } });
  const amo = await prisma.integration.create({
    data: {
      workspaceId, type: "AMOCRM", name: "amoCRM", credentialsEncrypted: encryptCredentials({ token: "t".repeat(30) }),
      config: { subdomain: "promtchi", zone: "amocrm.ru" },
    },
  });
  const bitrix = await prisma.integration.create({
    data: {
      workspaceId, type: "BITRIX24", name: "Bitrix24",
      credentialsEncrypted: encryptCredentials({ webhookUrl: "https://e2e.bitrix24.uz/rest/1/abc123/" }), config: {},
    },
  });

  const worker = createAssistantWorker();
  const t0 = Date.now();

  console.log("\n1. Signature check and inbound DM");
  const bad = await webhookPost(new NextRequest("http://localhost/api/webhook", { method: "POST", body: "{}", headers: { "x-hub-signature-256": "sha256=00" } }));
  check("a webhook with a bad signature is rejected (401)", bad.status === 401);
  check("a signed DM is accepted (200)", (await customerSays("Salom, divan bormi?")) === 200);
  await customerSays("narxi qancha?"); // burst: debounce must produce ONE answer

  const firstReply = await waitFor(async () => (igSends.length > 0 ? igSends[0] : null), 30_000, "first assistant reply");
  const elapsed = Date.now() - t0;
  check("assistant answered", Boolean(firstReply), "no IG send");
  check("reply arrived after the 4s debounce + typing delay (>=4s, <=16s)", elapsed >= 4000 && elapsed <= 16_000, `${elapsed}ms`);
  await new Promise((r) => setTimeout(r, 3000));
  check("a burst of two messages got exactly ONE bot reply", igSends.length === 1, `sends=${igSends.length}`);
  check("reply is <=300 chars", (firstReply?.length ?? 999) <= 300);
  check("a price in the model output was blocked (policy never)", !igSends.some((s) => /4 500 000/.test(s)));
  const conv = await prisma.conversation.findFirst({ where: { workspaceId } });
  check("conversation stored with real DB row", Boolean(conv) && conv!.botMessageCount === 1, JSON.stringify(conv?.assistantState));
  check("LLM usage recorded", (await prisma.llmUsage.count({ where: { workspaceId } })) >= 1);

  console.log("\n2. Phone captured -> lead -> Telegram + Bitrix24 delivered, amoCRM broken");
  await customerSays("Aziz, 90 123 45 67");
  const lead = await waitFor(() => prisma.lead.findFirst({ where: { workspaceId } }), 30_000, "lead");
  check("lead created with E.164 phone and name", lead?.phoneE164 === "+998901234567" && lead?.name === "Aziz", JSON.stringify(lead && { p: lead.phoneE164, n: lead.name }));
  check("final message sent with formatted number", igSends.some((s) => s.includes("+998 90 123 45 67")));
  const state = await waitFor(async () => {
    const c = await prisma.conversation.findFirst({ where: { workspaceId } });
    return c?.assistantState === "HANDED_OFF" ? c : null;
  });
  check("conversation handed off", Boolean(state));

  const deliveries = await waitFor(async () => {
    const rows = await prisma.leadDelivery.findMany({ where: { leadId: lead?.id }, include: { integration: true } });
    const tgRow = rows.find((r) => r.integration.type === "TELEGRAM");
    const bxRow = rows.find((r) => r.integration.type === "BITRIX24");
    const amoRow = rows.find((r) => r.integration.type === "AMOCRM");
    return tgRow?.status === "SENT" && bxRow?.status === "SENT" && amoRow && (await prisma.integration.findUnique({ where: { id: amo.id } }))?.status === "BROKEN" ? rows : null;
  });
  check("Telegram delivered", deliveries?.find((d) => d.integration.type === "TELEGRAM")?.status === "SENT");
  check("Telegram text has phone and marker", tgSends.some((t) => t.includes("+998901234567") && t.includes("Yangi lid")));
  check("Bitrix24 lead created + timeline comment", bitrixCalls.includes("crm.lead.add") && bitrixCalls.includes("crm.timeline.comment.add"));
  check("Bitrix24 deliveries link stored", Boolean(deliveries?.find((d) => d.integration.type === "BITRIX24")?.externalUrl?.includes("/crm/lead/details/555/")));
  check("amoCRM 401 marked the integration BROKEN", (await prisma.integration.findUnique({ where: { id: amo.id } }))?.status === "BROKEN");
  check("amoCRM delivery held (PENDING), not burned", deliveries?.find((d) => d.integration.type === "AMOCRM")?.status === "PENDING");
  check("a Telegram alert about the broken CRM was sent", tgSends.some((t) => t.includes("uzildi")));

  console.log("\n3. amoCRM repaired -> held lead delivered automatically");
  amoTokenValid = true;
  await prisma.integration.update({ where: { id: amo.id }, data: { status: "ACTIVE" } });
  await resumeIntegration(amo.id);
  const amoSent = await waitFor(async () => {
    const d = await prisma.leadDelivery.findFirst({ where: { leadId: lead?.id, integrationId: amo.id } });
    return d?.status === "SENT" ? d : null;
  });
  check("held lead reached amoCRM after repair", Boolean(amoSent));
  check("amoCRM got complex lead + note", amoRequests.some((r) => r.includes("/leads/complex")) && amoRequests.some((r) => r.includes("/notes")));
  const finalLead = await prisma.lead.findUnique({ where: { id: lead!.id } });
  check("lead status SENT once everything delivered", finalLead?.status === "SENT", finalLead?.status);

  console.log("\n4. Silence after hand-off, operator takeover, repeat inquiry");
  const before = igSends.length;
  await customerSays("yana bir savol");
  await new Promise((r) => setTimeout(r, 6500));
  check("bot stays silent after hand-off", igSends.length === before);
  check("operators are notified the customer wrote again", tgSends.some((t) => t.includes("yana yozdi")));

  const other = "cust2";
  await sendWebhook({ sender: { id: other }, recipient: { id: IG_ID }, message: { mid: "in-c2", text: "salom" } });
  await sendWebhook({ sender: { id: IG_ID }, recipient: { id: other }, message: { mid: "echo-op", text: "Salom, operator", is_echo: true } });
  const takeover = await waitFor(async () => {
    const c = await prisma.conversation.findFirst({ where: { workspaceId, igUserId: other } });
    return c?.operatorActiveUntil ?? null;
  }, 15_000, "operator takeover");
  check("an operator echo pauses the bot for ~24h", Boolean(takeover) && takeover!.getTime() - Date.now() > 23 * 3600_000);
  const sendsBefore = igSends.length;
  await new Promise((r) => setTimeout(r, 7000));
  check("bot did not answer the paused conversation", igSends.length === sendsBefore);

  await sendWebhook({ sender: { id: "cust3" }, recipient: { id: IG_ID }, message: { mid: "in-c3", text: "Ali 90 123 45 67" } });
  const repeat = await waitFor(() => prisma.lead.findFirst({ where: { workspaceId, igUserId: "cust3" } }), 30_000, "repeat lead");
  check("same phone within 30 days is flagged as repeat", repeat?.isRepeat === true && repeat.repeatOfId === lead?.id);
  const repeatDeliveries = await waitFor(async () => {
    const rows = await prisma.leadDelivery.findMany({ where: { leadId: repeat?.id } });
    return rows.length === 3 && rows.every((r) => r.status === "SENT") ? rows : null;
  });
  check("repeat inquiry delivered as kind=repeat everywhere", Boolean(repeatDeliveries) && repeatDeliveries!.every((r) => r.kind === "repeat"));
  check("Telegram shows the repeat message", tgSends.some((t) => t.includes("Takroriy murojaat")));

  console.log("\n5. Multi-tenant isolation");
  const ws2 = await prisma.workspace.create({ data: { name: "E2E-other", ownerId: owner.id } });
  const foreign = await prisma.lead.count({ where: { workspaceId: ws2.id } });
  check("a second workspace sees none of the leads", foreign === 0);
  await prisma.workspace.delete({ where: { id: ws2.id } });

  void account; void bitrix;
  await worker.close();
}

main()
  .catch((error) => {
    console.error("E2E crashed:", error);
    failures++;
  })
  .finally(async () => {
    if (workspaceId) {
      await prisma.workspace.delete({ where: { id: workspaceId } }).catch((e) => console.error("cleanup:", e.message));
    }
    await getAssistantQueue().obliterate({ force: true }).catch(() => {});
    await getAssistantQueue().close().catch(() => {});
    await getRedisConnection().quit().catch(() => {});
    await prisma.$disconnect();
    console.log(failures === 0 ? "\nALL E2E CHECKS PASSED" : `\n${failures} E2E CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  });
