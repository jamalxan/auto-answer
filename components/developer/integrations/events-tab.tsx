"use client";

/**
 * Hodisalar: the event catalogue with the documented sample payload of each
 * type, a payload preview built from a real lead, "send a test event" (an
 * is_test event: only subscriptions with include_test receive it) and the
 * most recent events of the workspace.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { EmptyState, Field, formatDateTime, inputClass, secondaryButton } from "@/components/developer/ui";
import { INTEGRATIONS_API, jsonInit, requestJson, type EventType, type Meta } from "./shared";

interface EventsResponse {
  catalogue: Array<{ type: EventType; label: string; description: string; sample: string }>;
  recent: Array<{
    id: string;
    type: string;
    subjectType: string;
    isTest: boolean;
    occurredAt: string;
    materializedAt: string | null;
    deliveries: number;
    sent: number;
    dead: number;
  }>;
}

export default function EventsTab({ meta }: { meta: Meta }) {
  const [data, setData] = useState<EventsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<EventType | null>("lead.created");
  const [leadId, setLeadId] = useState("");
  const [preview, setPreview] = useState<{ type: EventType; json: string; source: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(null);
    const res = await requestJson<EventsResponse>(`${INTEGRATIONS_API}/events`);
    if (mine !== seq.current) return;
    if (res.ok) setData(res.data);
    else setError(res.error);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
    const counter = seq;
    return () => {
      counter.current++;
    };
  }, [load]);

  async function emitTest(type: EventType) {
    setBusy(`emit:${type}`);
    setNotice(null);
    setError(null);
    try {
      const res = await requestJson<{ matched: number; deliveries: number }>(`${INTEGRATIONS_API}/events/emit-test`, jsonInit("POST", { type }));
      if (res.ok) {
        setNotice(
          res.data.matched === 0
            ? "Test hodisa yaratildi, lekin hech bir obuna uni olmaydi: obunada «Test hodisalar ham» yoqilgan bo'lishi kerak. Ulanish kartasidagi «Sinash» tugmasi esa to'g'ridan-to'g'ri yuboradi."
            : `Test hodisa ${res.data.deliveries} ta ulanishga navbatga qo'yildi — natija Yetkazishlar tabida.`
        );
        void load();
      } else setError(res.error);
    } finally {
      setBusy(null);
    }
  }

  async function loadPreview(type: EventType) {
    setBusy(`preview:${type}`);
    setError(null);
    try {
      const query = new URLSearchParams({ type });
      if (leadId.trim()) query.set("leadId", leadId.trim());
      const res = await requestJson<{ json: string; source: string }>(`${INTEGRATIONS_API}/payload-preview?${query.toString()}`);
      if (res.ok) setPreview({ type, json: res.data.json, source: res.data.source });
      else setError(res.error);
    } finally {
      setBusy(null);
    }
  }

  if (!data) {
    return error ? <Notice tone="error">{error}</Notice> : <p className="py-10 text-center text-sm text-muted">Yuklanmoqda…</p>;
  }

  return (
    <div className="space-y-4">
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice tone="info">{notice}</Notice>}

      <section className="panel space-y-3 rounded-xl p-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Hodisalar katalogi</h2>
          <p className="mt-1 text-xs text-muted">
            Har bir hodisa bir xil v1 payload shaklida keladi (snake_case — Make / Zapier maydonlariga qulay). Qo&apos;llanilmaydigan bo&apos;limlar <code>null</code>.
          </p>
        </div>
        <Field label="Haqiqiy lead bilan ko'rish (ixtiyoriy)" hint="Lead ID kiriting va lead.* hodisasida «Haqiqiy payload»ni bosing — qabul qiluvchi aynan shuni oladi.">
          <input className={inputClass} value={leadId} onChange={(e) => setLeadId(e.target.value)} placeholder="Lead ID" autoComplete="off" />
        </Field>
        <ul className="divide-y divide-border">
          {data.catalogue.map((event) => {
            const expanded = open === event.type;
            const shown = preview?.type === event.type ? preview : null;
            return (
              <li key={event.type} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    className="min-w-0 text-left"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : event.type)}
                  >
                    <span className="block text-sm font-medium text-foreground">
                      {event.label} <span className="font-mono text-xs text-muted">{event.type}</span>
                    </span>
                    <span className="block text-xs text-muted">{event.description}</span>
                  </button>
                  <div className="flex flex-wrap gap-2">
                    {event.type.startsWith("lead.") && (
                      <button type="button" className={secondaryButton} disabled={busy !== null} onClick={() => void loadPreview(event.type)}>
                        {busy === `preview:${event.type}` ? "Yuklanmoqda…" : "Haqiqiy payload"}
                      </button>
                    )}
                    <button type="button" className={secondaryButton} disabled={busy !== null || !meta.me.canWrite} onClick={() => void emitTest(event.type)}>
                      {busy === `emit:${event.type}` ? "Yuborilmoqda…" : "Test hodisa yuborish"}
                    </button>
                  </div>
                </div>
                {expanded && (
                  <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-surface p-3 text-xs text-foreground" tabIndex={0} aria-label={`${event.type} payload`}>
                    {shown ? shown.json : event.sample}
                  </pre>
                )}
                {expanded && shown && <p className="mt-1 text-xs text-muted">Manba: {shown.source === "lead" ? "haqiqiy lead" : "namuna"}</p>}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="panel rounded-xl">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">So&apos;nggi hodisalar</h2>
          <button type="button" className={secondaryButton} onClick={() => void load()}>
            Yangilash
          </button>
        </div>
        {data.recent.length === 0 ? (
          <EmptyState title="Hali hodisa yo'q" body="Lead yaratilganda, teg qo'shilganda yoki operatorga o'tilganda shu yerda ko'rinadi." />
        ) : (
          <ul className="divide-y divide-border">
            {data.recent.map((event) => (
              <li key={event.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-mono text-foreground">{event.type}</span>
                  {event.isTest && <span className="label-mono ml-2 text-[10px] text-gold">TEST</span>}
                  <span className="ml-2 text-xs text-muted">{formatDateTime(event.occurredAt)}</span>
                </span>
                <span className="text-xs text-muted">
                  {event.materializedAt ? `${event.deliveries} yetkazish · ${event.sent} yuborildi${event.dead ? ` · ${event.dead} DEAD` : ""}` : "tayyorlanmoqda…"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
