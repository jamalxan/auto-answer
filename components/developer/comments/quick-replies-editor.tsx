"use client";

/**
 * Quick-reply buttons on the main message (Meta: max 13, 20 characters).
 * FLOW arrives with ETAP 6 and is listed, disabled. AI (ETAP 4) hands the
 * thread to JavobAI — only on an account switched to LIVE in /developer/javobai;
 * anywhere else it behaves like HANDOFF.
 */

import { COMMENT_LIMITS as L, QUICK_REPLY_ACTIONS, type QuickReplyAction } from "@/lib/triggers/comment-limits";
import { inputClass, secondaryButton } from "@/components/developer/ui";
import { CharCount } from "./parts";
import { QUICK_REPLY_ACTION_TEXT, uid } from "./shared";

export interface QuickReplyItem {
  key: string;
  id?: string;
  label: string;
  action: QuickReplyAction;
  responseText: string;
}

const RESPONSE_HINT: Record<QuickReplyAction, string> = {
  MESSAGE: "Tugma bosilganda yuboriladigan matn (majburiy)",
  LEAD_CAPTURE: "Ixtiyoriy: raqam so'rash matni. Instagram “raqamni ulashish” tugmasini o'zi ko'rsatadi.",
  HANDOFF: "Ixtiyoriy: “Operator tez orada yozadi” kabi matn. Avtomatika shu suhbatda to'xtaydi.",
  AI: "Ixtiyoriy: JavobAI javob berishdan oldin yuboriladigan matn. Faqat LIVE JavobAI akkauntida ishlaydi; aks holda “Operatorga o'tkazish” kabi.",
};

export default function QuickRepliesEditor({
  items,
  onChange,
}: {
  items: QuickReplyItem[];
  onChange: (items: QuickReplyItem[]) => void;
}) {
  const update = (key: string, patch: Partial<QuickReplyItem>) =>
    onChange(items.map((item) => (item.key === key ? { ...item, ...patch } : item)));

  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        <div key={item.key} className="space-y-2 rounded-lg border border-border p-2.5">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] sm:items-start">
            <div className="space-y-1">
              <input
                className={inputClass}
                value={item.label}
                maxLength={L.quickReplyLabelLength}
                aria-label={`${index + 1}-tugma nomi`}
                placeholder="Narx"
                onChange={(e) => update(item.key, { label: e.target.value })}
              />
              <CharCount value={item.label} max={L.quickReplyLabelLength} />
            </div>
            <select
              className={inputClass}
              value={item.action}
              aria-label={`${index + 1}-tugma harakati`}
              onChange={(e) => update(item.key, { action: e.target.value as QuickReplyAction })}
            >
              {QUICK_REPLY_ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {QUICK_REPLY_ACTION_TEXT[action]}
                </option>
              ))}
              <option disabled>Flow ishga tushirish — ETAP 6</option>
            </select>
            <button
              type="button"
              className="justify-self-start py-2 text-xs text-muted hover:text-error sm:justify-self-end"
              aria-label={`${index + 1}-tugmani o'chirish`}
              onClick={() => onChange(items.filter((r) => r.key !== item.key))}
            >
              O&apos;chirish
            </button>
          </div>
          <textarea
            className={`${inputClass} min-h-14`}
            value={item.responseText}
            maxLength={L.messageLength}
            aria-label={`${index + 1}-tugma javobi`}
            placeholder={RESPONSE_HINT[item.action]}
            onChange={(e) => update(item.key, { responseText: e.target.value })}
          />
          {item.action === "AI" && (
            <p className="text-xs text-muted">
              JavobAI faqat <b>LIVE</b> rejimdagi akkauntda javob beradi (Developer → JavobAI → Akkauntlar). OFF yoki
              SHADOW akkauntda bu tugma “Operatorga o&apos;tkazish” kabi ishlaydi.
            </p>
          )}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={secondaryButton}
          disabled={items.length >= L.quickReplies}
          onClick={() => onChange([...items, { key: uid(), label: "", action: "MESSAGE", responseText: "" }])}
        >
          + Quick reply
        </button>
        <span className="text-xs text-muted">
          {items.length}/{L.quickReplies}
        </span>
      </div>
    </div>
  );
}
