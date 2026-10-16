"use client";

import { useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { Field, inputClass, Pill, primaryButton, secondaryButton } from "@/components/developer/ui";
import DeleteProject from "./delete-project";
import { jsonInit, MIGRATION_API, requestJson, type MigrationMeta, type ProjectDetail, type ProjectSummary, type RawProject } from "./shared";

/** Adds the fix to the engine's message, by what went wrong. */
export function connectFix(status: number, error: string): string {
  if (status === 429) return `${error} Yechim: ManyChat so'rov limitiga yetdi — 1-2 daqiqa kutib, qayta urinib ko'ring.`;
  if (status === 401 || status === 422 || /kalit|key/i.test(error)) {
    return `${error} Yechim: ManyChat → Settings → API bo'limidan kalitni qayta nusxalang (bo'sh joysiz) va Instagram kanali ulangan sahifaniki ekanini tekshiring.`;
  }
  return error;
}

export default function ConnectStep({
  meta,
  projects,
  active,
  canWrite,
  onConnected,
  onOpen,
  onDeleted,
  onChanged,
}: {
  meta: MigrationMeta;
  projects: ProjectSummary[];
  active: ProjectDetail | null;
  canWrite: boolean;
  onConnected: (id: string) => void;
  onOpen: (id: string, step: number) => void;
  onDeleted: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [accountId, setAccountId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await requestJson<RawProject>(
        `${MIGRATION_API}/projects`,
        jsonInit("POST", { name: name.trim(), apiKey: apiKey.trim(), ...(accountId ? { instagramAccountId: accountId } : {}) })
      );
      if (res.ok) {
        // The key is shown once, in this field only; clear it as soon as it is stored.
        setApiKey("");
        setName("");
        onChanged();
        onConnected(res.data.project.id);
      } else setError(connectFix(res.status, res.error));
    } finally {
      setBusy(false);
    }
  }

  const valid = name.trim().length > 0 && apiKey.trim().length >= 8;

  return (
    <div className="space-y-6">
      <section className="panel space-y-3 rounded-xl p-4 sm:p-5" aria-labelledby="mg-info">
        <h2 id="mg-info" className="text-sm font-semibold text-foreground">
          Nima o&apos;qiladi va nima mumkin emas
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-success/30 p-3">
            <p className="text-xs font-semibold text-success">Avtomatik o&apos;qiladi</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-foreground">
              <li>Teglar (tags)</li>
              <li>Maxsus maydonlar (turi bilan)</li>
              <li>Bot maydonlari (qiymati bilan)</li>
              <li>Flow&apos;lar va growth tool&apos;lar RO&apos;YXATI (nomi, papkasi)</li>
            </ul>
          </div>
          <div className="rounded-lg border border-warning/30 p-3">
            <p className="text-xs font-semibold text-warning">ManyChat API bermaydi (qo&apos;lda)</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-foreground">
              <li>Flow ichidagi xabarlar va qadamlar — matnini siz joylaysiz, AI aylantiradi</li>
              <li>Kalit so&apos;z qoidalari va growth tool sozlamalari</li>
              <li>Obunachilar (kontaktlar) — ko&apos;chirilmaydi, qayta rozilik kerak</li>
            </ul>
          </div>
        </div>
        <p className="text-xs text-muted">
          Kalitni olish: ManyChat → <strong>Settings → API</strong> → &quot;Generate Your API Token&quot;. Kalit shifrlangan holda saqlanadi, qayta ko&apos;rsatilmaydi, faqat o&apos;qish uchun va faqat <code>api.manychat.com</code> ga ishlatiladi. Loyihani o&apos;chirsangiz kalit ham o&apos;chadi.
        </p>
      </section>

      {active && (
        <section className="panel space-y-3 rounded-xl p-4 sm:p-5" aria-label="Ulangan loyiha">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-foreground">{active.name}</h2>
              <p className="text-xs text-muted">
                Kalit: <code>{active.apiKeyHint ?? "••••"}</code>
                {active.pageSnapshot?.name ? ` · Sahifa: ${active.pageSnapshot.name}` : ""}
              </p>
            </div>
            <Pill tone="success">Ulangan</Pill>
          </div>
          {active.lastError && <Notice tone="error">{active.lastError}</Notice>}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={primaryButton} onClick={() => onOpen(active.id, 1)}>
              Tahlilga o&apos;tish
            </button>
            <DeleteProject projectId={active.id} projectName={active.name} onDeleted={onDeleted} />
          </div>
        </section>
      )}

      <section className="panel space-y-4 rounded-xl p-4 sm:p-5" aria-labelledby="mg-form">
        <h2 id="mg-form" className="text-sm font-semibold text-foreground">
          ManyChat&apos;ni ulash
        </h2>
        {!canWrite && <Notice tone="warning">Ulash uchun Menejer roli va yoqilgan migratsiya kerak.</Notice>}
        <form onSubmit={connect} className="space-y-4" autoComplete="off">
          <Field label="Loyiha nomi" hint="Faqat o'zingiz uchun, masalan: Do'kon ManyChat">
            <input className={inputClass} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} disabled={!canWrite || busy} aria-label="Loyiha nomi" />
          </Field>
          <Field label="ManyChat API kaliti" hint="Maydon yashirin. Ulangandan so'ng tozalanadi va faqat oxirgi belgilari ko'rsatiladi.">
            <input
              type="password"
              className={inputClass}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={!canWrite || busy}
              autoComplete="new-password"
              spellCheck={false}
              aria-label="ManyChat API kaliti"
            />
          </Field>
          <Field label="Maqsad Instagram akkaunt" hint="Flow'lar shu akkauntga qoralama qilib tushadi. Keyinroq ham tanlash mumkin.">
            <select className={inputClass} value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={!canWrite || busy} aria-label="Maqsad Instagram akkaunt">
              <option value="">Keyin tanlayman</option>
              {meta.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.username}
                  {a.tokenStatus !== "ACTIVE" ? " (token muammosi)" : ""}
                </option>
              ))}
            </select>
          </Field>
          {meta.accounts.length === 0 && <Notice tone="warning">Instagram akkaunt ulanmagan. Yechim: avval Sozlamalar bo&apos;limidan akkaunt ulang, so&apos;ng flow&apos;larni import qiling.</Notice>}
          {error && <Notice tone="error">{error}</Notice>}
          <button type="submit" className={primaryButton} disabled={!canWrite || busy || !valid}>
            {busy ? "Tekshirilmoqda…" : "Ulash va tekshirish"}
          </button>
        </form>
      </section>

      {projects.length > 0 && (
        <section className="panel space-y-3 rounded-xl p-4 sm:p-5" aria-labelledby="mg-projects">
          <h2 id="mg-projects" className="text-sm font-semibold text-foreground">
            Mavjud loyihalar
          </h2>
          <ul className="space-y-2">
            {projects.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{p.name}</p>
                  <p className="text-xs text-muted">
                    Kalit {p.apiKeyHint ?? "—"} · {p.lastAnalyzedAt ? `tahlil: ${new Date(p.lastAnalyzedAt).toLocaleString("uz-UZ")}` : "hali tahlil qilinmagan"}
                  </p>
                </div>
                <button type="button" className={secondaryButton} onClick={() => onOpen(p.id, p.lastAnalyzedAt ? 3 : 1)}>
                  Davom ettirish
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
