"use client";

/**
 * Jamoa (TZ 31, 53): members with a role select (OWNER / ADMIN only), the
 * permission matrix, the Telegram-linked badge, and the assignment rules
 * editor (trigger / strategy / members / product keywords / priority).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChipInput, EmptyState, Field, inputClass, Pill, primaryButton, secondaryButton, Toggle } from "@/components/developer/ui";
import { ConfirmButton, Notice } from "@/components/developer/comments/parts";
import { CRM_API, jsonInit, requestJson, type AssignmentRule, type Meta, type Permission, type PermissionRole, type TeamResponse } from "./shared";

const ROLES: PermissionRole[] = ["ADMIN", "MANAGER", "OPERATOR", "VIEWER"];
const TRIGGERS = ["ON_HOT", "ON_LEAD", "ON_HANDOFF", "ON_STAGE", "MANUAL"] as const;
const STRATEGIES = ["ROUND_ROBIN", "TEAM", "SPECIALIST"] as const;

type RuleDraft = {
  name: string;
  trigger: (typeof TRIGGERS)[number];
  strategy: (typeof STRATEGIES)[number];
  stageId: string | null;
  memberIds: string[];
  productKeywords: string[];
  priority: number;
  onlyUnassigned: boolean;
  active: boolean;
};

const EMPTY_RULE: RuleDraft = { name: "", trigger: "ON_HOT", strategy: "ROUND_ROBIN", stageId: null, memberIds: [], productKeywords: [], priority: 0, onlyUnassigned: true, active: true };

function RuleEditor({ meta, rule, onDone, onCancel }: { meta: Meta; rule: AssignmentRule | null; onDone: () => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<RuleDraft>(
    rule
      ? {
          name: rule.name,
          trigger: rule.trigger as RuleDraft["trigger"],
          strategy: rule.strategy as RuleDraft["strategy"],
          stageId: rule.stageId,
          memberIds: rule.memberIds,
          productKeywords: rule.productKeywords,
          priority: rule.priority,
          onlyUnassigned: rule.onlyUnassigned,
          active: rule.active,
        }
      : EMPTY_RULE
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operators = meta.members.filter((m) => m.normalizedRole !== "VIEWER");
  const stages = meta.pipelines.flatMap((p) => p.stages);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = { ...draft, stageId: draft.trigger === "ON_STAGE" ? draft.stageId : null };
      const res = rule
        ? await requestJson(`${CRM_API}/assignment-rules/${rule.id}`, jsonInit("PATCH", body))
        : await requestJson(`${CRM_API}/assignment-rules`, jsonInit("POST", body));
      if (res.ok) onDone();
      else setError(res.error);
    } finally {
      setBusy(false);
    }
  }

  const toggleMember = (id: string) =>
    setDraft((d) => ({ ...d, memberIds: d.memberIds.includes(id) ? d.memberIds.filter((m) => m !== id) : [...d.memberIds, id] }));

  return (
    <div className="space-y-3 rounded-lg border border-dashed border-border p-3">
      <p className="text-sm font-semibold text-foreground">{rule ? "Qoidani tahrirlash" : "Yangi qoida"}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nomi">
          <input className={inputClass} value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="HOT → sotuvchilar navbati" />
        </Field>
        <Field label="Ustuvorlik" hint="Kattasi birinchi tekshiriladi">
          <input type="number" className={inputClass} value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) || 0 })} />
        </Field>
        <Field label="Qachon" hint={meta.labels.trigger[draft.trigger]}>
          <select className={inputClass} value={draft.trigger} onChange={(e) => setDraft({ ...draft, trigger: e.target.value as RuleDraft["trigger"] })}>
            {TRIGGERS.map((t) => (
              <option key={t} value={t}>
                {meta.labels.trigger[t] ?? t}
              </option>
            ))}
          </select>
        </Field>
        {draft.trigger === "ON_STAGE" && (
          <Field label="Bosqich">
            <select className={inputClass} value={draft.stageId ?? ""} onChange={(e) => setDraft({ ...draft, stageId: e.target.value || null })}>
              <option value="">Tanlang…</option>
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Strategiya" hint={meta.labels.strategy[draft.strategy]}>
          <select className={inputClass} value={draft.strategy} onChange={(e) => setDraft({ ...draft, strategy: e.target.value as RuleDraft["strategy"] })}>
            {STRATEGIES.map((s) => (
              <option key={s} value={s}>
                {meta.labels.strategy[s] ?? s}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field
        label={draft.strategy === "ROUND_ROBIN" ? "A'zolar (bo'sh = barcha operatorlar)" : "Jamoa a'zolari"}
        hint="Navbat shu tartibda aylanadi; faqat Telegram'ga ulangan a'zo xabar oladi."
      >
        <div className="flex flex-wrap gap-1.5">
          {operators.map((m) => {
            const on = draft.memberIds.includes(m.id);
            return (
              <button
                key={m.id}
                type="button"
                aria-pressed={on}
                onClick={() => toggleMember(m.id)}
                className={`rounded-full border px-2.5 py-1 text-xs ${on ? "border-accent bg-accent/10 text-foreground" : "border-border text-muted hover:text-foreground"}`}
              >
                {m.name || m.email} · {m.roleLabel}
                {m.telegramLinked ? " · TG" : ""}
              </button>
            );
          })}
        </div>
      </Field>
      {draft.strategy === "SPECIALIST" && (
        <Field label="Mahsulot kalit so'zlari" hint="Mijozning mahsuloti / lead mahsuloti / taglar bilan solishtiriladi (IELTS, Mercedes…)">
          <ChipInput values={draft.productKeywords} onChange={(productKeywords) => setDraft({ ...draft, productKeywords })} max={20} placeholder="IELTS, SAT" />
        </Field>
      )}
      <div className="flex flex-wrap items-center gap-4 text-sm text-muted">
        <label className="flex items-center gap-2">
          <Toggle on={draft.onlyUnassigned} label="Faqat operatorsiz kontaktlar" onChange={(on) => setDraft({ ...draft, onlyUnassigned: on })} />
          Faqat operatorsiz kontaktlarga
        </label>
        <label className="flex items-center gap-2">
          <Toggle on={draft.active} label="Qoida faol" onChange={(on) => setDraft({ ...draft, active: on })} />
          Faol
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={primaryButton} disabled={busy || !draft.name.trim()} onClick={() => void save()}>
          {busy ? "Saqlanmoqda…" : "Saqlash"}
        </button>
        <button type="button" className={secondaryButton} onClick={onCancel}>
          Bekor
        </button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

export default function TeamTab({ meta, onChanged }: { meta: Meta; onChanged: () => void }) {
  const [team, setTeam] = useState<TeamResponse | null>(null);
  const [rules, setRules] = useState<AssignmentRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<"new" | string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(null);
    const [t, r] = await Promise.all([requestJson<TeamResponse>(`${CRM_API}/team`), requestJson<{ rules: AssignmentRule[] }>(`${CRM_API}/assignment-rules`)]);
    if (mine !== seq.current) return;
    if (t.ok) setTeam(t.data);
    else setError(t.error);
    if (r.ok) setRules(r.data.rules);
    else setError(r.error);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
  }, [load]);

  async function setRole(memberId: string, role: string) {
    const res = await requestJson(`${CRM_API}/team/${memberId}/role`, jsonInit("PATCH", { role }));
    if (!res.ok) setError(res.error);
    void load();
    onChanged();
  }

  async function patchRule(id: string, body: unknown) {
    const res = await requestJson(`${CRM_API}/assignment-rules/${id}`, jsonInit("PATCH", body));
    if (!res.ok) setError(res.error);
    void load();
  }

  async function deleteRule(id: string) {
    const res = await requestJson(`${CRM_API}/assignment-rules/${id}`, { method: "DELETE" });
    if (!res.ok) setError(res.error);
    void load();
  }

  const memberName = (id: string) => {
    const m = meta.members.find((x) => x.id === id);
    return m ? m.name || m.email || id : id;
  };
  const stageName = (id: string | null) => meta.pipelines.flatMap((p) => p.stages).find((s) => s.id === id)?.name ?? "—";
  const done = () => {
    setEditing(null);
    void load();
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
          <span>{error}</span>
          <button type="button" className={secondaryButton} onClick={() => void load()}>
            Qayta urinish
          </button>
        </div>
      )}

      <section className="panel space-y-3 rounded-xl p-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">A&apos;zolar va rollar</h2>
          <p className="mt-1 text-xs text-muted">
            Rolni faqat egasi yoki administrator o&apos;zgartiradi. &quot;TG&quot; — Telegram&apos;ga ulangan: biriktirish xabari va &quot;Qabul qildim&quot; /
            &quot;Bo&apos;shatish&quot; tugmalari shu a&apos;zoga boradi.
          </p>
        </div>
        {team === null ? (
          <p className="py-6 text-center text-sm text-muted">Yuklanmoqda…</p>
        ) : (
          <ul className="divide-y divide-border">
            {team.members.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{m.name || m.email || m.userId}</span>
                    {m.userId === meta.me.userId && <Pill tone="muted">siz</Pill>}
                    {m.telegramLinked ? <Pill tone="success">TG ulangan</Pill> : <Pill tone="muted">TG yo&apos;q</Pill>}
                    {m.activeAssignments > 0 && <Pill tone="warning">{m.activeAssignments} ta faol lead</Pill>}
                  </div>
                  {m.name && m.email && <p className="text-xs text-muted">{m.email}</p>}
                </div>
                {m.canChange ? (
                  <select className={`${inputClass} w-auto`} value={m.normalizedRole} aria-label={`${m.name || m.email} roli`} onChange={(e) => void setRole(m.id, e.target.value)}>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {team.roleLabels[r]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Pill tone="muted">{m.roleLabel}</Pill>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {team && (
        <section className="panel space-y-3 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-foreground">Ruxsatlar jadvali (TZ 53)</h2>
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[36rem] text-xs">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-1 pr-2 font-medium">Ruxsat</th>
                  {(["OWNER", "ADMIN", "MANAGER", "OPERATOR", "VIEWER"] as PermissionRole[]).map((r) => (
                    <th key={r} className="py-1 px-2 text-center font-medium">
                      {team.roleLabels[r]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {team.permissions.map((p: Permission) => (
                  <tr key={p} className="border-t border-border">
                    <td className="py-1.5 pr-2 text-foreground">{team.permissionLabels[p]}</td>
                    {(["OWNER", "ADMIN", "MANAGER", "OPERATOR", "VIEWER"] as PermissionRole[]).map((r) => (
                      <td key={r} className="py-1.5 px-2 text-center">
                        {team.matrix[r][p] ? <span className="text-success">✓</span> : <span className="text-muted">–</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="panel space-y-3 rounded-xl p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Biriktirish qoidalari</h2>
            <p className="mt-1 text-xs text-muted">
              HOT bo&apos;lganda / yangi lead / operatorga o&apos;tganda / bosqichga o&apos;tganda — navbat bilan, jamoa ichida yoki mahsulot
              mutaxassisiga. Xabar workspace Telegram chatiga boradi; &quot;Qabul qildim&quot; bosgan odam biriktiriladi.
            </p>
          </div>
          {meta.me.canManage && editing === null && (
            <button type="button" className={primaryButton} onClick={() => setEditing("new")}>
              + Qoida
            </button>
          )}
        </div>
        {editing === "new" && <RuleEditor meta={meta} rule={null} onDone={done} onCancel={() => setEditing(null)} />}
        {rules === null ? (
          <p className="py-6 text-center text-sm text-muted">Yuklanmoqda…</p>
        ) : rules.length === 0 ? (
          <EmptyState title="Hali qoida yo'q" body="Masalan: HOT bo'lganda → navbat bilan barcha operatorlarga." />
        ) : (
          <ul className="space-y-2">
            {rules.map((rule) => (
              <li key={rule.id} className="rounded-lg border border-border px-3 py-2">
                {editing === rule.id ? (
                  <RuleEditor meta={meta} rule={rule} onDone={done} onCancel={() => setEditing(null)} />
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">
                        {rule.name} <span className="label-mono text-[10px] text-muted">P{rule.priority}</span>
                      </p>
                      <p className="break-words text-xs text-muted">
                        {meta.labels.trigger[rule.trigger] ?? rule.trigger}
                        {rule.trigger === "ON_STAGE" ? ` (${stageName(rule.stageId)})` : ""} → {meta.labels.strategy[rule.strategy] ?? rule.strategy}
                        {rule.memberIds.length > 0 ? ` · ${rule.memberIds.map(memberName).join(", ")}` : " · barcha operatorlar"}
                        {rule.productKeywords.length > 0 ? ` · ${rule.productKeywords.join(", ")}` : ""}
                        {rule.onlyUnassigned ? "" : " · biriktirilganlarga ham"}
                      </p>
                    </div>
                    {meta.me.canManage && (
                      <div className="flex items-center gap-2">
                        <Toggle on={rule.active} label={`${rule.name} qoidasi faol`} onChange={(on) => void patchRule(rule.id, { active: on })} />
                        <button type="button" className={secondaryButton} onClick={() => setEditing(rule.id)}>
                          Tahrirlash
                        </button>
                        <ConfirmButton label="O'chirish" question="Qoida o'chirilsinmi?" confirmLabel="O'chirish" danger onConfirm={() => void deleteRule(rule.id)} />
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
