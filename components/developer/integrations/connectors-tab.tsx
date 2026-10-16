"use client";

/**
 * Ulanishlar: one card per Integration row — the legacy Telegram / amoCRM /
 * Bitrix24 (their lead pipeline is unchanged; the card adds the HOT card
 * subscription or the enrichment panel) and the new Webhook / Google Sheets /
 * Make / Zapier. Status, pending / dead counts, last error, a "Sinash" button
 * that sends a synthetic is_test event through the real pipeline.
 */

import { useState } from "react";
import { ConfirmButton, Notice } from "@/components/developer/comments/parts";
import { EmptyState, Pill, Toggle, formatDateTime, inputClass, primaryButton, secondaryButton } from "@/components/developer/ui";
import AddConnector from "./add-connector";
import EnrichmentPanel from "./enrichment-panel";
import SecretBox from "./secret-box";
import SubscriptionEditor, { cleanFilter, type SubscriptionDraft } from "./subscription-editor";
import {
  DELIVERY_LABEL,
  INTEGRATIONS_API,
  STATUS_LABEL,
  STATUS_TONE,
  formatDuration,
  jsonInit,
  requestJson,
  type DeliveryView,
  type EventType,
  type IntegrationView,
  type ListResponse,
  type Meta,
} from "./shared";
import type { IntegrationsTab } from "./integrations-dashboard";

interface Props {
  meta: Meta;
  list: ListResponse;
  onChanged: () => void;
  navigate: (next: { tab?: IntegrationsTab; integration?: string | null }) => void;
}

function TestResult({ delivery }: { delivery: DeliveryView }) {
  const tone = delivery.status === "SENT" ? "info" : delivery.status === "DEAD" ? "error" : "warning";
  return (
    <Notice tone={tone}>
      <span className="font-semibold">{DELIVERY_LABEL[delivery.status]}</span>
      {delivery.responseCode ? ` · HTTP ${delivery.responseCode}` : ""} · {formatDuration(delivery.durationMs)}
      {delivery.lastError ? ` · ${delivery.lastError}` : ""}
      {delivery.responseSnippet ? <span className="mt-1 block break-all font-mono text-[11px] opacity-80">{delivery.responseSnippet}</span> : null}
      {delivery.externalUrl ? (
        <a className="mt-1 block underline" href={delivery.externalUrl} target="_blank" rel="noreferrer noopener">
          Jadvalni ochish
        </a>
      ) : null}
    </Notice>
  );
}

