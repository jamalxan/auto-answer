"use client";

/**
 * "Import" tab (spec §5.9 FR-I1, FR-I2): pick a CSV → preview table with
 * every row's errors and warnings → tick the good rows → import. Imported
 * rows become drafts (media downloaded into the library); rows that asked
 * for a time are scheduled automatically as soon as their media finish
 * processing — the panel keeps asking the server while it is open.
 */

import { useEffect, useRef, useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { Pill, primaryButton, secondaryButton } from "./ui";
import { CONTENT_API, formatZoned, jsonInit, requestJson, TYPE_LABEL, type ContentMeta, type PostTypeValue } from "./shared";

interface PreviewRow {
  row: number;
  errors: string[];
  warnings: string[];
  accountUsername: string | null;
  type: PostTypeValue;
  caption: string | null;
  draft: boolean;
  media: Array<{ url: string }>;
  scheduledAt: string | null;
  campaign: { name: string } | null;
}

interface Preview {
  rows: PreviewRow[];
  fileErrors: string[];
  fileWarnings: string[];
  total: number;
  valid: number;
  timezone: string;
}

interface CommitResult {
  results: Array<{ row: number; ok: boolean; postId?: string; error?: string; warnings: string[]; wantsSchedule: boolean }>;
  created: number;
  failed: number;
  toSchedule: string[];
}

interface ScheduleResult {
  scheduled: Array<{ postId: string; scheduledAt: string | null }>;
  pending: string[];
  failed: Array<{ postId: string; error: string }>;
}

const MAX_BYTES = 1_000_000;
const POLL_MS = 6000;
const POLL_LIMIT = 50;

export default function CsvImport({ meta, onImported }: { meta: ContentMeta; onImported: () => void }) {
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<null | "preview" | "commit">(null);
  const [error, setError] = useState<string | null>(null);
  const [commit, setCommit] = useState<CommitResult | null>(null);
  const [schedule, setSchedule] = useState<ScheduleResult | null>(null);
  const polls = useRef(0);
  // The parent passes a fresh callback each render; the poll loop must not restart because of it.
  const importedRef = useRef(onImported);
  useEffect(() => {
    importedRef.current = onImported;
  }, [onImported]);

  async function readFile(file: File) {
    setError(null);
    setCommit(null);
    setSchedule(null);
    setPreview(null);
    if (file.size > MAX_BYTES) return setError("Fayl 1 MB dan katta — bo'lib yuklang");
    const text = await file.text();
    setCsv(text);
    setFileName(file.name);
    setBusy("preview");
    const res = await requestJson<Preview>(`${CONTENT_API}/import/csv`, jsonInit("POST", { csv: text }));
    setBusy(null);
    if (!res.ok) return setError(res.error);
    setPreview(res.data);
    setSelected(new Set(res.data.rows.filter((r) => r.errors.length === 0).map((r) => r.row)));
  }

  async function runCommit() {
    if (!csv || !preview) return;
    setBusy("commit");
    setError(null);
    const res = await requestJson<CommitResult>(`${CONTENT_API}/import/csv/commit`, jsonInit("POST", { csv, rows: [...selected].sort((a, b) => a - b) }));
    setBusy(null);
    if (!res.ok) return setError(res.error);
    setCommit(res.data);
    polls.current = 0;
    importedRef.current();
  }

  // Schedule the imported posts as their media become READY (processing runs in the worker).
  useEffect(() => {
    if (!commit || commit.toSchedule.length === 0) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ids = commit.toSchedule;
    const tick = async () => {
      polls.current++;
      const res = await requestJson<ScheduleResult>(`${CONTENT_API}/import/csv/schedule`, jsonInit("POST", { postIds: ids }));
      if (stopped) return;
      if (res.ok) {
        setSchedule(res.data);
        if (res.data.pending.length === 0) {
          importedRef.current();
          return;
        }
      }
      if (polls.current < POLL_LIMIT) timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, 1500);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [commit]);

  const toggle = (row: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(row)) next.delete(row);
      else next.add(row);
      return next;
    });

  const selectable = preview?.rows.filter((r) => r.errors.length === 0) ?? [];
  const blockedSelected = preview?.rows.some((r) => selected.has(r.row) && r.errors.length > 0) ?? false;

  if (!meta.me.canSchedule) {
    return <Notice tone="warning">CSV import faqat MANAGER va undan yuqori rollar uchun (postlarni rejalashtirish ruxsati kerak).</Notice>;
  }

  return (
    <div className="space-y-4">
      <section className="space-y-3 rounded-2xl border border-border bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-2xl space-y-1">
            <h3 className="font-semibold">CSV dan import</h3>
            <p className="text-sm text-muted">
              Bir faylda 200 tagacha post. Ustunlar: text, date, time, account, type (POST / REEL / TRIAL_REEL / STORY), media_url_1…10, alt_text_1…10, cover_url, cover_frame_ms, share_to_feed,
              first_comment, collaborators, user_tags (@user:x:y;…), draft, autopublish, campaign_keyword. Vaqt — workspace vaqt zonasida ({meta.timezone}). Media havolalari https:// bo&apos;lsin: fayllar kutubxonaga yuklab olinadi.
            </p>
          </div>
          <a className={secondaryButton} href={`${CONTENT_API}/import/csv/template`} download>
            Shablonni yuklab olish
          </a>
        </div>
        <label className={`${primaryButton} cursor-pointer`}>
          {busy === "preview" ? "Tekshirilmoqda…" : "CSV faylni tanlash"}
          <input
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            disabled={busy !== null}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void readFile(file);
            }}
          />
        </label>
        {fileName && <span className="ml-3 text-xs text-muted">{fileName}</span>}
        {error && <Notice tone="error">{error}</Notice>}
      </section>

      {preview && (
        <section className="space-y-3 rounded-2xl border border-border bg-surface p-4">
          {preview.fileErrors.map((e) => (
            <Notice key={e} tone="error">
              {e}
            </Notice>
          ))}
          {preview.fileWarnings.map((w) => (
            <Notice key={w} tone="warning">
              {w}
            </Notice>
          ))}
          {preview.rows.length > 0 && (
            <>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <Pill tone="success">{preview.valid} ta tayyor</Pill>
                {preview.total - preview.valid > 0 && <Pill tone="error">{preview.total - preview.valid} ta xatoli</Pill>}
                <button type="button" className={`${secondaryButton} !py-1`} onClick={() => setSelected(new Set(selectable.map((r) => r.row)))}>
                  Tayyorlarini tanlash
                </button>
                <button type="button" className={`${secondaryButton} !py-1`} onClick={() => setSelected(new Set())}>
                  Tanlovni tozalash
                </button>
                <span className="ml-auto text-xs text-muted">Xatoli qatorlarni faylda tuzatib, qayta yuklang.</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="text-[11px] uppercase text-muted">
                    <tr>
                      <th className="w-10 py-2" />
                      <th className="py-2">Qator</th>
                      <th className="py-2">Akkaunt · tur</th>
                      <th className="py-2">Vaqt</th>
                      <th className="py-2">Matn</th>
                      <th className="py-2">Holat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r) => {
                      const bad = r.errors.length > 0;
                      return (
                        <tr key={r.row} className={`border-t border-border align-top ${bad ? "bg-error/5" : ""}`}>
                          <td className="py-2">
                            <input type="checkbox" aria-label={`${r.row}-qatorni tanlash`} checked={selected.has(r.row)} disabled={bad || commit !== null} onChange={() => toggle(r.row)} />
                          </td>
                          <td className="py-2 font-mono text-xs">{r.row}</td>
                          <td className="py-2">
                            <div>{r.accountUsername ? `@${r.accountUsername}` : "—"}</div>
                            <div className="text-xs text-muted">
                              {TYPE_LABEL[r.type]} · {r.media.length} media{r.campaign ? ` · DM: ${r.campaign.name}` : ""}
                            </div>
                          </td>
                          <td className="py-2 text-xs">
                            {r.scheduledAt ? formatZoned(new Date(r.scheduledAt), preview.timezone) : "—"}
                            {r.draft && <div className="text-muted">draft</div>}
                          </td>
                          <td className="max-w-xs py-2 text-xs">
                            <span className="line-clamp-2">{r.caption ?? <span className="text-muted">—</span>}</span>
                          </td>
                          <td className="py-2 text-xs">
                            {bad ? (
                              <ul className="space-y-0.5 text-error">
                                {r.errors.map((e) => (
                                  <li key={e}>{e}</li>
                                ))}
                              </ul>
                            ) : (
                              <span className="text-success">Tayyor</span>
                            )}
                            {r.warnings.length > 0 && (
                              <ul className="mt-1 space-y-0.5 text-warning">
                                {r.warnings.map((w) => (
                                  <li key={w}>{w}</li>
                                ))}
                              </ul>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {!commit && (
                <div className="flex flex-wrap items-center gap-3">
                  <button type="button" className={primaryButton} disabled={busy !== null || selected.size === 0 || blockedSelected} onClick={() => void runCommit()}>
                    {busy === "commit" ? "Import qilinmoqda — fayllar yuklab olinmoqda…" : `${selected.size} ta qatorni import qilish`}
                  </button>
                  <span className="text-xs text-muted">Postlar draft bo&apos;lib yaratiladi; vaqti borlari media tayyor bo&apos;lishi bilan rejalashtiriladi.</span>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {commit && (
        <section className="space-y-2 rounded-2xl border border-border bg-surface p-4 text-sm">
          <h3 className="font-semibold">Natija</h3>
          <p>
            {commit.created} ta post yaratildi{commit.failed > 0 ? `, ${commit.failed} ta qator import bo'lmadi` : ""}.
          </p>
          <ul className="space-y-1 text-xs">
            {commit.results.map((r) => {
              const failedSchedule = schedule?.failed.find((f) => f.postId === r.postId);
              const scheduled = schedule?.scheduled.find((s) => s.postId === r.postId);
              const status = !r.ok
                ? { tone: "error" as const, text: r.error ?? "Xato" }
                : !r.wantsSchedule
                  ? { tone: "muted" as const, text: "Draft" }
                  : failedSchedule
                    ? { tone: "error" as const, text: `Rejalashtirilmadi: ${failedSchedule.error}` }
                    : scheduled
                      ? { tone: "success" as const, text: `Rejalashtirildi${scheduled.scheduledAt ? ` · ${formatZoned(new Date(scheduled.scheduledAt), meta.timezone)}` : ""}` }
                      : { tone: "warning" as const, text: "Media qayta ishlanmoqda — keyin rejalashtiriladi" };
              return (
                <li key={r.row} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{r.row}-qator</span>
                  <Pill tone={status.tone}>{status.text}</Pill>
                  {r.warnings.length > 0 && <span className="text-warning">{r.warnings.join("; ")}</span>}
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            className={secondaryButton}
            onClick={() => {
              setCsv(null);
              setFileName("");
              setPreview(null);
              setCommit(null);
              setSchedule(null);
            }}
          >
            Yangi fayl
          </button>
        </section>
      )}
    </div>
  );
}
