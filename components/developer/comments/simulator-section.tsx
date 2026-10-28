"use client";

/**
 * Dry run against the SAVED campaigns of the account: which one would answer
 * this comment, why, and with what. Sends and stores nothing.
 */

import { useRef, useState } from "react";
import { Field, inputClass, primaryButton } from "@/components/developer/ui";
import { Notice } from "./parts";
import { jsonInit, MATCH_KIND_TEXT, requestJson } from "./shared";

interface SimulationResult {
  matched: boolean;
  campaignId?: string;
  campaignName?: string;
  matchKind?: string;
  matchedKeyword?: string | null;
  dmPreview?: string | null;
  publicPreview?: string | null;
  reason?: string | null;
}

export default function SimulatorSection({
  accountId,
  campaignId,
  mediaIds,
  dirty,
  active,
  eventType = "COMMENT",
}: {
  accountId: string;
  /** The campaign being edited, to say "this one" vs "another campaign". */
  campaignId: string | null;
  mediaIds: string[];
  /** Unsaved changes: the test runs on what is saved. */
  dirty: boolean;
  /** Off campaigns are still tested (the simulator treats the edited one as active). */
  active: boolean;
  /** Live campaigns are tested as a live comment: no post to pick. */
  eventType?: "COMMENT" | "LIVE_COMMENT";
}) {
  const [text, setText] = useState("Narxi qancha?");
  const [mediaId, setMediaId] = useState("");
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const seq = useRef(0);

  async function run() {
    const mine = ++seq.current;
    setRunning(true);
    setError(null);
    try {
      const res = await requestJson<SimulationResult>(
        "/api/comments/simulate",
        jsonInit("POST", {
          instagramAccountId: accountId,
          text,
          mediaId: eventType === "LIVE_COMMENT" ? null : mediaId.trim() || null,
          eventType,
          campaignId,
        })
      );
      if (mine !== seq.current) return;
      if (res.ok) setResult(res.data);
      else {
        setResult(null);
        setError(res.error);
      }
    } finally {
      if (mine === seq.current) setRunning(false);
    }
  }

  const isThis = result?.matched && campaignId && result.campaignId === campaignId;

  return (
    <div className="space-y-3">
      {!active && (
        <Notice tone="info">
          {campaignId
            ? "Kampaniya hozir o'chiq (qoralama/pauza) — test uni faol deb hisoblab tekshiradi. Test faqat simulyator: hech narsa yuborilmaydi."
            : "Kampaniya hali saqlanmagan — avval «Saqlash» ni bosing, shunda test uni ham tekshiradi."}
        </Notice>
      )}
      {dirty && (
        <Notice tone="warning">Saqlanmagan o&apos;zgarishlar bor — test saqlangan sozlamalar bo&apos;yicha ishlaydi.</Notice>
      )}
      <div className={`grid gap-3 ${eventType === "LIVE_COMMENT" ? "" : "sm:grid-cols-[minmax(0,1fr)_200px]"}`}>
        <Field label={eventType === "LIVE_COMMENT" ? "Live efirdagi komment" : "Komment matni"}>
          <input className={inputClass} value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} />
        </Field>
        {eventType !== "LIVE_COMMENT" && (
          <Field label="Post">
            <select className={inputClass} value={mediaId} onChange={(e) => setMediaId(e.target.value)}>
              <option value="">Istalgan post</option>
              {mediaIds.map((id) => (
                <option key={id} value={id}>
                  Post #{id.slice(-6)}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <button type="button" className={primaryButton} disabled={running || !accountId || !text.trim()} onClick={() => void run()}>
        {running ? "Tekshirilmoqda…" : "Tekshirish"}
      </button>
      {error && <Notice tone="error">{error}</Notice>}

      {result &&
        (result.matched ? (
          <div className="space-y-2 rounded-lg border border-success/30 bg-success/5 p-3 text-sm">
            <p className="font-semibold text-success">
              ✓ {isThis ? "Shu kampaniya" : `“${result.campaignName ?? "Boshqa kampaniya"}”`} javob beradi
            </p>
            {!isThis && campaignId && (
              <p className="text-xs text-warning">
                Bu kommentni boshqa kampaniya oladi (u yuqoriroq prioritetda yoki aniqroq mos keldi).
              </p>
            )}
            <p className="text-xs text-muted">
              Sabab: {MATCH_KIND_TEXT[result.matchKind ?? ""] ?? result.matchKind ?? "—"}
              {result.matchedKeyword ? ` · “${result.matchedKeyword}”` : ""}
            </p>
            {result.publicPreview && (
              <div>
                <p className="label-mono text-[10px] text-muted">Ochiq javob</p>
                <p className="whitespace-pre-wrap break-words rounded-md bg-surface-hover px-2 py-1.5 text-foreground">
                  {result.publicPreview}
                </p>
              </div>
            )}
            {result.dmPreview && (
              <div>
                <p className="label-mono text-[10px] text-muted">Direct xabar</p>
                <p className="whitespace-pre-wrap break-words rounded-md bg-surface-hover px-2 py-1.5 text-foreground">
                  {result.dmPreview}
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-border p-3 text-sm">
            <p className="font-semibold text-foreground">Hech qaysi kampaniya javob bermaydi</p>
            <p className="mt-1 text-xs text-muted">{result.reason ?? "Mos kalit so'z yoki intent topilmadi."}</p>
          </div>
        ))}
    </div>
  );
}
