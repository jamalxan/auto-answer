"use client";

/**
 * Yetkazishlar: every OutboundDelivery with filters (ulanish / holat / hodisa),
 * paging, the payload + response viewer (payload only for manage roles),
 * per-delivery "Qayta yuborish" and a bulk "Barcha DEAD'larni qayta yuborish".
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmButton, Notice } from "@/components/developer/comments/parts";
import { EmptyState, Pill, formatDateTime, inputClass, secondaryButton } from "@/components/developer/ui";
import type { IntegrationsTab } from "./integrations-dashboard";
import {
  DELIVERY_LABEL,
  DELIVERY_TONE,
  INTEGRATIONS_API,
  formatDuration,
  jsonInit,
  requestJson,
  type DeliveryView,
  type IntegrationView,
  type Meta,
} from "./shared";

interface Props {
  meta: Meta;
  integrations: IntegrationView[];
  integrationId: string | null;
  navigate: (next: { tab?: IntegrationsTab; integration?: string | null }) => void;
  onChanged: () => void;
}

interface Page {
  deliveries: DeliveryView[];
  nextCursor: string | null;
}

interface Detail {
  delivery: DeliveryView;
  payload: unknown | null;
  payloadHidden: boolean;
}

const STATUSES: Array<DeliveryView["status"]> = ["PENDING", "FAILED", "SENT", "DEAD", "SKIPPED"];

function DetailPanel({
  id,
  canWrite,
  onClose,
  onRedelivered,
}: {
  id: string;
  canWrite: boolean;
  onClose: () => void;
  onRedelivered: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(null);
    const res = await requestJson<Detail>(`${INTEGRATIONS_API}/deliveries/${id}`);
    if (mine !== seq.current) return;
    if (res.ok) setDetail(res.data);
    else setError(res.error);
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load on open / id change
    void load();
    const counter = seq;
    return () => {
      counter.current++;
    };
  }, [load]);

  async function redeliver() {
    setBusy(true);
    setError(null);
    try {
      const res = await requestJson(`${INTEGRATIONS_API}/deliveries/${id}/redeliver`, jsonInit("POST", {}));
      if (res.ok) {
        onRedelivered();
        await load();
      } else setError(res.error);
    } finally {
      setBusy(false);
    }
  }

  const d = detail?.delivery;
  return (
    <section className="panel space-y-3 rounded-xl p-4" aria-label="Yetkazish tafsilotlari">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">Yetkazish tafsilotlari</h3>
        <div className="flex gap-2">
          {canWrite && (
            <ConfirmButton
              label="Qayta yuborish"
              question="Shu hodisa qayta yuborilsinmi?"
              busy={busy}
              disabled={!d}
              onConfirm={() => void redeliver()}
            />
          )}
          <button type="button" className={secondaryButton} onClick={onClose}>
            Yopish
          </button>
        </div>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {!d ? (
        !error && <p className="text-sm text-muted">Yuklanmoqda…</p>
      ) : (
        <>
          <dl className="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
            {[
              ["Holat", `${DELIVERY_LABEL[d.status]} · ${d.attempts}/${d.maxAttempts} urinish`],
              ["Hodisa", `${d.eventType}${d.isTest ? " (TEST)" : ""}`],
              ["Ulanish", d.integration?.name ?? "—"],
              ["HTTP", d.responseCode ? String(d.responseCode) : "—"],
              ["Davomiyligi", formatDuration(d.durationMs)],
              ["Keyingi urinish", formatDateTime(d.nextAttemptAt)],
              ["Yuborilgan", formatDateTime(d.sentAt)],
              ["Hodisa ID", d.eventId],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted">{label}</dt>
                <dd className="break-all text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
          {d.lastError && <Notice tone={d.status === "DEAD" ? "error" : "warning"}>{d.lastError}</Notice>}
          {d.signature && (
            <div>
              <p className="label-mono text-[11px] font-semibold text-muted">X-SocialAuto-Signature</p>
              <code className="block break-all rounded-md bg-surface px-3 py-2 font-mono text-[11px] text-foreground">{d.signature}</code>
            </div>
          )}
          <div>
            <p className="label-mono text-[11px] font-semibold text-muted">Javob (telefonlar yashirilgan)</p>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface p-3 text-xs text-foreground" tabIndex={0}>
              {d.responseSnippet || "—"}
            </pre>
          </div>
          <div>
            <p className="label-mono text-[11px] font-semibold text-muted">Yuborilgan payload</p>
            {detail?.payloadHidden ? (
              <Notice tone="info">Payload to&apos;liq telefon raqamlarini o&apos;z ichiga oladi — faqat menejer va undan yuqori rol ko&apos;radi.</Notice>
            ) : (
              <pre className="max-h-96 overflow-auto rounded-md bg-surface p-3 text-xs text-foreground" tabIndex={0}>
                {detail?.payload ? JSON.stringify(detail.payload, null, 2) : "Payload topilmadi (saqlash muddati o'tgan bo'lishi mumkin)."}
              </pre>
            )}
          </div>
        </>
      )}
    </section>
  );
}

export default function DeliveriesTab({ meta, integrations, integrationId, navigate, onChanged }: Props) {
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [rows, setRows] = useState<DeliveryView[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const seq = useRef(0);

  const query = useCallback(
    (after: string | null) => {
      const q = new URLSearchParams({ limit: "30" });
      if (integrationId) q.set("integrationId", integrationId);
      if (status) q.set("status", status);
      if (type) q.set("type", type);
      if (after) q.set("cursor", after);
      return q.toString();
    },
    [integrationId, status, type]
  );

  const load = useCallback(
    async (append: boolean, after: string | null = null) => {
      const mine = ++seq.current;
      setLoading(true);
      setError(null);
      try {
        const res = await requestJson<Page>(`${INTEGRATIONS_API}/deliveries?${query(after)}`);
        if (mine !== seq.current) return;
        if (res.ok) {
          setRows((prev) => (append && prev ? [...prev, ...res.data.deliveries] : res.data.deliveries));
          setCursor(res.data.nextCursor);
        } else setError(res.error);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [query]
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refetch when a filter changes
    void load(false);
    const counter = seq;
    return () => {
      counter.current++;
    };
  }, [load]);

  async function redeliverDead() {
    setBulkBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await requestJson<{ queued: number }>(
        `${INTEGRATIONS_API}/deliveries/redeliver-dead`,
        jsonInit("POST", integrationId ? { integrationId } : {})
      );
      if (res.ok) {
        setNotice(`${res.data.queued} ta yetkazilmagan hodisa qayta navbatga qo'yildi.`);
        onChanged();
        void load(false);
      } else setError(res.error);
    } finally {
      setBulkBusy(false);
    }
  }

  const chosen = integrations.find((i) => i.id === integrationId);

  return (
    <div className="space-y-4">
      <section className="panel space-y-3 rounded-xl p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1 text-xs text-muted">
            Ulanish
            <select
              className={inputClass}
              value={integrationId ?? ""}
              onChange={(e) => navigate({ tab: "deliveries", integration: e.target.value || null })}
            >
              <option value="">Hammasi</option>
              {integrations.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name} ({i.typeLabel})
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs text-muted">
            Holat
            <select className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Hammasi</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {DELIVERY_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs text-muted">
            Hodisa
            <select className={inputClass} value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">Hammasi</option>
              {meta.events.map((e) => (
                <option key={e.type} value={e.type}>
                  {e.type}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={secondaryButton} disabled={loading} onClick={() => void load(false)}>
            {loading ? "Yangilanmoqda…" : "Yangilash"}
          </button>
          {meta.me.canWrite && (
            <ConfirmButton
              label={chosen ? `«${chosen.name}» DEAD'larini qayta yuborish` : "Barcha DEAD'larni qayta yuborish"}
              question="Yetkazilmagan hodisalar qayta yuborilsinmi?"
              busy={bulkBusy}
              onConfirm={() => void redeliverDead()}
            />
          )}
          <span className="text-xs text-muted">Urinishlar: 30 s, 2 daq, 10 daq, 1 soat, 6 soat; keyin DEAD.</span>
        </div>
        {notice && <Notice tone="info">{notice}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
      </section>

      {selected && (
        <DetailPanel
          key={selected}
          id={selected}
          canWrite={meta.me.canWrite}
          onClose={() => setSelected(null)}
          onRedelivered={() => {
            onChanged();
            void load(false);
          }}
        />
      )}

      <section className="panel rounded-xl">
        {rows === null ? (
          <p className="px-4 py-10 text-center text-sm text-muted">{error ? "" : "Yuklanmoqda…"}</p>
        ) : rows.length === 0 ? (
          <EmptyState title="Yetkazish topilmadi" body="Filtrni o'zgartiring yoki ulanish kartasidan «Sinash»ni bosing." />
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => setSelected(row.id)}
                  aria-current={selected === row.id}
                  className={`flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left hover:bg-surface-hover/50 ${selected === row.id ? "bg-surface-hover/50" : ""}`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground">
                      <span className="font-mono">{row.eventType}</span>
                      {row.isTest && <span className="label-mono ml-2 text-[10px] text-gold">TEST</span>}
                      <span className="ml-2 text-xs font-normal text-muted">→ {row.integration?.name ?? "—"}</span>
                    </span>
                    <span className="block truncate text-xs text-muted">
                      {formatDateTime(row.createdAt)} · {row.attempts}/{row.maxAttempts} urinish
                      {row.responseCode ? ` · HTTP ${row.responseCode}` : ""}
                      {row.lastError ? ` · ${row.lastError}` : ""}
                    </span>
                  </span>
                  <Pill tone={DELIVERY_TONE[row.status]}>{DELIVERY_LABEL[row.status]}</Pill>
                </button>
              </li>
            ))}
          </ul>
        )}
        {cursor && (
          <div className="border-t border-border p-3 text-center">
            <button type="button" className={secondaryButton} disabled={loading} onClick={() => void load(true, cursor)}>
              {loading ? "Yuklanmoqda…" : "Yana yuklash"}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
