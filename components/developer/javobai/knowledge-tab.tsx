"use client";

/**
 * What the AI actually sees for the account (the preview lines with their
 * ids, as `used_facts` cites them) and the extra verified entries on top of
 * the production profile / products / FAQ.
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState, Field, inputClass, Pill, primaryButton, secondaryButton, Toggle } from "@/components/developer/ui";
import { CharCount, ConfirmButton, Notice } from "@/components/developer/comments/parts";
import {
  JAVOBAI_API,
  jsonInit,
  KNOWLEDGE_KIND_TEXT,
  profileStateText,
  requestJson,
  type AccountView,
  type KnowledgeEntry,
  type KnowledgeKind,
  type KnowledgePreview,
  type ProfileStatus,
} from "./shared";

const LIMITS = { title: 120, body: 2000 };
const KINDS = Object.keys(KNOWLEDGE_KIND_TEXT) as KnowledgeKind[];

interface KnowledgeResponse {
  profile: ProfileStatus;
  entries: KnowledgeEntry[];
  preview: KnowledgePreview;
}

function EntryCard({ entry, onChanged }: { entry: KnowledgeEntry; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(entry.title);
  const [body, setBody] = useState(entry.body);
  const [kind, setKind] = useState<KnowledgeKind>(entry.kind);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(url: string, init: RequestInit) {
    setBusy(true);
    setError(null);
    try {
      const res = await requestJson(url, init);
      if (!res.ok) {
        setError(res.error);
        return false;
      }
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function saveText() {
    const ok = await send(`${JAVOBAI_API}/knowledge/${entry.id}`, jsonInit("PATCH", { title, body, kind }));
    if (ok) {
      setEditing(false);
      onChanged();
    }
  }

  const verified = entry.verifiedAt !== null;

  return (
    <li className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="label-mono rounded-md bg-surface-hover px-1.5 py-0.5 text-[10px] text-muted">
              {KNOWLEDGE_KIND_TEXT[entry.kind]}
            </span>
            <Pill tone={verified ? "success" : "warning"}>{verified ? "Tasdiqlangan" : "Tasdiqlanmagan — AI ko'rmaydi"}</Pill>
            {!entry.active && <Pill tone="muted">O&apos;chiq</Pill>}
          </div>
          {!editing ? (
            <>
              <p className="mt-1.5 break-words text-sm font-medium text-foreground">{entry.title}</p>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-muted">{entry.body}</p>
            </>
          ) : (
            <div className="mt-2 space-y-2">
              <select className={inputClass} value={kind} aria-label="Turi" onChange={(e) => setKind(e.target.value as KnowledgeKind)}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KNOWLEDGE_KIND_TEXT[k]}
                  </option>
                ))}
              </select>
              <input className={inputClass} value={title} maxLength={LIMITS.title} aria-label="Sarlavha" onChange={(e) => setTitle(e.target.value)} />
              <textarea
                className={`${inputClass} min-h-24`}
                value={body}
                maxLength={LIMITS.body}
                aria-label="Matn"
                onChange={(e) => setBody(e.target.value)}
              />
              <CharCount value={body} max={LIMITS.body} />
              <p className="text-xs text-muted">Matn o&apos;zgarsa tasdiq bekor bo&apos;ladi — qayta tasdiqlash kerak.</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={primaryButton} disabled={busy || !title.trim() || !body.trim()} onClick={() => void saveText()}>
                  Saqlash
                </button>
                <button type="button" className={secondaryButton} onClick={() => setEditing(false)}>
                  Bekor
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">Faol</span>
          <Toggle
            on={entry.active}
            label={`${entry.title} faol`}
            onChange={(on) =>
              void send(`${JAVOBAI_API}/knowledge/${entry.id}`, jsonInit("PATCH", { active: on })).then((ok) => ok && onChanged())
            }
          />
        </div>
      </div>
      {!editing && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={verified ? secondaryButton : primaryButton}
            disabled={busy}
            onClick={() =>
              void send(`${JAVOBAI_API}/knowledge/${entry.id}/verify`, jsonInit("POST", { verified: !verified })).then(
                (ok) => ok && onChanged()
              )
            }
          >
            {verified ? "Tasdiqni olib tashlash" : "Tasdiqlash"}
          </button>
          <button type="button" className={secondaryButton} disabled={busy} onClick={() => setEditing(true)}>
            Tahrirlash
          </button>
          <ConfirmButton
            label="O'chirish"
            question="Yozuv o'chirilsinmi?"
            confirmLabel="O'chirish"
            danger
            busy={busy}
            onConfirm={() => void send(`${JAVOBAI_API}/knowledge/${entry.id}`, { method: "DELETE" }).then((ok) => ok && onChanged())}
          />
        </div>
      )}
      {error && <p className="mt-2 text-xs text-error">{error}</p>}
    </li>
  );
}

function NewEntryForm({ accountId, onCreated }: { accountId: string; onCreated: () => void }) {
  const [kind, setKind] = useState<KnowledgeKind>("DISCOUNT");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await requestJson(`${JAVOBAI_API}/accounts/${accountId}/knowledge`, jsonInit("POST", { kind, title, body }));
      if (res.ok) {
        setTitle("");
        setBody("");
        onCreated();
      } else setError(res.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-dashed border-border p-3">
      <p className="text-sm font-semibold text-foreground">Yangi yozuv</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Field label="Turi">
          <select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as KnowledgeKind)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {KNOWLEDGE_KIND_TEXT[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Sarlavha">
          <input
            className={inputClass}
            value={title}
            maxLength={LIMITS.title}
            placeholder="Oktabr chegirmasi"
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
      </div>
      <Field label="Matn" hint="Faqat haqiqiy, tekshirilgan fakt. AI bu matnni so'zma-so'z ishlatishi mumkin.">
        <textarea
          className={`${inputClass} min-h-24`}
          value={body}
          maxLength={LIMITS.body}
          placeholder="31-oktabrgacha barcha kurslarga 15% chegirma. Promokod shart emas."
          onChange={(e) => setBody(e.target.value)}
        />
        <CharCount value={body} max={LIMITS.body} />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={primaryButton} disabled={busy || !title.trim() || !body.trim()} onClick={() => void create()}>
          {busy ? "Saqlanmoqda…" : "Qo'shish (tasdiqlanmagan)"}
        </button>
        <span className="text-xs text-muted">Qo&apos;shilgach &quot;Tasdiqlash&quot; ni bosing — shundan keyin AI ko&apos;radi.</span>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

export default function KnowledgeTab({ account }: { account: AccountView | null }) {
  const [data, setData] = useState<KnowledgeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const seq = useRef(0);
  const accountId = account?.id ?? null;

  const load = useCallback(async () => {
    if (!accountId) return;
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await requestJson<KnowledgeResponse>(`${JAVOBAI_API}/accounts/${accountId}/knowledge`);
      if (mine !== seq.current) return;
      if (res.ok) setData(res.data);
      else setError(res.error);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch per account
    setData(null);
    void load();
  }, [load]);

  if (!account) {
    return (
      <div className="panel rounded-xl">
        <EmptyState title="Akkaunt yo'q" body="Avval Foundation → Ulanishlar bo'limida Instagram akkaunt ulang." />
      </div>
    );
  }

  const verified = data?.entries.filter((e) => e.verifiedAt && e.active).length ?? 0;

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
          <span>{error}</span>
          <button type="button" className={secondaryButton} onClick={() => void load()}>
            Qayta urinish
          </button>
        </div>
      )}

      {data && !data.profile.exists && (
        <Notice tone="warning">
          Bu akkaunt uchun bilim bazasi (AI assistent profili) yo&apos;q. JavobAI production profilidagi kompaniya
          ma&apos;lumoti, mahsulotlar va FAQ&apos;dan foydalanadi — avval{" "}
          <Link href="/assistant" className="underline">
            /assistant
          </Link>{" "}
          sahifasida profil yarating, keyin bu yerga qaytib qo&apos;shimcha faktlarni kiriting.
        </Notice>
      )}

      {data?.profile.exists && (
        <section className="panel space-y-3 rounded-xl p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-foreground">AI nimani ko&apos;radi</h2>
              <p className="mt-1 text-xs text-muted">
                {data.profile.companyName || "Nomsiz profil"} ·{" "}
                {data.profile.scope === "account" ? "shu akkaunt uchun" : "workspace umumiy profil"} ·{" "}
                {profileStateText(data.profile)}{data.profile.live ? "" : " (LIVE yoqilmaydi)"} · {data.preview.lines.length} qator ·{" "}
                {data.preview.chars} belgi
                {data.preview.truncated && <b className="text-warning"> · qisqartirildi (limit 6000)</b>}
              </p>
              <p className="mt-1 text-xs text-muted">
                Profil, mahsulotlar va FAQ production&apos;da tahrirlanadi:{" "}
                <Link href="/assistant" className="text-accent underline">
                  /assistant
                </Link>
                . Bu yerda faqat qo&apos;shimcha yozuvlar (K-qatorlar) qo&apos;shiladi.
              </p>
            </div>
            <button type="button" className={secondaryButton} onClick={() => setShowPreview((s) => !s)}>
              {showPreview ? "Yashirish" : "Qatorlarni ko'rish"}
            </button>
          </div>
          {showPreview &&
            (data.preview.lines.length === 0 ? (
              <p className="text-sm text-muted">Hozircha bo&apos;sh — profilga mahsulot yoki FAQ qo&apos;shing.</p>
            ) : (
              <ul className="max-h-96 space-y-1 overflow-y-auto rounded-lg bg-surface-hover/50 p-2 text-xs">
                {data.preview.lines.map((line) => (
                  <li key={line.id} className="flex gap-2">
                    <span className="label-mono shrink-0 text-[10px] font-bold text-accent">{line.id}</span>
                    <span className="label-mono shrink-0 text-[10px] text-muted">{line.kind}</span>
                    <span className="min-w-0 break-words text-foreground">{line.text}</span>
                  </li>
                ))}
              </ul>
            ))}
        </section>
      )}

      {data?.profile.exists && (
        <section className="panel space-y-3 rounded-xl p-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Qo&apos;shimcha faktlar</h2>
            <p className="mt-1 text-xs text-muted">
              Chegirmalar, kontaktlar, shartlar, filiallar, qoidalar. <b>Tasdiqlanmagan yozuv AI&apos;ga hech qachon ko&apos;rsatilmaydi</b>{" "}
              — {verified} ta tasdiqlangan va faol yozuv hozir ishlatilmoqda.
            </p>
          </div>
          {loading && !data ? (
            <p className="py-6 text-center text-sm text-muted">Yuklanmoqda…</p>
          ) : data.entries.length === 0 ? (
            <p className="text-sm text-muted">Hali yozuv yo&apos;q.</p>
          ) : (
            <ul className="space-y-2">
              {data.entries.map((entry) => (
                <EntryCard key={entry.id} entry={entry} onChanged={() => void load()} />
              ))}
            </ul>
          )}
          <NewEntryForm accountId={account.id} onCreated={() => void load()} />
        </section>
      )}

      {!data && loading && <p className="py-10 text-center text-sm text-muted">Yuklanmoqda…</p>}
    </div>
  );
}
