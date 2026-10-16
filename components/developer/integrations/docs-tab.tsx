"use client";

/**
 * Qo'llanma: how a receiver verifies the signature (Node / PHP), the headers
 * and response rules, Make / Zapier setup and the Google Sheets sharing
 * steps. Static text; the snippets mirror lib/integrations2/README.md.
 */

import { useState } from "react";
import { secondaryButton } from "@/components/developer/ui";
import { copyText, type Meta } from "./shared";

const NODE_SNIPPET = `import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySocialAuto(req, rawBody, secret, toleranceSec = 300) {
  const ts = req.headers["x-socialauto-timestamp"];
  const header = req.headers["x-socialauto-signature"] ?? "";
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(\`\${ts}.\${rawBody}\`).digest("hex");
  return header
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("v1="))
    .some((s) => {
      const got = Buffer.from(s.slice(3), "hex");
      return got.length === 32 && timingSafeEqual(got, Buffer.from(expected, "hex"));
    });
}
// express: app.post("/hook", express.raw({ type: "*/*" }), (req, res) => {
//   if (!verifySocialAuto(req, req.body.toString("utf8"), process.env.SA_SECRET)) return res.sendStatus(401);
//   const event = JSON.parse(req.body); /* event.id bo'yicha takrorlarni o'tkazib yuboring */ res.sendStatus(200);
// });`;

const PHP_SNIPPET = `<?php
function verify_socialauto(string $rawBody, string $secret, int $tolerance = 300): bool {
    $ts = $_SERVER['HTTP_X_SOCIALAUTO_TIMESTAMP'] ?? '';
    $header = $_SERVER['HTTP_X_SOCIALAUTO_SIGNATURE'] ?? '';
    if ($ts === '' || abs(time() - (int)$ts) > $tolerance) return false;
    $expected = hash_hmac('sha256', $ts . '.' . $rawBody, $secret);
    foreach (explode(',', $header) as $part) {
        $part = trim($part);
        if (str_starts_with($part, 'v1=') && hash_equals($expected, substr($part, 3))) return true;
    }
    return false;
}
$raw = file_get_contents('php://input');
if (!verify_socialauto($raw, getenv('SA_SECRET'))) { http_response_code(401); exit; }
$event = json_decode($raw, true); // $event['id'] bo'yicha takrorlarni o'tkazib yuboring
http_response_code(200);`;

const HEADERS = `Content-Type: application/json; charset=utf-8
User-Agent: SocialAuto-Webhooks/1.0
X-SocialAuto-Event: lead.created
X-SocialAuto-Event-Id: <hodisa ID — takrorlarni shu bo'yicha ajrating>
X-SocialAuto-Delivery-Id: <yetkazish ID>
X-SocialAuto-Timestamp: <unix soniya>
X-SocialAuto-Signature: v1=<hex hmac-sha256(secret, timestamp + "." + body)>[,v1=<eski kalit>]`;

function Snippet({ title, code }: { title: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <button type="button" className={secondaryButton} onClick={async () => setCopied(await copyText(code))}>
          {copied ? "Nusxalandi" : "Nusxalash"}
        </button>
      </div>
      <pre className="max-h-96 overflow-auto rounded-lg bg-surface p-3 text-xs text-foreground" tabIndex={0}>
        {code}
      </pre>
    </div>
  );
}

