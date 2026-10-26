"use client";

/**
 * Test objects left in the workspace (audit 2026-10-26): TEST… campaigns and
 * draft flows, test leads. They skew the statistics; the owner picks and deletes.
 */

import { useCallback, useEffect, useState } from "react";
import { ConfirmButton, Notice } from "@/components/developer/comments/parts";
import { jsonInit, requestJson } from "@/components/developer/comments/shared";
import { EmptyState, formatDateTime, Pill } from "@/components/developer/ui";

interface Item {
  kind: "campaign" | "flow" | "lead";
  id: string;
  label: string;
  createdAt: string;
}

const KIND_LABEL: Record<Item["kind"], string> = { campaign: "Kampaniya", flow: "Flow", lead: "Test lid" };
const key = (i: Pick<Item, "kind" | "id">) => `${i.kind}:${i.id}`;

export default function TestDataTab() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await requestJson<{ items: Item[] }>("/api/developer/foundation/test-data");
    if (res.ok) {
      setItems(res.data.items);
      setPicked(new Set(res.data.items.map(key)));
    } else setMessage({ tone: "error", text: res.error });
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
  }, [load]);

  async function remove() {
    if (!items) return;
    setBusy(true);
    setMessage(null);
    try {
      const chosen = items.filter((i) => picked.has(key(i))).map(({ kind, id }) => ({ kind, id }));
      const res = await requestJson<{ campaigns: number; flows: number; leads: number }>("/api/developer/foundation/test-data", jsonInit("DELETE", { items: chosen }));
      if (res.ok) setMessage({ tone: "info", text: `O'chirildi: ${res.data.campaigns} kampaniya, ${res.data.flows} flow, ${res.data.leads} test lid.` });
      else setMessage({ tone: "error", text: res.error });
    } finally {
      setBusy(false);
      void load();
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Nomi &quot;TEST&quot; bilan boshlanadigan o&apos;chiq kampaniyalar va e&apos;lon qilinmagan flow&apos;lar, sandbox / &quot;test&quot; deb belgilangan lidlar. Ular statistikani buzadi. Faqat tanlanganlar o&apos;chadi — va faqat o&apos;chirish paytida ham shu qoidaga mos kelsa.
      </p>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      {items === null ? (
        <p className="py-6 text-center text-sm text-muted">Yuklanmoqda…</p>
      ) : items.length === 0 ? (
        <div className="panel rounded-xl">
          <EmptyState title="Test ma'lumot yo'q" body="Ish maydoni toza." />
        </div>
      ) : (
        <>
          <ul className="space-y-1.5">
            {items.map((item) => (
              <li key={key(item)} className="panel flex items-center gap-3 rounded-xl px-4 py-2.5 text-sm">
                <input
                  type="checkbox"
                  aria-label={`${KIND_LABEL[item.kind]}: ${item.label}`}
                  checked={picked.has(key(item))}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(key(item));
                    else next.delete(key(item));
                    setPicked(next);
                  }}
                />
                <Pill tone="muted">{KIND_LABEL[item.kind]}</Pill>
                <span className="min-w-0 flex-1 truncate text-foreground">{item.label}</span>
                <span className="shrink-0 text-xs text-muted">{formatDateTime(item.createdAt)}</span>
              </li>
            ))}
          </ul>
          <ConfirmButton
            label={`Tanlanganlarni o'chirish (${picked.size})`}
            question="Tanlangan test obyektlari butunlay o'chiriladi. Davom etamizmi?"
            busy={busy}
            disabled={picked.size === 0}
            danger
            onConfirm={() => void remove()}
          />
        </>
      )}
    </div>
  );
}
