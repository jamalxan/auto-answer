"use client";

/**
 * Integrations — Telegram, amoCRM and Bitrix24 as lead destinations. Credentials
 * are write-only here: the API only ever returns the last four characters.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Field,
  Notice,
  Section,
  ToggleRow,
  inputClass,
} from "@/components/assistant-ui";
import { useLanguage } from "@/components/language-provider";
import { formatShortMonthDayTime } from "@/lib/i18n/format-date";

type IntegrationType = "TELEGRAM" | "AMOCRM" | "BITRIX24";
type IntegrationStatus = "ACTIVE" | "BROKEN" | "DISABLED";

interface IntegrationView {
  id: string;
  type: IntegrationType;
  name: string;
  status: IntegrationStatus;
  config: Record<string, unknown>;
  igAccountFilter: string[];
  tokenExpiresAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  secretHint: string;
  chats: Array<{ id: string; chatId: string; title: string | null; type: string; active: boolean }>;
  pendingDeliveries: number;
  deadDeliveries: number;
}

interface ListPayload {
  integrations: IntegrationView[];
  accounts: Array<{ id: string; username: string }>;
  canManage: boolean;
  telegramBotConfigured: boolean;
  enabled: boolean;
}

interface Option {
  id: number | string;
  name: string;
}

interface Pipeline extends Option {
  statuses: Option[];
}

async function call<T = unknown>(
  method: string,
  url: string,
  body?: unknown
): Promise<{ ok: boolean; data?: T; error?: string; code?: string }> {
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await res.json();
    return payload.success
      ? { ok: true, data: payload.data as T }
      : { ok: false, error: payload.error, code: payload.code };
  } catch {
    return { ok: false, error: "network" };
  }
}

const STATUS_TONE = { ACTIVE: "success", BROKEN: "error", DISABLED: "muted" } as const;

export default function IntegrationsPage() {
  const { t, locale } = useLanguage();
  const I = t.assistant.integrations;

  const [data, setData] = useState<ListPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    const result = await call<ListPayload>("GET", "/api/integrations");
    if (result.ok && result.data) {
      setData(result.data);
      setLoadError(false);
    } else {
      setLoadError(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const byType = useMemo(() => {
    const map = new Map<IntegrationType, IntegrationView>();
    for (const integration of data?.integrations ?? []) {
      if (!map.has(integration.type)) map.set(integration.type, integration);
    }
    return map;
  }, [data]);

  if (loading) return <div className="panel h-64 rounded" />;
  if (loadError || !data) return <Notice tone="error">{t.assistant.common.loadError}</Notice>;

  const broken = data.integrations.filter((i) => i.status === "BROKEN");
  const shared = {
    accounts: data.accounts,
    canManage: data.canManage,
    reload: load,
    locale,
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">{I.title}</h1>
        <p className="mt-1 text-sm text-muted">{I.subtitle}</p>
      </div>

      {!data.canManage && <Notice tone="warning">{I.memberReadOnly}</Notice>}
      {broken.map((b) => (
        <Notice key={b.id} tone="error">
          {I.brokenBanner(b.name)}
        </Notice>
      ))}

      <TelegramCard
        integration={byType.get("TELEGRAM")}
        botConfigured={data.telegramBotConfigured}
        {...shared}
      />
      <AmoCard integration={byType.get("AMOCRM")} {...shared} />
      <BitrixCard integration={byType.get("BITRIX24")} {...shared} />
    </div>
  );
}

// ─── Shared pieces ─────────────────────────────────────────────────────────────

interface CardProps {
  accounts: Array<{ id: string; username: string }>;
  canManage: boolean;
  reload: () => Promise<void>;
  locale: "uz" | "ru" | "en";
}

function Steps({ steps }: { steps: string[] }) {
  const { t } = useLanguage();
  return (
    <details className="rounded border border-border p-3">
      <summary className="cursor-pointer text-sm font-medium text-foreground">
        {t.assistant.integrations.steps}
      </summary>
      <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-muted">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </details>
  );
}

function StatusHeader({ integration }: { integration?: IntegrationView }) {
  const { t, locale } = useLanguage();
  const I = t.assistant.integrations;
  if (!integration) return <Badge tone="muted">{I.notConnected}</Badge>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge tone={STATUS_TONE[integration.status]}>{I.status[integration.status]}</Badge>
      {integration.pendingDeliveries > 0 && <Badge tone="warning">{I.pending(integration.pendingDeliveries)}</Badge>}
      {integration.deadDeliveries > 0 && <Badge tone="error">{I.dead(integration.deadDeliveries)}</Badge>}
      {integration.lastCheckedAt && (
        <span className="text-xs text-muted">
          {I.lastChecked(formatShortMonthDayTime(new Date(integration.lastCheckedAt), locale))}
        </span>
      )}
    </div>
  );
}

function AccountFilter({
  integration,
  accounts,
  disabled,
  reload,
}: {
  integration: IntegrationView;
  accounts: Array<{ id: string; username: string }>;
  disabled: boolean;
  reload: () => Promise<void>;
}) {
  const { t } = useLanguage();
  const I = t.assistant.integrations;
  if (accounts.length < 2) return null;

  async function toggle(id: string) {
    const current = new Set(integration.igAccountFilter);
    if (current.has(id)) current.delete(id);
    else current.add(id);
    await call("PATCH", `/api/integrations/${integration.id}`, { igAccountFilter: [...current] });
    await reload();
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-foreground">{I.accountFilter}</p>
      <div className="flex flex-wrap gap-2">
        {accounts.map((a) => {
          const on = integration.igAccountFilter.includes(a.id);
          return (
            <button
              key={a.id}
              type="button"
              disabled={disabled}
              onClick={() => void toggle(a.id)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${
                on ? "border-accent/40 bg-accent/15 text-accent" : "border-border text-muted hover:text-foreground"
              }`}
            >
              @{a.username}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted">{I.accountFilterHelp}</p>
    </div>
  );
}

function Actions({
  integration,
  canManage,
  reload,
  withTestLead = true,
}: {
  integration: IntegrationView;
  canManage: boolean;
  reload: () => Promise<void>;
  withTestLead?: boolean;
}) {
  const { t } = useLanguage();
  const I = t.assistant.integrations;
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function check() {
    setBusy("check");
    setMessage(null);
    const result = await call<{ ok: boolean; message?: string }>("POST", `/api/integrations/${integration.id}/test-connection`);
    const ok = result.ok && result.data?.ok;
    setMessage({ tone: ok ? "success" : "error", text: ok ? I.checkOk : `${I.checkFailed}${result.data?.message ? `: ${result.data.message}` : ""}` });
    setBusy(null);
    await reload();
  }

  async function testLead() {
    setBusy("test");
    setMessage(null);
    const result = await call("POST", `/api/integrations/${integration.id}/test-lead`);
    setMessage(
      result.ok
        ? { tone: "success", text: I.testSent }
        : { tone: "error", text: I.errors[result.code ?? ""] ?? result.error ?? I.errors.generic }
    );
    setBusy(null);
  }

  async function toggleDisabled() {
    setBusy("toggle");
    await call("PATCH", `/api/integrations/${integration.id}`, { disabled: integration.status !== "DISABLED" });
    setBusy(null);
    await reload();
  }

  async function remove() {
    if (!window.confirm(I.confirmDelete)) return;
    setBusy("delete");
    await call("DELETE", `/api/integrations/${integration.id}`);
    setBusy(null);
    await reload();
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button tone="ghost" disabled={!canManage || busy !== null} onClick={() => void check()}>
          {busy === "check" ? I.checking : I.check}
        </Button>
        {withTestLead && (
          <Button tone="ghost" disabled={!canManage || busy !== null || integration.status !== "ACTIVE"} onClick={() => void testLead()}>
            {I.testLead}
          </Button>
        )}
        <Button tone="ghost" disabled={!canManage || busy !== null} onClick={() => void toggleDisabled()}>
          {integration.status === "DISABLED" ? I.enable : I.disable}
        </Button>
        <Button tone="danger" disabled={!canManage || busy !== null} onClick={() => void remove()}>
          {I.disconnect}
        </Button>
      </div>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      {integration.lastError && integration.status !== "ACTIVE" && (
        <p className="break-words text-xs text-error">
          {I.lastError}: {integration.lastError}
        </p>
      )}
    </div>
  );
}

function errorText(I: ReturnType<typeof useLanguage>["t"]["assistant"]["integrations"], result: { error?: string; code?: string }) {
  return I.errors[result.code ?? ""] ?? I.errors[result.error ?? ""] ?? I.errors.generic;
}

// ─── Telegram ──────────────────────────────────────────────────────────────────

function TelegramCard({
  integration,
  botConfigured,
  accounts,
  canManage,
  reload,
}: CardProps & { integration?: IntegrationView; botConfigured: boolean }) {
  const { t } = useLanguage();
  const I = t.assistant.integrations;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function link(kind: "privateUrl" | "groupUrl") {
    setBusy(true);
    setError(null);
    const result = await call<{ privateUrl: string; groupUrl: string }>("POST", "/api/integrations/telegram/link-code");
    if (result.ok && result.data) {
      window.open(result.data[kind], "_blank", "noopener");
      // The chat appears once the bot receives START; refresh a few times.
      for (const delay of [4000, 10000, 20000]) window.setTimeout(() => void reload(), delay);
    } else {
      setError(errorText(I, result));
    }
    setBusy(false);
  }

  return (
    <Section title={I.telegram.name} description={I.telegram.desc} action={<StatusHeader integration={integration} />}>
      {!botConfigured && <Notice tone="warning">{I.botNotConfigured}</Notice>}
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">{I.telegram.chats}</p>
        {integration && integration.chats.length > 0 ? (
          <ul className="space-y-1">
            {integration.chats.map((chat) => (
              <li key={chat.id} className="flex items-center justify-between gap-2 rounded border border-border px-3 py-2 text-sm">
                <span className="truncate text-foreground">{chat.title ?? chat.chatId}</span>
                <Badge tone={chat.active ? "success" : "muted"}>{chat.type}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">{I.telegram.noChats}</p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button disabled={!canManage || !botConfigured || busy} onClick={() => void link("privateUrl")}>
          {I.telegram.privateBtn}
        </Button>
        <Button tone="ghost" disabled={!canManage || !botConfigured || busy} onClick={() => void link("groupUrl")}>
          {I.telegram.groupBtn}
        </Button>
      </div>
      <p className="text-xs text-muted">{I.telegram.codeHelp}</p>
      {error && <Notice tone="error">{error}</Notice>}

      {integration && (
        <>
          <AccountFilter integration={integration} accounts={accounts} disabled={!canManage} reload={reload} />
          <Actions integration={integration} canManage={canManage} reload={reload} />
        </>
      )}
      <Steps steps={I.telegram.steps} />
    </Section>
  );
}

// ─── amoCRM ────────────────────────────────────────────────────────────────────

function AmoCard({ integration, accounts, canManage, reload }: CardProps & { integration?: IntegrationView }) {
  const { t } = useLanguage();
  const I = t.assistant.integrations;
  const A = I.amocrm;

  const [subdomain, setSubdomain] = useState("");
  const [zone, setZone] = useState("amocrm.ru");
  const [token, setToken] = useState("");
  const [expires, setExpires] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const config = (integration?.config ?? {}) as {
    pipelineId?: number;
    statusId?: number;
    responsibleUserId?: number;
    campaignTag?: boolean;
    leadNameTemplate?: string;
    igUsernameFieldId?: number;
  };
  const [pipelineId, setPipelineId] = useState<number | "">(config.pipelineId ?? "");
  const [statusId, setStatusId] = useState<number | "">(config.statusId ?? "");
  const [responsible, setResponsible] = useState<number | "">(config.responsibleUserId ?? "");
  const [campaignTag, setCampaignTag] = useState(config.campaignTag ?? true);
  const [template, setTemplate] = useState(config.leadNameTemplate ?? "Instagram: {name} — {product_interest}");
  const [igField, setIgField] = useState<number | "">(config.igUsernameFieldId ?? "");
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [users, setUsers] = useState<Option[]>([]);
  const [fields, setFields] = useState<Option[]>([]);
  const [newToken, setNewToken] = useState("");

  async function connect() {
    setBusy(true);
    setError(null);
    const result = await call("POST", "/api/integrations/amocrm", {
      subdomain: subdomain.trim(),
      zone,
      token: token.trim(),
      tokenExpiresAt: expires ? new Date(`${expires}T00:00:00Z`).toISOString() : null,
    });
    if (result.ok) {
      setToken("");
      await reload();
    } else {
      setError(errorText(I, result));
    }
    setBusy(false);
  }

  async function loadOptions() {
    if (!integration) return;
    setBusy(true);
    setError(null);
    const [p, u, f] = await Promise.all([
      call<{ items: Pipeline[] }>("GET", `/api/integrations/amocrm/${integration.id}/pipelines`),
      call<{ items: Option[] }>("GET", `/api/integrations/amocrm/${integration.id}/users`),
      call<{ items: Option[] }>("GET", `/api/integrations/amocrm/${integration.id}/contact-fields`),
    ]);
    if (p.ok && p.data) setPipelines(p.data.items);
    else setError(errorText(I, p));
    if (u.ok && u.data) setUsers(u.data.items);
    if (f.ok && f.data) setFields(f.data.items);
    setBusy(false);
  }

  async function saveSettings() {
    if (!integration) return;
    setBusy(true);
    setError(null);
    const result = await call("PATCH", `/api/integrations/${integration.id}`, {
      config: {
        pipelineId: pipelineId === "" ? undefined : pipelineId,
        statusId: statusId === "" ? undefined : statusId,
        responsibleUserId: responsible === "" ? undefined : responsible,
        campaignTag,
        leadNameTemplate: template,
        igUsernameFieldId: igField === "" ? undefined : igField,
      },
    });
    if (!result.ok) setError(errorText(I, result));
    setBusy(false);
    await reload();
  }

  async function replaceToken() {
    if (!integration) return;
    setBusy(true);
    setError(null);
    const result = await call("PATCH", `/api/integrations/${integration.id}`, { token: newToken.trim() });
    if (result.ok) setNewToken("");
    else setError(errorText(I, result));
    setBusy(false);
    await reload();
  }

  const stages = pipelines.find((p) => p.id === pipelineId)?.statuses ?? [];

  return (
    <Section title={A.name} description={A.desc} action={<StatusHeader integration={integration} />}>
      {!integration ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={A.subdomain}>
              <input value={subdomain} onChange={(e) => setSubdomain(e.target.value)} placeholder="promtchi" className={inputClass} disabled={!canManage} />
            </Field>
            <Field label={A.zone}>
              <select value={zone} onChange={(e) => setZone(e.target.value)} className={inputClass} disabled={!canManage}>
                {["amocrm.ru", "kommo.com", "amocrm.com"].map((z) => (
                  <option key={z}>{z}</option>
                ))}
              </select>
            </Field>
          </div>
          <Field label={A.token}>
            <textarea value={token} onChange={(e) => setToken(e.target.value)} rows={3} className={`${inputClass} font-mono text-xs`} disabled={!canManage} autoComplete="off" spellCheck={false} />
          </Field>
          <Field label={A.tokenExpiresAt} help={A.tokenExpiresHelp}>
            <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} className={inputClass} disabled={!canManage} />
          </Field>
          <Button disabled={!canManage || busy || !subdomain.trim() || token.trim().length < 20} onClick={() => void connect()}>
            {I.connect}
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="font-mono text-xs text-muted">
            {A.token}: {integration.secretHint}
            {integration.tokenExpiresAt ? ` · ${I.tokenExpires(integration.tokenExpiresAt.slice(0, 10))}` : ""}
          </p>

          <div className="space-y-3 rounded border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-foreground">
                {A.pipeline} / {A.responsible}
              </p>
              <Button tone="ghost" disabled={!canManage || busy} onClick={() => void loadOptions()}>
                {A.loadOptions}
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={A.pipeline}>
                <select
                  value={pipelineId}
                  onChange={(e) => {
                    setPipelineId(e.target.value ? Number(e.target.value) : "");
                    setStatusId("");
                  }}
                  className={inputClass}
                  disabled={!canManage}
                >
                  <option value="">{A.noneOption}</option>
                  {pipelineId !== "" && !pipelines.some((p) => p.id === pipelineId) && <option value={pipelineId}>#{pipelineId}</option>}
                  {pipelines.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={A.stage}>
                <select value={statusId} onChange={(e) => setStatusId(e.target.value ? Number(e.target.value) : "")} className={inputClass} disabled={!canManage}>
                  <option value="">{A.noneOption}</option>
                  {statusId !== "" && !stages.some((s) => s.id === statusId) && <option value={statusId}>#{statusId}</option>}
                  {stages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={A.responsible}>
                <select value={responsible} onChange={(e) => setResponsible(e.target.value ? Number(e.target.value) : "")} className={inputClass} disabled={!canManage}>
                  <option value="">{A.noneOption}</option>
                  {responsible !== "" && !users.some((u) => u.id === responsible) && <option value={responsible}>#{responsible}</option>}
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={A.igField}>
                <select value={igField} onChange={(e) => setIgField(e.target.value ? Number(e.target.value) : "")} className={inputClass} disabled={!canManage}>
                  <option value="">{A.noneOption}</option>
                  {igField !== "" && !fields.some((f) => f.id === igField) && <option value={igField}>#{igField}</option>}
                  {fields.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label={A.nameTemplate} help={A.nameTemplateHelp}>
              <input value={template} onChange={(e) => setTemplate(e.target.value)} maxLength={255} className={inputClass} disabled={!canManage} />
            </Field>
            <ToggleRow label={A.campaignTag} on={campaignTag} onToggle={() => setCampaignTag(!campaignTag)} disabled={!canManage} />
            <Button disabled={!canManage || busy} onClick={() => void saveSettings()}>
              {I.save}
            </Button>
          </div>

          {integration.status === "BROKEN" && (
            <div className="space-y-2 rounded border border-error/30 p-3">
              <Field label={A.token}>
                <textarea value={newToken} onChange={(e) => setNewToken(e.target.value)} rows={2} className={`${inputClass} font-mono text-xs`} disabled={!canManage} autoComplete="off" spellCheck={false} />
              </Field>
              <Button disabled={!canManage || busy || newToken.trim().length < 20} onClick={() => void replaceToken()}>
                {I.reconnect}
              </Button>
            </div>
          )}

          <AccountFilter integration={integration} accounts={accounts} disabled={!canManage} reload={reload} />
          <Actions integration={integration} canManage={canManage} reload={reload} />
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <Steps steps={A.steps} />
    </Section>
  );
}

// ─── Bitrix24 ──────────────────────────────────────────────────────────────────

function BitrixCard({ integration, accounts, canManage, reload }: CardProps & { integration?: IntegrationView }) {
  const { t } = useLanguage();
  const I = t.assistant.integrations;
  const B = I.bitrix;

  const [webhookUrl, setWebhookUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const config = (integration?.config ?? {}) as { assignedById?: number; sourceId?: string };
  const [assigned, setAssigned] = useState<number | "">(config.assignedById ?? "");
  const [sourceId, setSourceId] = useState<string>(config.sourceId ?? "");
  const [users, setUsers] = useState<Option[]>([]);
  const [sources, setSources] = useState<Option[]>([]);
  const [newUrl, setNewUrl] = useState("");

  async function connect() {
    setBusy(true);
    setError(null);
    const result = await call("POST", "/api/integrations/bitrix24", { webhookUrl: webhookUrl.trim() });
    if (result.ok) {
      setWebhookUrl("");
      await reload();
    } else {
      setError(errorText(I, result));
    }
    setBusy(false);
  }

  async function loadOptions() {
    if (!integration) return;
    setBusy(true);
    setError(null);
    const [u, s] = await Promise.all([
      call<{ items: Option[] }>("GET", `/api/integrations/bitrix24/${integration.id}/users`),
      call<{ items: Option[] }>("GET", `/api/integrations/bitrix24/${integration.id}/sources`),
    ]);
    if (u.ok && u.data) setUsers(u.data.items);
    else setError(errorText(I, u));
    if (s.ok && s.data) setSources(s.data.items);
    setBusy(false);
  }

  async function saveSettings() {
    if (!integration) return;
    setBusy(true);
    const result = await call("PATCH", `/api/integrations/${integration.id}`, {
      config: { assignedById: assigned === "" ? undefined : assigned, sourceId: sourceId || undefined },
    });
    if (!result.ok) setError(errorText(I, result));
    setBusy(false);
    await reload();
  }

  async function replaceUrl() {
    if (!integration) return;
    setBusy(true);
    setError(null);
    const result = await call("PATCH", `/api/integrations/${integration.id}`, { webhookUrl: newUrl.trim() });
    if (result.ok) setNewUrl("");
    else setError(errorText(I, result));
    setBusy(false);
    await reload();
  }

  return (
    <Section title={B.name} description={B.desc} action={<StatusHeader integration={integration} />}>
      {!integration ? (
        <div className="space-y-3">
          <Field label={B.webhookUrl} help={B.webhookHelp}>
            <input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} className={`${inputClass} font-mono text-xs`} disabled={!canManage} autoComplete="off" spellCheck={false} />
          </Field>
          <Button disabled={!canManage || busy || !webhookUrl.trim()} onClick={() => void connect()}>
            {I.connect}
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="font-mono text-xs text-muted">
            {B.webhookUrl}: {integration.secretHint}
          </p>
          <div className="space-y-3 rounded border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-foreground">
                {B.responsible} / {B.source}
              </p>
              <Button tone="ghost" disabled={!canManage || busy} onClick={() => void loadOptions()}>
                {B.loadOptions}
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={B.responsible}>
                <select value={assigned} onChange={(e) => setAssigned(e.target.value ? Number(e.target.value) : "")} className={inputClass} disabled={!canManage}>
                  <option value="">{I.amocrm.noneOption}</option>
                  {assigned !== "" && !users.some((u) => u.id === assigned) && <option value={assigned}>#{assigned}</option>}
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={B.source}>
                <select value={sourceId} onChange={(e) => setSourceId(e.target.value)} className={inputClass} disabled={!canManage}>
                  <option value="">OTHER</option>
                  {sourceId && !sources.some((s) => s.id === sourceId) && <option value={sourceId}>{sourceId}</option>}
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Button disabled={!canManage || busy} onClick={() => void saveSettings()}>
              {I.save}
            </Button>
          </div>

          {integration.status === "BROKEN" && (
            <div className="space-y-2 rounded border border-error/30 p-3">
              <Field label={B.webhookUrl} help={B.webhookHelp}>
                <input value={newUrl} onChange={(e) => setNewUrl(e.target.value)} className={`${inputClass} font-mono text-xs`} disabled={!canManage} />
              </Field>
              <Button disabled={!canManage || busy || !newUrl.trim()} onClick={() => void replaceUrl()}>
                {I.reconnect}
              </Button>
            </div>
          )}

          <AccountFilter integration={integration} accounts={accounts} disabled={!canManage} reload={reload} />
          <Actions integration={integration} canManage={canManage} reload={reload} />
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <Steps steps={B.steps} />
    </Section>
  );
}
