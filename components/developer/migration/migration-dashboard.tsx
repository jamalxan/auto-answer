"use client";

/**
 * ETAP 11 — ManyChat assisted migration, the developer screen. A guided
 * wizard with a persistent stepper; the URL carries the state
 * (?project=<id>&step=0..4) so a refresh or a shared link returns to the
 * same place. /meta feeds accounts, limits, the kill switch and caller rights.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { DevBadge, Pill, secondaryButton } from "@/components/developer/ui";
import AnalyzeStep from "./analyze-step";
import ConnectStep from "./connect-step";
import FinishStep from "./finish-step";
import FlowsStep from "./flows-step";
import MappingStep from "./mapping-step";
import {
  MIGRATION_API,
  requestJson,
  STEPS,
  stepFromParam,
  type MigrationMeta,
  normalizeProject,
  type ProjectDetail,
  type RawProject,
  type ProjectSummary,
} from "./shared";

export default function MigrationDashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = searchParams.get("project");
  const step = stepFromParam(searchParams.get("step"));

  const [meta, setMeta] = useState<MigrationMeta | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setFailure(null);
    try {
      const [metaRes, listRes, detailRes] = await Promise.all([
        requestJson<MigrationMeta>(`${MIGRATION_API}/meta`),
        requestJson<ProjectSummary[]>(`${MIGRATION_API}/projects`),
        projectId ? requestJson<RawProject>(`${MIGRATION_API}/projects/${projectId}`) : Promise.resolve(null),
      ]);
      if (mine !== seq.current) return;
      if (metaRes.ok) setMeta(metaRes.data);
      else setFailure(metaRes.error);
      if (listRes.ok) setProjects(Array.isArray(listRes.data) ? listRes.data : []);
      else setFailure((prev) => prev ?? listRes.error);
      if (detailRes) {
        if (detailRes.ok) setProject(normalizeProject(detailRes.data));
        else {
          setProject(null);
          setFailure((prev) => prev ?? detailRes.error);
        }
      } else setProject(null);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
    const counter = seq;
    return () => {
      counter.current++;
    };
  }, [load]);

  const go = useCallback(
    (next: { project?: string | null; step: number }) => {
      const params = new URLSearchParams();
      const id = next.project === undefined ? projectId : next.project;
      if (id) params.set("project", id);
      params.set("step", String(next.step));
      router.replace(`/developer/migration?${params.toString()}`, { scroll: false });
    },
    [router, projectId]
  );

  const canWrite = meta?.me.canWrite ?? false;
  const enabled = meta?.enabled ?? true;
  const active = project && project.id === projectId ? project : null;
  const effectiveStep = active ? step : 0;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground">ManyChat&apos;dan ko&apos;chish</h1>
            <DevBadge />
          </div>
          <p className="mt-1 text-sm text-muted">
            Yordamli migratsiya: teglar, maydonlar va flow ro&apos;yxati avtomatik o&apos;qiladi; har bir flow matnini siz joylaysiz, AI uni qoralama flow&apos;ga aylantiradi. Hech narsa o&apos;zi nashr qilinmaydi.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {meta && <Pill tone={canWrite ? "success" : "muted"}>{canWrite ? "Tahrirlash mumkin" : "Faqat ko'rish"}</Pill>}
          <button type="button" className={secondaryButton} disabled={loading} onClick={() => void load()}>
            {loading ? "Yangilanmoqda…" : "Yangilash"}
          </button>
        </div>
      </div>

      {failure && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error" role="alert">
          <span className="min-w-0 break-words">{failure}</span>
          <button type="button" className={secondaryButton} onClick={() => void load()}>
            Qayta urinish
          </button>
        </div>
      )}
      {meta && !enabled && (
        <Notice tone="error">
          Migratsiya o&apos;chirilgan (<code>MIGRATION_DISABLED</code>): ulash, tahlil, import va aylantirish ishlamaydi. Yechim: serverda <code>MIGRATION_DISABLED</code> ni olib tashlab, web&apos;ni qayta ishga tushiring. Loyihani o&apos;chirish (kalitni tozalash) har doim ishlaydi.
        </Notice>
      )}
      {meta && !canWrite && (
        <Notice tone="warning">
          Sizning rolingizda migratsiyani o&apos;zgartirib bo&apos;lmaydi (kerak: Menejer yoki yuqori). Natijalarni ko&apos;rishingiz mumkin.
        </Notice>
      )}

      <nav aria-label="Migratsiya bosqichlari">
        <ol className="flex gap-1 overflow-x-auto border-b border-border">
          {STEPS.map((s, i) => {
            const reachable = i === 0 || Boolean(active);
            const current = i === effectiveStep;
            return (
              <li key={s.key} className="shrink-0">
                <button
                  type="button"
                  disabled={!reachable}
                  aria-current={current ? "step" : undefined}
                  onClick={() => go({ step: i })}
                  className={`-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40 ${current ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground"}`}
                >
                  <span className={`grid h-5 w-5 place-items-center rounded-full text-[11px] font-bold ${current ? "bg-accent text-background" : "bg-surface-hover text-muted"}`}>{i + 1}</span>
                  {s.label}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      {!meta ? (
        loading ? <p className="py-10 text-center text-sm text-muted">Yuklanmoqda…</p> : null
      ) : effectiveStep === 0 ? (
        <ConnectStep
          meta={meta}
          projects={projects}
          active={active}
          canWrite={canWrite && enabled}
          onConnected={(id) => go({ project: id, step: 1 })}
          onOpen={(id, nextStep) => go({ project: id, step: nextStep })}
          onDeleted={() => go({ project: null, step: 0 })}
          onChanged={() => void load()}
        />
      ) : !active ? (
        <p className="py-10 text-center text-sm text-muted">{loading ? "Yuklanmoqda…" : "Loyiha topilmadi."}</p>
      ) : effectiveStep === 1 ? (
        <AnalyzeStep project={active} canWrite={canWrite && enabled} onChanged={() => void load()} onNext={() => go({ step: 2 })} />
      ) : effectiveStep === 2 ? (
        <MappingStep project={active} canWrite={canWrite && enabled} onChanged={() => void load()} onNext={() => go({ step: 3 })} />
      ) : effectiveStep === 3 ? (
        <FlowsStep project={active} meta={meta} canWrite={canWrite} enabled={enabled} onChanged={() => void load()} onNext={() => go({ step: 4 })} />
      ) : (
        <FinishStep project={active} canWrite={canWrite} onDeleted={() => go({ project: null, step: 0 })} />
      )}
    </div>
  );
}
