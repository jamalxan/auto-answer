"use client";

/**
 * Dry run against the SAVED Direct / Story Mention campaigns of the account:
 * which one would answer this message (from this kind of person, from this
 * source), why, and with what. Sends and stores nothing.
 */

import { useRef, useState } from "react";
import { Choice, Field, inputClass, primaryButton } from "@/components/developer/ui";
import { Notice } from "@/components/developer/comments/parts";
import { jsonInit, MATCH_KIND_TEXT, requestJson } from "@/components/developer/comments/shared";
import { DM_API, type DmKind } from "./shared";

interface SimulationResult {
  matched: boolean;
  campaignId?: string;
  campaignName?: string;
  matchKind?: string;
  matchedKeyword?: string | null;
  replyPreview?: string | null;
  quickReplies?: string[];
  reason?: string | null;
}

const CONTACT_STATES = [
  ["NEW", "Yangi odam", "Birinchi marta yozmoqda"],
  ["RETURNING", "Qaytgan odam", "Avval ham yozgan"],
  ["REOPENED", "Uzoq tanaffusdan keyin", "Oxirgi xabaridan ko'p vaqt o'tgan"],
] as const;
type ContactState = (typeof CONTACT_STATES)[number][0];

const SOURCES = [
  ["", "Oddiy xabar"],
  ["ADS", "Reklamadan"],
  ["LINK", "ig.me havoladan"],
] as const;
type Source = (typeof SOURCES)[number][0];

const DM_MATCH_KIND_TEXT: Record<string, string> = { ...MATCH_KIND_TEXT, EVERY: "Har bir xabar", MENTION: "Story mention" };

function defaultSource(kind: DmKind): Source {
  return kind === "AD_MESSAGE" ? "ADS" : kind === "LINK" ? "LINK" : "";
}

export default function DmSimulator({
  accountId,
  campaignId,
  kind,
  sampleAdId,
  sampleRef,
  dirty,
  active,
}: {
  accountId: string;
  campaignId: string | null;
  kind: DmKind;
  sampleAdId?: string;
  sampleRef?: string;
  dirty: boolean;
  active: boolean;
}) {
  const mention = kind === "STORY_MENTION";
  const [text, setText] = useState("Narxi qancha?");
  const [contactState, setContactState] = useState<ContactState>("NEW");
  const [source, setSource] = useState<Source>(defaultSource(kind));
  const [adId, setAdId] = useState(sampleAdId ?? "");
  const [ref, setRef] = useState(sampleRef ?? "");
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
        `${DM_API}/simulate`,
        jsonInit("POST", {
          instagramAccountId: accountId,
          eventType: mention ? "STORY_MENTION" : "DIRECT_MESSAGE",
          text: mention ? "" : text,
          referralSource: mention ? null : source || null,
          adId: source === "ADS" ? adId.trim() || null : null,
          ref: source === "LINK" ? ref.trim() || null : null,
          contactState,
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
      {dirty && <Notice tone="warning">Saqlanmagan o&apos;zgarishlar bor — test saqlangan sozlamalar bo&apos;yicha ishlaydi.</Notice>}

      {mention ? (
        <p className="text-xs text-muted">Story mention&apos;da matn bo&apos;lmaydi: odam story&apos;sida akkauntni belgilaydi.</p>
      ) : (
        <Field label="Xabar matni">
          <input className={inputClass} value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} />
        </Field>
      )}

      <Field label="Kim yozmoqda">
        <div className="grid gap-2 sm:grid-cols-3">
          {CONTACT_STATES.map(([key, title, description]) => (
            <Choice
              key={key}
              checked={contactState === key}
              onSelect={() => setContactState(key)}
              title={title}
              description={description}
            />
          ))}
        </div>
      </Field>

      {!mention && (
        <Field label="Qayerdan keldi">
          <div className="grid gap-2 sm:grid-cols-3">
            {SOURCES.map(([key, title]) => (
              <Choice key={key || "plain"} checked={source === key} onSelect={() => setSource(key)} title={title} />
            ))}
          </div>
          {source === "ADS" && (
            <input
              className={inputClass}
              value={adId}
              onChange={(e) => setAdId(e.target.value)}
              placeholder="Reklama ID (ixtiyoriy), masalan 120211234567890"
              aria-label="Reklama ID"
            />
          )}
          {source === "LINK" && (
            <input
              className={inputClass}
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              placeholder="ref, masalan promo_oktabr"
              aria-label="Havola ref"
            />
          )}
        </Field>
      )}

      <button
        type="button"
        className={primaryButton}
        disabled={running || !accountId || (!mention && !text.trim())}
        onClick={() => void run()}
      >
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
                Bu xabarni boshqa kampaniya oladi (u yuqoriroq prioritetda yoki aniqroq mos keldi).
              </p>
            )}
            <p className="text-xs text-muted">
              Sabab: {DM_MATCH_KIND_TEXT[result.matchKind ?? ""] ?? result.matchKind ?? "—"}
              {result.matchedKeyword ? ` · “${result.matchedKeyword}”` : ""}
            </p>
            {result.replyPreview && (
              <div>
                <p className="label-mono text-[10px] text-muted">Direct javob</p>
                <p className="whitespace-pre-wrap break-words rounded-md bg-surface-hover px-2 py-1.5 text-foreground">
                  {result.replyPreview}
                </p>
              </div>
            )}
            {result.quickReplies && result.quickReplies.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {result.quickReplies.map((label) => (
                  <span key={label} className="rounded-full border border-accent/40 px-2 py-0.5 text-[11px] text-accent">
                    {label}
                  </span>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-border p-3 text-sm">
            <p className="font-semibold text-foreground">Hech qaysi kampaniya javob bermaydi</p>
            <p className="mt-1 text-xs text-muted">{result.reason ?? "Mos kampaniya topilmadi."}</p>
          </div>
        ))}
    </div>
  );
}