/** Telegram: the HOT card is a subscription on lead.hot with a temperature filter. */
function HotCardPanel({ integration, canWrite, onChanged }: { integration: IntegrationView; canWrite: boolean; onChanged: () => void }) {
  const existing = integration.subscriptions.find((s) => s.eventType === "lead.hot");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minScore, setMinScore] = useState(existing?.filter.min_score !== undefined ? String(existing.filter.min_score) : "");

  async function save(active: boolean) {
    setBusy(true);
    setError(null);
    try {
      const filter = cleanFilter({ v: 1, temperatures: ["HOT"], min_score: minScore === "" ? undefined : Number(minScore) });
      const others = integration.subscriptions
        .filter((s) => s.eventType !== "lead.hot")
        .map((s) => ({ eventType: s.eventType, filter: s.filter, active: s.active }));
      const res = await requestJson(
        `${INTEGRATIONS_API}/${integration.id}/subscriptions`,
        jsonInit("PUT", { subscriptions: [...others, { eventType: "lead.hot", filter, active }] })
      );
      if (res.ok) onChanged();
      else setError(res.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-dashed border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">HOT lead kartasi</p>
          <p className="text-xs text-muted">
            HOT lead paydo bo&apos;lganda shu chatga alohida karta: ism, telefon, mahsulot, ball, manba. Oddiy lead kartasi o&apos;zgarmaydi.
          </p>
        </div>
        <Toggle on={Boolean(existing?.active)} onChange={(on) => void save(on)} label="HOT kartani yoqish" />
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-muted">
          Minimal ball
          <input
            type="number"
            min={0}
            max={100}
            inputMode="numeric"
            className={`${inputClass} mt-1 w-28`}
            value={minScore}
            onChange={(e) => setMinScore(e.target.value)}
            placeholder="ixtiyoriy"
            disabled={!canWrite}
          />
        </label>
        {existing && (
          <button type="button" className={secondaryButton} disabled={busy || !canWrite} onClick={() => void save(existing.active)}>
            {busy ? "Saqlanmoqda…" : "Filtrni saqlash"}
          </button>
        )}
      </div>
      {busy && <p className="text-xs text-muted">Saqlanmoqda…</p>}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

function ConnectorCard({
  integration,
  meta,
  onChanged,
  navigate,
}: {
  integration: IntegrationView;
  meta: Meta;
  onChanged: () => void;
  navigate: Props["navigate"];
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<DeliveryView | null>(null);
  const [secret, setSecret] = useState<{ value: string; note: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<SubscriptionDraft>({
    events: integration.subscriptions.map((s) => s.eventType),
    filter: integration.subscriptions[0]?.filter ?? { v: 1 },
  });
  const canWrite = meta.me.canWrite;
  const isBus = !integration.legacy;
  const isCrmLegacy = integration.type === "AMOCRM" || integration.type === "BITRIX24";
  const connectorEvents = meta.connectorTypes.find((c) => c.type === integration.type)?.events;

  async function act<T>(key: string, fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, done?: (data: T) => void) {
    setBusy(key);
    setError(null);
    try {
      const res = await fn();
      if (res.ok) {
        done?.(res.data);
        onChanged();
      } else setError(res.error);
    } finally {
      setBusy(null);
    }
  }

  const sendTest = () =>
    act("test", () => requestJson<{ delivery: DeliveryView }>(`${INTEGRATIONS_API}/${integration.id}/test`, jsonInit("POST", {})), (data) => setTest(data.delivery));

  const url = typeof integration.config.url === "string" ? integration.config.url : null;
  const sheetUrl = typeof integration.config.sheetUrl === "string" ? integration.config.sheetUrl : null;
  const clientEmail = typeof integration.config.clientEmail === "string" ? integration.config.clientEmail : null;
  const rate = typeof integration.config.rateLimitPerMinute === "number" ? integration.config.rateLimitPerMinute : null;

  return (
    <article className="panel space-y-3 rounded-xl p-4" aria-label={integration.name}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="break-words text-sm font-semibold text-foreground">{integration.name}</h3>
            <span className="label-mono text-[10px] text-muted">{integration.typeLabel}</span>
            {integration.legacy && <span className="label-mono text-[10px] text-muted">ESKI LEAD YETKAZISH</span>}
          </div>
          {url && <p className="mt-0.5 break-all text-xs text-muted">{url}</p>}
          {sheetUrl && (
            <p className="mt-0.5 break-all text-xs text-muted">
              <a className="underline" href={sheetUrl} target="_blank" rel="noreferrer noopener">
                {String(integration.config.sheetName ?? "")} varag&apos;i
              </a>
            </p>
          )}
        </div>
        <Pill tone={STATUS_TONE[integration.status]}>{STATUS_LABEL[integration.status]}</Pill>
      </header>

      <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-muted">Kutilmoqda</dt>
          <dd className="font-semibold tabular-nums text-foreground">{integration.counts.pending}</dd>
        </div>
        <div>
          <dt className="text-muted">Yetkazilmadi (DEAD)</dt>
          <dd className={`font-semibold tabular-nums ${integration.counts.dead ? "text-error" : "text-foreground"}`}>{integration.counts.dead}</dd>
        </div>
        <div>
          <dt className="text-muted">24 soatda yuborildi</dt>
          <dd className="font-semibold tabular-nums text-foreground">{integration.counts.sent24h}</dd>
        </div>
        <div>
          <dt className="text-muted">{integration.secretHint.includes("@") ? "Service account" : "Kalit"}</dt>
          <dd className="break-all font-mono text-foreground">{integration.secretHint || "—"}</dd>
        </div>
      </dl>
      {integration.legacy && (integration.counts.leadPending > 0 || integration.counts.leadDead > 0) && (
        <p className="text-xs text-muted">
          Lead yetkazish: {integration.counts.leadPending} kutilmoqda · {integration.counts.leadDead} yetkazilmadi (eski Integratsiyalar sahifasida qayta yuboriladi)
        </p>
      )}

      {integration.lastError && (
        <Notice tone={integration.status === "BROKEN" ? "error" : "warning"}>
          {integration.lastError}
          {integration.lastCheckedAt ? ` · ${formatDateTime(integration.lastCheckedAt)}` : ""}
        </Notice>
      )}
      {integration.previousSecretExpiresAt && (
        <Notice tone="info">
          Eski kalit ham imzolayapti ({formatDateTime(integration.previousSecretExpiresAt)} gacha): qabul qiluvchida kalitni almashtirishga ulgurasiz.
        </Notice>
      )}

      {integration.subscriptions.length > 0 && (
        <ul className="space-y-1 text-xs">
          {integration.subscriptions.map((s) => (
            <li key={s.id} className="flex flex-wrap items-baseline gap-x-2">
              <span className={`font-mono ${s.active ? "text-foreground" : "text-muted line-through"}`}>{s.eventType}</span>
              <span className="text-muted">{s.description}</span>
              {!s.active && <span className="text-warning">o&apos;chirilgan</span>}
            </li>
          ))}
        </ul>
      )}
      {isBus && integration.subscriptions.length === 0 && <p className="text-xs text-warning">Hech qanday hodisaga obuna yo&apos;q — hech narsa kelmaydi.</p>}
      {rate !== null && <p className="text-xs text-muted">Tezlik limiti: {rate}/daqiqa</p>}
      {clientEmail && <p className="break-all text-xs text-muted">Jadvalni shu manzilga ulashing: {clientEmail}</p>}

      {secret && <SecretBox secret={secret.value} title="Yangi maxfiy kalit" note={secret.note} onDismiss={() => setSecret(null)} />}
      {test && <TestResult delivery={test} />}
      {error && <Notice tone="error">{error}</Notice>}

      {integration.type === "TELEGRAM" && <HotCardPanel integration={integration} canWrite={canWrite} onChanged={onChanged} />}
      {isCrmLegacy && <EnrichmentPanel integration={integration} meta={meta} onChanged={onChanged} />}

      {editing && isBus && connectorEvents && (
        <div className="space-y-3 rounded-lg border border-dashed border-border p-3">
          <SubscriptionEditor draft={draft} onChange={setDraft} events={meta.events.filter((e) => connectorEvents.includes(e.type))} accounts={meta.accounts} />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={primaryButton}
              disabled={busy !== null}
              onClick={() =>
                void act(
                  "subs",
                  () =>
                    requestJson(
                      `${INTEGRATIONS_API}/${integration.id}/subscriptions`,
                      jsonInit("PUT", {
                        subscriptions: draft.events.map((eventType: EventType) => ({ eventType, filter: cleanFilter(draft.filter), active: true })),
                      })
                    ),
                  () => setEditing(false)
                )
              }
            >
              {busy === "subs" ? "Saqlanmoqda…" : "Obunalarni saqlash"}
            </button>
            <button type="button" className={secondaryButton} onClick={() => setEditing(false)}>
              Bekor
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!isCrmLegacy && (
          <button type="button" className={primaryButton} disabled={busy !== null || !canWrite || integration.status === "DISABLED"} onClick={() => void sendTest()}>
            {busy === "test" ? "Yuborilmoqda…" : integration.type === "GOOGLE_SHEETS" ? "Test qator qo'shish" : "Sinash"}
          </button>
        )}
        {isBus && (
          <button
            type="button"
            className={secondaryButton}
            disabled={busy !== null || !canWrite}
            onClick={() => void act("check", () => requestJson(`${INTEGRATIONS_API}/${integration.id}/check`, jsonInit("POST", {})))}
          >
            {busy === "check" ? "Tekshirilmoqda…" : "Ulanishni tekshirish"}
          </button>
        )}
        {isBus && (
          <button
            type="button"
            className={secondaryButton}
            disabled={busy !== null || !canWrite}
            onClick={() => {
              setDraft({ events: integration.subscriptions.map((s) => s.eventType), filter: integration.subscriptions[0]?.filter ?? { v: 1 } });
              setEditing((v) => !v);
            }}
          >
            Obunalar
          </button>
        )}
        {isBus && (
          <button
            type="button"
            className={secondaryButton}
            disabled={busy !== null || !canWrite}
            onClick={() =>
              void act("toggle", () =>
                requestJson(`${INTEGRATIONS_API}/${integration.id}`, jsonInit("PATCH", { status: integration.status === "ACTIVE" ? "DISABLED" : "ACTIVE" }))
              )
            }
          >
            {integration.status === "ACTIVE" ? "O'chirib qo'yish" : "Yoqish"}
          </button>
        )}
        {(integration.type === "WEBHOOK" || integration.type === "MAKE" || integration.type === "ZAPIER") && canWrite && (
          <ConfirmButton
            label="Kalitni almashtirish"
            question={`Yangi kalit yaratilsin? Eski kalit ${meta.limits.secretOverlapHours} soat ishlaydi.`}
            busy={busy === "rotate"}
            onConfirm={() =>
              void act(
                "rotate",
                () => requestJson<{ secret: string }>(`${INTEGRATIONS_API}/${integration.id}/rotate-secret`, jsonInit("POST", {})),
                (data) => setSecret({ value: data.secret, note: `Eski kalit ${meta.limits.secretOverlapHours} soat davomida ham imzolaydi.` })
              )
            }
          />
        )}
        <button type="button" className={secondaryButton} onClick={() => navigate({ tab: "deliveries", integration: integration.id })}>
          Yetkazishlar
        </button>
        {isBus && canWrite && (
          <ConfirmButton
            label="O'chirish"
            question="Ulanish va uning tarixi o'chirilsinmi?"
            confirmLabel="O'chirish"
            danger
            busy={busy === "delete"}
            onConfirm={() => void act("delete", () => requestJson(`${INTEGRATIONS_API}/${integration.id}`, { method: "DELETE" }))}
          />
        )}
      </div>
    </article>
  );
}

export default function ConnectorsTab({ meta, list, onChanged, navigate }: Props) {
  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">
          {list.integrations.length} ta ulanish. Telegram / amoCRM / Bitrix24 lead yetkazishi o&apos;zgarmagan — bu yerda ularga HOT karta va CRM boyitish
          qo&apos;shiladi.
        </p>
        <button type="button" className={primaryButton} disabled={!meta.me.canWrite || adding} onClick={() => setAdding(true)}>
          Ulanish qo&apos;shish
        </button>
      </div>

      {adding && (
        <AddConnector
          meta={meta}
          onCreated={onChanged}
          onCancel={() => {
            setAdding(false);
            onChanged();
          }}
        />
      )}

      {list.integrations.length === 0 ? (
        <section className="panel rounded-xl">
          <EmptyState title="Hali ulanish yo'q" body="Webhook, Google Sheets, Make yoki Zapier qo'shing — birinchi sinov hodisasi bir bosishda yuboriladi." />
        </section>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {list.integrations.map((integration) => (
            <ConnectorCard key={integration.id} integration={integration} meta={meta} onChanged={onChanged} navigate={navigate} />
          ))}
        </div>
      )}
    </div>
  );
}
