"use client";

import { ServerOffNotice } from "@/components/developer/server-off";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { TRIGGER_OPTIONS } from "@/components/developer/flows/shared";
import { Field, inputClass, Pill, primaryButton, secondaryButton } from "@/components/developer/ui";
import ConversionPreviewView from "./conversion-preview";
import DetectedPanel from "./detected-panel";
import {
  formatBytes,
  jsonInit,
  MIGRATION_API,
  readFileAsBase64,
  SCREENSHOT_TYPES,
  requestJson,
  STATUS_TEXT,
  type ConversionPreview,
  type ImportedFlow,
  type Limits,
  type MigrationItem,
  type MigrationMeta,
  type ProjectDetail,
  type TextAnalysis,
} from "./shared";

interface Shot {
  id: string;
  name: string;
  bytes: number;
  dataUrl: string;
  mediaType: string;
}

/**
 * Side drawer for one ManyChat flow: paste text and/or screenshots, see what
 * the analyzer detects, convert with AI, review the preview, save as a draft.
 * Screenshots live only in this component's memory; they are sent to the
 * server to be read into text and are never persisted.
 */
export default function FlowDrawer({
  project,
  item,
  meta,
  limits,
  canWrite,
  canConvert,
  onClose,
  onChanged,
}: {
  project: ProjectDetail;
  item: MigrationItem;
  meta: MigrationMeta;
  limits: Limits;
  canWrite: boolean;
  /** canWrite and the kill switch is off. */
  canConvert: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const base = `${MIGRATION_API}/projects/${project.id}/items/${item.id}`;
  const [text, setText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [loadingText, setLoadingText] = useState(item.hasText);
  const [note, setNote] = useState<string | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [accountId, setAccountId] = useState(project.instagramAccountId ?? meta.accounts[0]?.id ?? "");
  const [triggerType, setTriggerType] = useState("COMMENT");
  const [analysis, setAnalysis] = useState<TextAnalysis | null>(null);
  const [analysing, setAnalysing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "save" | "convert" | "import" | "skip">(null);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ConversionPreview | null>(null);
  const [imported, setImported] = useState<ImportedFlow | null>(null);
  const [skipConfirm, setSkipConfirm] = useState(false);
  const analyseSeq = useRef(0);
  const loadSeq = useRef(0);
  const closeRef = useRef<HTMLButtonElement>(null);

  const dirty = text !== savedText || shots.length > 0;
  const tooLong = text.length > limits.maxFlowText;
  const hasInput = text.trim().length > 0 || shots.length > 0;

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The project read only carries a preview; fetch the full stored text once.
  useEffect(() => {
    if (!item.hasText) return;
    const mine = ++loadSeq.current;
    void (async () => {
      try {
        const res = await requestJson<{ item: MigrationItem }>(base);
        if (mine !== loadSeq.current) return;
        if (res.ok) {
          const stored = res.data.item.sourceText ?? "";
          setText(stored);
          setSavedText(stored);
        } else setError(res.error);
      } finally {
        if (mine === loadSeq.current) setLoadingText(false);
      }
    })();
    const counter = loadSeq;
    return () => {
      counter.current++;
    };
  }, [base, item.hasText]);

  // Live preview of detected features (debounced, stale responses dropped).
  useEffect(() => {
    const mine = ++analyseSeq.current;
    if (!text.trim() || tooLong) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when the text is emptied
      setAnalysis(null);
      setAnalysing(false);
      return;
    }
    setAnalysing(true);
    const timer = setTimeout(async () => {
      try {
        const res = await requestJson<TextAnalysis>(`${base}/analyze-text`, jsonInit("POST", { text }));
        if (mine !== analyseSeq.current) return;
        if (res.ok) {
          setAnalysis(res.data);
          setAnalysisError(null);
        } else setAnalysisError(res.error);
      } finally {
        if (mine === analyseSeq.current) setAnalysing(false);
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [text, tooLong, base]);

  async function addFiles(files: FileList | null) {
    if (!files) return;
    setFileError(null);
    const next = [...shots];
    for (const file of Array.from(files)) {
      if (next.length >= limits.maxScreenshots) {
        setFileError(`Ko'pi bilan ${limits.maxScreenshots} ta rasm. Ortiqchasi qo'shilmadi.`);
        break;
      }
      if (!(SCREENSHOT_TYPES as readonly string[]).includes(file.type)) {
        setFileError(`${file.name}: PNG, JPEG yoki WebP bo'lishi kerak. Yechim: ekran rasmini shu formatda saqlang.`);
        continue;
      }
      if (file.size > limits.maxScreenshotBytes) {
        setFileError(`${file.name}: ${formatBytes(file.size)} — har bir rasm ${formatBytes(limits.maxScreenshotBytes)} dan oshmasin. Yechim: kichraytiring yoki qirqing.`);
        continue;
      }
      try {
        next.push({ id: `${file.name}-${file.size}-${next.length}`, name: file.name, bytes: file.size, dataUrl: await readFileAsBase64(file), mediaType: file.type });
      } catch {
        setFileError(`${file.name}: o'qib bo'lmadi. Qayta tanlang.`);
      }
    }
    setShots(next);
  }

  /** Stores the text (screenshots are read into text on the server and dropped). */
  const saveText = useCallback(async (): Promise<boolean> => {
    setBusy("save");
    setError(null);
    try {
      const body: { text?: string; images?: Array<{ mediaType: string; base64: string }> } = {};
      if (text.trim()) body.text = text;
      if (shots.length > 0) body.images = shots.map((s) => ({ mediaType: s.mediaType, base64: s.dataUrl.replace(/^data:[^;]+;base64,/, "") }));
      const res = await requestJson<{ item: MigrationItem; extractedChars?: number; truncated?: boolean }>(`${base}/text`, jsonInit("PUT", body));
      if (!res.ok) {
        setError(res.error);
        return false;
      }
      const next = res.data.item.sourceText ?? text;
      setText(next);
      setSavedText(next);
      const notes: string[] = [];
      if (shots.length > 0) notes.push(`Rasmlardan ${res.data.extractedChars ?? 0} belgi matn o'qildi; rasmlar saqlanmadi.`);
      if (res.data.truncated) notes.push(`Matn ${limits.maxFlowText} belgigacha qisqartirildi — oxirini alohida flow sifatida kiriting.`);
      setNote(notes.length ? notes.join(" ") : "Matn saqlandi.");
      setShots([]);
      setPreview(null);
      onChanged();
      return true;
    } finally {
      setBusy(null);
    }
  }, [base, text, shots, onChanged, limits.maxFlowText]);

  async function convert() {
    setError(null);
    if (dirty && !(await saveText())) return;
    setBusy("convert");
    try {
      const res = await requestJson<ConversionPreview>(`${base}/convert`, jsonInit("POST", { instagramAccountId: accountId, triggerType }));
      if (res.ok) setPreview(res.data);
      else setError(res.error);
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  async function importDraft() {
    if (!preview) return;
    setBusy("import");
    setError(null);
    try {
      const res = await requestJson<ImportedFlow>(`${base}/import`, jsonInit("POST", { instagramAccountId: accountId, triggerType, graph: preview.graph, ...(preview.name ? { name: preview.name } : {}) }));
      if (res.ok) {
        setImported(res.data);
        onChanged();
      } else setError(res.error);
    } finally {
      setBusy(null);
    }
  }

  async function skip() {
    setBusy("skip");
    setError(null);
    try {
      const res = await requestJson(base, jsonInit("PATCH", { status: "SKIPPED" }));
      if (res.ok) {
        onChanged();
        onClose();
      } else setError(res.error);
    } finally {
      setBusy(null);
    }
  }

  const noAccount = !accountId;
  const locked = !canWrite || busy !== null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside role="dialog" aria-modal="true" aria-label={`${item.name} flow'i`} className="flex h-full w-full max-w-2xl flex-col overflow-y-auto bg-background shadow-xl">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-2 border-b border-border bg-background p-4">
          <div className="min-w-0">
            <h2 className="break-words text-base font-semibold text-foreground">{item.name}</h2>
            <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
              {item.folder ? `Papka: ${item.folder}` : "Papkasiz"}
              <Pill tone={STATUS_TEXT[item.status].tone}>{STATUS_TEXT[item.status].label}</Pill>
              {dirty && <span className="text-warning">Saqlanmagan o&apos;zgarishlar</span>}
            </p>
          </div>
          <button ref={closeRef} type="button" className={secondaryButton} onClick={onClose} aria-label="Yopish">
            Yopish
          </button>
        </div>

        <div className="space-y-5 p-4">
          {!canWrite && <Notice tone="warning">Faqat ko&apos;rish rejimi: matn kiritish va aylantirish uchun Menejer roli kerak.</Notice>}
          {canWrite && !canConvert && <ServerOffNotice what="Migratsiya o'chirilgan: matnni saqlab bo'lmaydi va aylantirib bo'lmaydi." ops={<><code>MIGRATION_DISABLED</code> ni olib tashlang.</>} />}
          {item.warnings.length > 0 && (
            <Notice tone="warning">
              <ul className="list-disc pl-4">
                {item.warnings.map((w, i) => (
                  <li key={i}>{w.message}</li>
                ))}
              </ul>
            </Notice>
          )}

          {loadingText && <p className="text-xs text-muted">Saqlangan matn yuklanmoqda…</p>}
          {note && <Notice tone="info">{note}</Notice>}
          <Field label="Flow matni" hint="ManyChat flow'dagi qadamlarni tartib bilan yozing yoki nusxalab joylang: xabarlar, tugmalar, shartlar, kutishlar, amallar.">
            <textarea
              className={`${inputClass} min-h-48 resize-y font-mono text-xs`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={locked || !canConvert || loadingText}
              aria-label="Flow matni"
              aria-invalid={tooLong}
            />
            <span className={`text-xs ${tooLong ? "text-error" : "text-muted"}`}>
              {text.length} / {limits.maxFlowText}
              {tooLong ? " — juda uzun. Yechim: flow'ni qismlarga bo'ling." : ""}
            </span>
          </Field>

          <Field label={`Ekran rasmlari (${shots.length}/${limits.maxScreenshots})`} hint={`Rasm matnga o'qiladi va saqlanmaydi (PNG, JPEG, WebP). Har biri ${formatBytes(limits.maxScreenshotBytes)} gacha.`}>
            <input
              type="file"
              accept="image/*"
              multiple
              disabled={locked || !canConvert || shots.length >= limits.maxScreenshots}
              onChange={(e) => {
                void addFiles(e.target.files);
                e.target.value = "";
              }}
              aria-label="Ekran rasmlarini yuklash"
              className="text-xs text-muted"
            />
            {fileError && <p className="text-xs text-error">{fileError}</p>}
            {shots.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {shots.map((s) => (
                  <li key={s.id} className="relative w-24">
                    {/* eslint-disable-next-line @next/next/no-img-element -- local data URL preview, never uploaded as a file */}
                    <img src={s.dataUrl} alt={`Ekran rasmi: ${s.name}`} className="h-24 w-24 rounded-lg border border-border object-cover" />
                    <p className="truncate text-[10px] text-muted">{formatBytes(s.bytes)}</p>
                    <button
                      type="button"
                      className="absolute right-1 top-1 rounded-full bg-background/90 px-1.5 text-xs text-foreground"
                      aria-label={`${s.name} rasmini olib tashlash`}
                      disabled={locked}
                      onClick={() => setShots((list) => list.filter((x) => x.id !== s.id))}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Field>

          <DetectedPanel analysis={analysis} catalog={meta.catalog} loading={analysing} error={analysisError} empty={!text.trim()} />

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Maqsad Instagram akkaunt" error={noAccount ? "Akkaunt tanlang — flow shu akkauntga qoralama bo'ladi." : null}>
              <select className={inputClass} value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={locked} aria-label="Maqsad Instagram akkaunt">
                <option value="">Tanlang…</option>
                {meta.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    @{a.username}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Trigger turi">
              <select className={inputClass} value={triggerType} onChange={(e) => setTriggerType(e.target.value)} disabled={locked} aria-label="Trigger turi">
                {TRIGGER_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {error && <Notice tone="error">{error}</Notice>}

          <div className="flex flex-wrap gap-2">
            <button type="button" className={secondaryButton} disabled={locked || !canConvert || !dirty || tooLong} onClick={() => void saveText()}>
              {busy === "save" ? "Saqlanmoqda…" : "Matnni saqlash"}
            </button>
            <button type="button" className={primaryButton} disabled={locked || !canConvert || !hasInput || tooLong || noAccount} onClick={() => void convert()}>
              {busy === "convert" ? "AI aylantirmoqda…" : "AI bilan aylantirish"}
            </button>
          </div>

          {preview && (
            <div className="space-y-4 border-t border-border pt-4">
              <h3 className="text-base font-semibold text-foreground">Natija ko&apos;rinishi</h3>
              <ConversionPreviewView preview={preview} />
              {imported ? (
                <div className="space-y-2 rounded-lg border border-success/30 bg-success/5 p-3" role="status">
                  <p className="text-sm font-semibold text-success">Qoralama sifatida saqlandi — nashr qilinmadi.</p>
                  <Link className={primaryButton} href={imported.link ?? `/flows?flow=${imported.flowId}`}>
                    Flows&apos;da ochish va sinash
                  </Link>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={primaryButton} disabled={locked || !canConvert || dirty} onClick={() => void importDraft()}>
                    {busy === "import" ? "Saqlanmoqda…" : "Qoralama sifatida saqlash"}
                  </button>
                </div>
              )}
              {preview.policy.verdict === "BLOCKED" && !imported && (
                <p className="text-xs text-warning">Policy BLOCKED: qoralama sifatida saqlash mumkin, lekin Flows&apos;da tuzatmaguncha nashr qilib bo&apos;lmaydi.</p>
              )}
            </div>
          )}

          <div className="border-t border-border pt-4">
            {skipConfirm ? (
              <div className="space-y-2 rounded-lg border border-border p-3" role="group" aria-label="O'tkazib yuborishni tasdiqlash">
                <p className="text-sm text-foreground">Bu flow ko&apos;chirilmaydi deb belgilanadi (keyin qaytarish mumkin). Davom etasizmi?</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={primaryButton} disabled={locked} onClick={() => void skip()}>
                    {busy === "skip" ? "Belgilanmoqda…" : "Ha, o'tkazib yuborish"}
                  </button>
                  <button type="button" className={secondaryButton} disabled={busy !== null} onClick={() => setSkipConfirm(false)}>
                    Bekor qilish
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className={secondaryButton} disabled={locked} onClick={() => setSkipConfirm(true)}>
                O&apos;tkazib yuborish
              </button>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
