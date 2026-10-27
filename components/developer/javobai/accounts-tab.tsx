"use client";

/**
 * Per-account mode (OFF / SHADOW / LIVE) with the preconditions spelled out,
 * and the agent knobs folded under "Sozlamalar" with their defaults.
 */

import Link from "next/link";
import { useState } from "react";
import { Choice, Field, inputClass, Pill, primaryButton, secondaryButton, Toggle } from "@/components/developer/ui";
import { Advanced, Notice } from "@/components/developer/comments/parts";
import {
  JAVOBAI_API,
  jsonInit,
  MODE_TEXT,
  offModeDescription,
  profileStateText,
  QUALIFICATION_TEXT,
  requestJson,
  type AccountConfig,
  type AccountsResponse,
  type AccountView,
  type JavobAiMode,
  type QualificationField,
} from "./shared";

const MODES: JavobAiMode[] = ["OFF", "SHADOW", "LIVE"];

function ConfigForm({
  account,
  defaults,
  fields,
  onSaved,
}: {
  account: AccountView;
  defaults: AccountConfig;
  fields: QualificationField[];
  onSaved: () => void;
}) {
  const [config, setConfig] = useState<AccountConfig>(account.config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const set = <K extends keyof AccountConfig>(key: K, value: AccountConfig[K]) => {
    setSaved(false);
    setConfig((c) => ({ ...c, [key]: value }));
  };
  const num = (value: string, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await requestJson(`${JAVOBAI_API}/accounts/${account.id}/config`, jsonInit("PUT", config));
      if (res.ok) {
        setSaved(true);
        onSaved();
      } else setError(res.error);
    } finally {
      setSaving(false);
    }
  }

  const toggleQuestion = (field: QualificationField) => {
    const has = config.qualificationQuestions.includes(field);
    set(
      "qualificationQuestions",
      has ? config.qualificationQuestions.filter((f) => f !== field) : [...config.qualificationQuestions, field]
    );
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Ishonch chegarasi"
          hint={`0.3–0.9, odatda ${defaults.confidenceThreshold}. Pastroq ishonch = "bu ma'lumot menda yo'q" va gap yoziladi.`}
        >
          <input
            type="number"
            step="0.05"
            min={0.3}
            max={0.9}
            className={inputClass}
            value={config.confidenceThreshold}
            aria-label="Ishonch chegarasi"
            onChange={(e) => set("confidenceThreshold", num(e.target.value, defaults.confidenceThreshold))}
          />
        </Field>
        <Field
          label="Javobsiz savollar → operator"
          hint={`Ketma-ket shuncha javobsiz savoldan keyin operatorga topshiradi (odatda ${defaults.unknownStreakForHandoff}).`}
        >
          <input
            type="number"
            min={1}
            max={5}
            className={inputClass}
            value={config.unknownStreakForHandoff}
            aria-label="Javobsiz savollar soni"
            onChange={(e) => set("unknownStreakForHandoff", num(e.target.value, defaults.unknownStreakForHandoff))}
          />
        </Field>
        <Field label="Maksimal AI javoblar" hint={`Bitta lead siklida; yetganda operatorga (odatda ${defaults.maxTurns}).`}>
          <input
            type="number"
            min={4}
            max={30}
            className={inputClass}
            value={config.maxTurns}
            aria-label="Maksimal AI javoblar"
            onChange={(e) => set("maxTurns", num(e.target.value, defaults.maxTurns))}
          />
        </Field>
        <Field label="Telefonni qachon so'raydi" hint="Lead shu darajaga yetganda (yoki sotib olish / to'lov niyatida darhol).">
          <select
            className={inputClass}
            value={config.askPhoneAtTemperature}
            aria-label="Telefonni so'rash darajasi"
            onChange={(e) => set("askPhoneAtTemperature", e.target.value as "WARM" | "HOT")}
          >
            <option value="WARM">Warm bo&apos;lganda</option>
            <option value="HOT">Hot bo&apos;lganda</option>
          </select>
        </Field>
        <Field
          label="Operator kutilayotganda javoblar"
          hint={`Handoff ochiq paytda AI yana shuncha qisqa, faktga asoslangan javob bera oladi (0–3, odatda ${defaults.postHandoffReplies}).`}
        >
          <input
            type="number"
            min={0}
            max={3}
            className={inputClass}
            value={config.postHandoffReplies}
            aria-label="Operator kutilayotganda javoblar"
            onChange={(e) => set("postHandoffReplies", num(e.target.value, defaults.postHandoffReplies))}
          />
        </Field>
        <Field
          label="Operator jim bo'lsa (soat)"
          hint={`Operator shuncha soat yozmasa handoff yopiladi va AI yana javob bera oladi (odatda ${defaults.resumeAfterCloseHours}).`}
        >
          <input
            type="number"
            min={1}
            max={168}
            className={inputClass}
            value={config.resumeAfterCloseHours}
            aria-label="Operator jim bo'lsa, soat"
            onChange={(e) => set("resumeAfterCloseHours", num(e.target.value, defaults.resumeAfterCloseHours))}
          />
        </Field>
      </div>

      <Field label="Kvalifikatsiya savollari" hint="Telefon so'rashdan oldin AI shularni (shu tartibda) so'raydi.">
        <div className="flex flex-wrap gap-2">
          {fields.map((field) => {
            const on = config.qualificationQuestions.includes(field);
            const order = config.qualificationQuestions.indexOf(field);
            return (
              <button
                key={field}
                type="button"
                aria-pressed={on}
                onClick={() => toggleQuestion(field)}
                className={`rounded-full border px-3 py-1 text-xs font-medium ${
                  on ? "border-accent bg-accent/10 text-foreground" : "border-border text-muted hover:text-foreground"
                }`}
              >
                {on ? `${order + 1}. ` : ""}
                {QUALIFICATION_TEXT[field]}
              </button>
            );
          })}
        </div>
      </Field>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
        <div className="min-w-0 text-sm">
          <p className="font-medium text-foreground">Test akkaunt</p>
          <p className="text-xs text-muted">
            Leadlar tenantning haqiqiy Telegram / CRM&apos;iga boradi, lekin xulosada &quot;🧪 TEST&quot; belgisi bilan.
          </p>
        </div>
        <Toggle on={config.isTest} onChange={(on) => set("isTest", on)} label="Test akkaunt" />
      </div>

      {(
        [
          ["ladderEnabled", "Ishonch zinapoyasi", "Har bir mavzu alohida: kuzatish → copilot (qoralama) → avto. O'chiq bo'lsa hamma javob avval qanday bo'lsa shunday yuboriladi."],
          ["hideOffensiveComments", "Haqoratli kommentlarni yashirish", "Postlar ostidagi so'kinish / haqorat avtomatik yashiriladi, Telegram'ga xabar keladi."],
          ["notifyCommentComplaints", "Kommentdagi shikoyat → Telegram", "\"Aldadingiz\", \"kelmadi\" kabi kommentlar menejerlarga darhol yuboriladi."],
        ] as const
      ).map(([key, title, hint]) => (
        <div key={key} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
          <div className="min-w-0 text-sm">
            <p className="font-medium text-foreground">{title}</p>
            <p className="text-xs text-muted">{hint}</p>
          </div>
          <Toggle on={config[key]} onChange={(on) => set(key, on)} label={title} />
        </div>
      ))}

      <Field label="Javobsiz handoff → ikkinchi menejer (daqiqa, 0 = yo'q)">
        <input
          type="number"
          min={0}
          max={240}
          className={inputClass}
          value={config.escalateAfterMinutes}
          onChange={(e) => set("escalateAfterMinutes", num(e.target.value, config.escalateAfterMinutes))}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={primaryButton} disabled={saving} onClick={() => void save()}>
          {saving ? "Saqlanmoqda…" : "Sozlamalarni saqlash"}
        </button>
        <button
          type="button"
          className={secondaryButton}
          onClick={() => {
            setSaved(false);
            setConfig(defaults);
          }}
        >
          Standart qiymatlar
        </button>
        {saved && <span className="text-xs text-success">Saqlandi</span>}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

function AccountCard({
  account,
  data,
  onChanged,
}: {
  account: AccountView;
  data: AccountsResponse;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setMode(mode: JavobAiMode) {
    if (mode === account.mode) return;
    setBusy(true);
    setError(null);
    try {
      const res = await requestJson(`${JAVOBAI_API}/accounts/${account.id}/mode`, jsonInit("PATCH", { mode }));
      if (!res.ok) setError(res.error);
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  const tokenBroken = account.tokenStatus === "BROKEN";
  const problems: string[] = [];
  if (!account.profile.exists) {
    problems.push("AI assistent profili yo'q — LIVE uchun /assistant sahifasida profil yarating va tasdiqlang.");
  } else if (!account.profile.live) {
    problems.push(
      account.profile.approved
        ? "Profil tasdiqlangan, lekin assistent o'chirilgan — LIVE uchun /assistant sahifasida yoqing."
        : "Profil tasdiqlanmagan — LIVE uchun /assistant sahifasida tasdiqlang va yoqing."
    );
  }
  if (tokenBroken) problems.push("Instagram ulanishi uzilgan — javoblar ketmaydi. Foundation → Ulanishlar bo'limida qayta ulang.");

  return (
    <li className="panel space-y-4 rounded-xl p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-foreground">@{account.username}</span>
            <Pill tone={MODE_TEXT[account.mode].tone}>{account.mode}</Pill>
            {account.config.isTest && <Pill tone="warning">🧪 TEST</Pill>}
            {tokenBroken && <Pill tone="error">Ulanish uzilgan</Pill>}
          </div>
          <p className="mt-1 text-xs text-muted">
            {account.profile.exists
              ? `Bilim bazasi: ${account.profile.companyName || "nomsiz"} (${
                  account.profile.scope === "account" ? "shu akkaunt uchun" : "workspace umumiy"
                }) · ${account.profile.products ?? 0} mahsulot · ${account.profile.faqs ?? 0} FAQ · ${
                  profileStateText(account.profile)
                }`
              : "Bilim bazasi yo'q"}
          </p>
        </div>
        <Link href="/assistant" className={secondaryButton}>
          Profil (production)
        </Link>
      </div>

      {problems.length > 0 && (
        <div className="space-y-1.5">
          {problems.map((p) => (
            <Notice key={p} tone="warning">
              {p}
            </Notice>
          ))}
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label={`@${account.username} rejimi`}>
        {MODES.map((mode) => (
          <Choice
            key={mode}
            checked={account.mode === mode}
            disabled={busy || (mode === "LIVE" && !account.profile.live)}
            onSelect={() => void setMode(mode)}
            title={MODE_TEXT[mode].title}
            description={mode === "OFF" ? offModeDescription(account.profile) : MODE_TEXT[mode].description}
            badge={mode === "LIVE" && !account.profile.live ? "profil kerak" : undefined}
          />
        ))}
      </div>
      {account.mode === "LIVE" && (
        <p className="text-xs text-muted">
          LIVE: Comment 2.0 / Direct trigger ishlayotgan odamga JavobAI jim turadi (trigger oqimi egalik qiladi); operator
          yozsa, inbox pauza tugmalari avvalgidek ishlaydi. OFF ga o&apos;tkazilsa, navbatdagi JavobAI ishlari bekor bo&apos;ladi.
        </p>
      )}
      {error && <Notice tone="error">{error}</Notice>}

      <Advanced label="Sozlamalar (agent qanday ishlaydi)">
        <ConfigForm
          key={account.updatedAt ?? "new"}
          account={account}
          defaults={data.defaults}
          fields={data.qualificationFields}
          onSaved={onChanged}
        />
      </Advanced>
    </li>
  );
}

export default function AccountsTab({ data, onChanged }: { data: AccountsResponse; onChanged: () => void }) {
  if (data.accounts.length === 0) {
    return (
      <div className="panel rounded-xl px-4 py-10 text-center">
        <p className="text-sm font-medium text-foreground">Instagram akkaunt ulanmagan</p>
        <p className="mt-1 text-sm text-muted">Avval Foundation → Ulanishlar bo&apos;limida akkaunt ulang.</p>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <Notice tone="info">
        Rejim darhol kuchga kiradi (30 soniyagacha kesh). SHADOW hech narsa yubormaydi — avval SHADOW&apos;da bir necha kun
        kuzatib, keyin LIVE yoqing. Favqulodda to&apos;xtatishni administrator serverdan bajaradi.
      </Notice>
      <ul className="space-y-3">
        {data.accounts.map((account) => (
          <AccountCard key={account.id} account={account} data={data} onChanged={onChanged} />
        ))}
      </ul>
    </div>
  );
}
