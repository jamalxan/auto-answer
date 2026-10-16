"use client";

/**
 * "Ulanish qo'shish": Webhook, Google Sheets, Make and Zapier (Make / Zapier
 * are the webhook form with a ready hint and their own connector type). The
 * server validates everything (URL policy, key file, spreadsheet id); this
 * form only collects and shows the server's Uzbek messages.
 */

import { useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { Field, inputClass, primaryButton, secondaryButton } from "@/components/developer/ui";
import SecretBox from "./secret-box";
import SubscriptionEditor, { cleanFilter, EMPTY_FILTER, type SubscriptionDraft } from "./subscription-editor";
import { INTEGRATIONS_API, copyText, jsonInit, requestJson, type EventType, type IntegrationView, type Meta } from "./shared";

type Kind = "WEBHOOK" | "GOOGLE_SHEETS" | "MAKE" | "ZAPIER";

const KINDS: Array<{ kind: Kind; title: string; description: string }> = [
  { kind: "WEBHOOK", title: "Webhook", description: "Har qanday server: imzolangan JSON POST." },
  { kind: "GOOGLE_SHEETS", title: "Google Sheets", description: "Har bir hodisa — jadvalga yangi qator." },
  { kind: "MAKE", title: "Make", description: "Make (Integromat) «Custom webhook» moduli." },
  { kind: "ZAPIER", title: "Zapier", description: "Zapier «Catch Hook» (Webhooks by Zapier)." },
];

const URL_PLACEHOLDER: Record<string, string> = {
  WEBHOOK: "https://api.sizning-sayt.uz/socialauto",
  MAKE: "https://hook.eu1.make.com/…",
  ZAPIER: "https://hooks.zapier.com/hooks/catch/…/…/",
};

const PRESET_HELP: Record<string, string> = {
  MAKE: "Make: yangi scenario → Webhooks → Custom webhook → «Add» → manzilni nusxalang. Keyin «Run once» bosib, bu yerdan «Sinash»ni yuboring — Make maydonlarni o'zi taniydi.",
  ZAPIER: "Zapier: yangi Zap → Trigger «Webhooks by Zapier» → «Catch Hook» → manzilni nusxalang. «Test trigger» bosib, bu yerdan «Sinash»ni yuboring.",
};

export default function AddConnector({
  meta,
  onCreated,
  onCancel,
}: {
  meta: Meta;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<Kind>("WEBHOOK");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [rate, setRate] = useState(String(meta.limits.defaultRatePerMinute));
  const [keyJson, setKeyJson] = useState("");
  const [spreadsheet, setSpreadsheet] = useState("");
  const [sheetName, setSheetName] = useState("SocialAuto");
  const [draft, setDraft] = useState<SubscriptionDraft>({ events: ["lead.created"], filter: EMPTY_FILTER });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ name: string; secret?: string; clientEmail?: string; hint?: string | null } | null>(null);
  const [copied, setCopied] = useState(false);

  const isSheets = kind === "GOOGLE_SHEETS";

  async function readFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 20_000) {
      setError("Fayl juda katta — bu service account kalit fayli emas");
      return;
    }
    setKeyJson(await file.text());
    setError(null);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const common = { name, events: draft.events, filter: cleanFilter(draft.filter) };
      const res = isSheets
        ? await requestJson<{ integration: IntegrationView; clientEmail: string }>(
            `${INTEGRATIONS_API}/sheets`,
            jsonInit("POST", { ...common, serviceAccountJson: keyJson, spreadsheet, sheetName })
          )
        : await requestJson<{ integration: IntegrationView; secret: string; hint: string | null }>(
            `${INTEGRATIONS_API}/${kind === "WEBHOOK" ? "webhook" : kind.toLowerCase()}`,
            jsonInit("POST", { ...common, url, rateLimitPerMinute: Number(rate) || meta.limits.defaultRatePerMinute })
          );
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setCreated({
        name,
        secret: "secret" in res.data ? res.data.secret : undefined,
        clientEmail: "clientEmail" in res.data ? res.data.clientEmail : undefined,
        hint: "hint" in res.data ? res.data.hint : null,
      });
      onCreated();
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <section className="panel space-y-3 rounded-xl p-4">
        <p className="text-sm font-semibold text-foreground">«{created.name}» ulandi</p>
        {created.secret && (
          <SecretBox
            secret={created.secret}
            title="Imzo uchun maxfiy kalit"
            note="Har bir so'rov X-SocialAuto-Signature bilan imzolanadi (Qo'llanma tabiga qarang)."
            onDismiss={onCancel}
          />
        )}
        {created.clientEmail && (
          <div className="space-y-2 rounded-lg border border-border p-3">
            <p className="text-sm text-foreground">Endi Google Sheets jadvalini shu manzilga «Editor» sifatida ulashing:</p>
            <code className="block break-all rounded-md bg-surface px-3 py-2 font-mono text-xs text-foreground">{created.clientEmail}</code>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={secondaryButton}
                onClick={async () => setCopied(await copyText(created.clientEmail!))}
              >
                {copied ? "Nusxalandi" : "Manzilni nusxalash"}
              </button>
              <button type="button" className={secondaryButton} onClick={onCancel}>
                Tayyor
              </button>
            </div>
            <p className="text-xs text-muted">Ulashgach kartadagi «Sinash» tugmasi jadvalga test qator qo&apos;shadi.</p>
          </div>
        )}
        {created.hint && <Notice tone="warning">{created.hint}</Notice>}
      </section>
    );
  }

  return (
    <section className="panel space-y-4 rounded-xl p-4" aria-label="Yangi ulanish">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">Yangi ulanish</h2>
        <button type="button" className={secondaryButton} onClick={onCancel}>
          Bekor
        </button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" role="radiogroup" aria-label="Ulanish turi">
        {KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            role="radio"
            aria-checked={kind === k.kind}
            onClick={() => {
              setKind(k.kind);
              setError(null);
            }}
            className={`rounded-lg border px-3 py-2 text-left ${kind === k.kind ? "border-accent bg-accent/5" : "border-border hover:border-border-hover"}`}
          >
            <span className="block text-sm font-medium text-foreground">{k.title}</span>
            <span className="block text-xs text-muted">{k.description}</span>
          </button>
        ))}
      </div>

      {PRESET_HELP[kind] && <Notice tone="info">{PRESET_HELP[kind]}</Notice>}

      <Field label="Nomi">
        <input className={inputClass} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Masalan: CRM serverim" />
      </Field>

      {isSheets ? (
        <>
          <Field label="Service account kaliti (JSON)" hint="Google Cloud → IAM → Service accounts → Keys → Add key → JSON. Server tomonida shifrlab saqlanadi, qayta ko'rsatilmaydi.">
            <textarea
              className={`${inputClass} min-h-28 font-mono text-xs`}
              value={keyJson}
              onChange={(e) => setKeyJson(e.target.value)}
              placeholder='{"type":"service_account","client_email":"…","private_key":"…"}'
              spellCheck={false}
              autoComplete="off"
            />
            <input type="file" accept="application/json,.json" aria-label="Kalit faylini tanlash" onChange={(e) => void readFile(e.target.files?.[0])} className="text-xs text-muted" />
          </Field>
          <Field label="Jadval ID yoki havolasi">
            <input className={inputClass} value={spreadsheet} onChange={(e) => setSpreadsheet(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…/edit" />
          </Field>
          <Field label="Varaq nomi" hint="Yo'q bo'lsa avtomatik yaratiladi. Mavjud ma'lumotga tegilmaydi — faqat qator qo'shiladi.">
            <input className={inputClass} value={sheetName} maxLength={100} onChange={(e) => setSheetName(e.target.value)} />
          </Field>
        </>
      ) : (
        <>
          <Field label="Webhook URL" hint="Faqat https://. Ichki va xususiy manzillarga yuborilmaydi.">
            <input className={inputClass} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={URL_PLACEHOLDER[kind]} inputMode="url" autoComplete="off" />
          </Field>
          <Field label="Tezlik limiti (daqiqasiga)" hint={`Standart ${meta.limits.defaultRatePerMinute}. Oshib ketsa yetkazish 1 daqiqaga kechiktiriladi, urinish sanalmaydi.`}>
            <input type="number" min={1} max={600} inputMode="numeric" className={inputClass} value={rate} onChange={(e) => setRate(e.target.value)} />
          </Field>
        </>
      )}

      <SubscriptionEditor
        draft={draft}
        onChange={setDraft}
        events={meta.events.filter((e) => {
          const type = meta.connectorTypes.find((c) => c.type === kind);
          return type ? type.events.includes(e.type as EventType) : true;
        })}
        accounts={meta.accounts}
      />

      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={primaryButton}
          disabled={busy || !name.trim() || draft.events.length === 0 || (isSheets ? !keyJson.trim() || !spreadsheet.trim() : !url.trim())}
          onClick={() => void submit()}
        >
          {busy ? "Saqlanmoqda…" : "Ulash"}
        </button>
      </div>
    </section>
  );
}