export default function DocsTab({ meta }: { meta: Meta }) {
  const delays = meta.limits.retryDelaysSec.map((s) => (s < 60 ? `${s} s` : s < 3600 ? `${s / 60} daq` : `${s / 3600} soat`)).join(", ");
  return (
    <div className="space-y-4">
      <section className="panel space-y-3 rounded-xl p-4">
        <h2 className="text-sm font-semibold text-foreground">Webhook: so&apos;rov va javob qoidalari</h2>
        <Snippet title="Sarlavhalar" code={HEADERS} />
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          <li>2xx — yuborildi. 408 / 425 / 429 / 5xx va tarmoq xatosi — qayta uriniladi (<code>Retry-After</code> 6 soatgacha hisobga olinadi).</li>
          <li>410 Gone — hodisa DEAD bo&apos;ladi va obuna o&apos;chiriladi. Boshqa 4xx va redirect (3xx) — DEAD (redirect ergashilmaydi).</li>
          <li>Qayta urinishlar: {delays}; {meta.limits.maxAttempts} urinishdan keyin DEAD. Ketma-ket {meta.limits.deadAutoDisable} ta DEAD obunani o&apos;chiradi.</li>
          <li>Hodisa takror kelishi mumkin — <code>X-SocialAuto-Event-Id</code> bo&apos;yicha takrorlarni o&apos;tkazib yuboring.</li>
          <li>URL faqat <code>https://</code>, 443 / 8443 port; ichki va xususiy manzillarga yuborilmaydi (saqlashda ham, har yuborishda ham tekshiriladi).</li>
          <li>Tezlik limiti ulanish bo&apos;yicha (standart {meta.limits.defaultRatePerMinute}/daqiqa); oshsa yetkazish 1 daqiqaga kechiktiriladi.</li>
          <li>Kalitni almashtirganda eski kalit {meta.limits.secretOverlapHours} soat ham imzolaydi: sarlavhada ikkita <code>v1=</code> bo&apos;ladi.</li>
          <li>Hodisalar va yetkazishlar {meta.limits.retentionDays} kun saqlanadi.</li>
        </ul>
        <Snippet title="Imzoni tekshirish — Node.js" code={NODE_SNIPPET} />
        <Snippet title="Imzoni tekshirish — PHP" code={PHP_SNIPPET} />
      </section>

      <section className="panel space-y-2 rounded-xl p-4">
        <h2 className="text-sm font-semibold text-foreground">Make</h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>Make&apos;da yangi scenario → <b>Webhooks → Custom webhook</b> → Add → manzilni nusxalang (<code>https://hook.eu1.make.com/…</code>).</li>
          <li>Bu yerda <b>Ulanish qo&apos;shish → Make</b> ni tanlab manzilni qo&apos;ying, kerakli hodisalarni belgilang.</li>
          <li>Make&apos;da «Run once» ni bosing, so&apos;ng ulanish kartasida <b>Sinash</b> — Make payload maydonlarini (<code>lead.name</code>, <code>score.value</code>, …) o&apos;zi taniydi.</li>
        </ol>
      </section>

      <section className="panel space-y-2 rounded-xl p-4">
        <h2 className="text-sm font-semibold text-foreground">Zapier</h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>Zapier&apos;da yangi Zap → Trigger: <b>Webhooks by Zapier → Catch Hook</b> → manzilni nusxalang (<code>https://hooks.zapier.com/hooks/catch/…</code>).</li>
          <li>Bu yerda <b>Ulanish qo&apos;shish → Zapier</b> ni tanlab manzilni qo&apos;ying.</li>
          <li>Zapier&apos;da «Test trigger», bu yerda <b>Sinash</b> — namunaviy hodisa kelgach Zap&apos;ning keyingi qadamlarini sozlang.</li>
        </ol>
        <p className="text-xs text-muted">Zapier REST hooks / rasmiy Zapier ilovasi keyingi bosqichda.</p>
      </section>

      <section className="panel space-y-2 rounded-xl p-4">
        <h2 className="text-sm font-semibold text-foreground">Google Sheets</h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>Google Cloud Console → IAM → <b>Service accounts</b> → akkaunt yarating → Keys → <b>Add key → JSON</b> (fayl yuklab olinadi). Google Sheets API yoqilgan bo&apos;lsin.</li>
          <li>Bu yerda <b>Ulanish qo&apos;shish → Google Sheets</b>: JSON faylni yuklang yoki matnini qo&apos;ying, jadval havolasini kiriting. Kalit shifrlab saqlanadi.</li>
          <li>Ulangach ko&apos;rsatilgan <code>client_email</code> manziliga jadvalni <b>Share → Editor</b> sifatida ulashing. Ulashilmasa «Sinash» aynan shu manzilni ko&apos;rsatib xato beradi.</li>
          <li>Bitta jadval — bitta varaq: 1-qatorga sarlavhalar yoziladi, har bir hodisa yangi qator bo&apos;ladi (mavjud qatorlarga tegilmaydi). Varaq yo&apos;q bo&apos;lsa yaratiladi.</li>
        </ol>
        <p className="text-xs text-muted">Ustunlar: {meta.sheetHeaders.join(", ")}</p>
      </section>
    </div>
  );
}
