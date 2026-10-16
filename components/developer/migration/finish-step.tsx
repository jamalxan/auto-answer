"use client";

import Link from "next/link";
import { Pill, secondaryButton } from "@/components/developer/ui";
import DeleteProject from "./delete-project";
import { CONTACT_GUIDANCE_FALLBACK, countOf, itemsOf, type ItemKind, type ProjectDetail } from "./shared";

function doneCount(project: ProjectDetail, kind: ItemKind): number {
  return itemsOf(project, kind).filter((i) => i.status === "IMPORTED" || i.status === "MAPPED" || i.status === "CONVERTED").length;
}

export default function FinishStep({ project, canWrite, onDeleted }: { project: ProjectDetail; canWrite: boolean; onDeleted: () => void }) {
  const flows = itemsOf(project, "FLOW");
  const imported = flows.filter((f) => f.status === "IMPORTED");
  const pending = flows.filter((f) => f.status === "PENDING" || f.status === "FAILED" || f.status === "CONVERTED");
  const guidance = project.contactGuidance ? project.contactGuidance.split(/\n+/).filter(Boolean) : CONTACT_GUIDANCE_FALLBACK;

  const done: Array<[string, string]> = [
    ["Teglar", `${doneCount(project, "TAG")} / ${countOf(project, "TAG")}`],
    ["Maxsus maydonlar", `${doneCount(project, "CUSTOM_FIELD")} / ${countOf(project, "CUSTOM_FIELD")}`],
    ["Bot maydonlari", `${doneCount(project, "BOT_FIELD")} / ${countOf(project, "BOT_FIELD")}`],
    ["Flow qoralamalari", `${imported.length} / ${countOf(project, "FLOW")}`],
  ];

  return (
    <div className="space-y-6">
      <section className="panel space-y-3 rounded-xl p-4 sm:p-5" aria-labelledby="fn-done">
        <h2 id="fn-done" className="text-sm font-semibold text-foreground">
          Nima qilindi
        </h2>
        <ul className="space-y-1.5">
          {done.map(([label, value]) => (
            <li key={label} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm">
              <span className="text-foreground">{label}</span>
              <Pill tone="muted">{value}</Pill>
            </li>
          ))}
        </ul>
        {pending.length > 0 && <p className="text-xs text-warning">{pending.length} ta flow hali import qilinmagan. Yechim: &quot;Flow&apos;lar&quot; bosqichiga qaytib, matnini joylang yoki o&apos;tkazib yuboring.</p>}
        {imported.length > 0 && (
          <ul className="space-y-1">
            {imported.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="min-w-0 break-words text-foreground">{f.name}</span>
                {f.flowId && (
                  <Link className="text-accent hover:underline" href={`/developer/flows?flow=${f.flowId}`}>
                    Flows&apos;da ochish
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel space-y-3 rounded-xl p-4 sm:p-5" aria-labelledby="fn-manual">
        <h2 id="fn-manual" className="text-sm font-semibold text-foreground">
          Qo&apos;lda bajariladiganlar
        </h2>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-foreground">
          <li>
            <strong>Kontaktlarni qayta rozilik (opt-in) qildirish.</strong> ManyChat obunachilari ko&apos;chmaydi.
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
              {guidance.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </li>
          <li>Growth tool&apos;larni Comment 2.0 yoki Direct trigger sifatida qayta yarating.</li>
          <li>Har bir qoralamani Flows sandbox&apos;ida sinab ko&apos;ring (audit va policy natijasini o&apos;qing).</li>
          <li>Tayyor bo&apos;lsa Flows&apos;da nashr qiling (AI qoralamalari sinov va tasdiqlashni talab qiladi).</li>
          {project.todo.map((line, i) => (
            <li key={`m${i}`}>{line}</li>
          ))}
        </ol>
        <div className="flex flex-wrap gap-2">
          <Link className={secondaryButton} href="/developer/flows">
            Flows
          </Link>
          <Link className={secondaryButton} href="/developer/comments">
            Comment 2.0
          </Link>
          <Link className={secondaryButton} href="/developer/triggers">
            Triggerlar
          </Link>
        </div>
      </section>

      <section className="panel space-y-3 rounded-xl p-4 sm:p-5" aria-labelledby="fn-del">
        <h2 id="fn-del" className="text-sm font-semibold text-foreground">
          Loyihani tozalash
        </h2>
        <p className="text-xs text-muted">Ishingiz tugagach loyihani o&apos;chiring: saqlangan ManyChat kaliti va kiritilgan matnlar o&apos;chadi. Yaratilgan flow qoralamalari va teglar qoladi.</p>
        <DeleteProject projectId={project.id} projectName={project.name} disabled={!canWrite} onDeleted={onDeleted} />
      </section>
    </div>
  );
}
