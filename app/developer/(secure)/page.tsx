import Link from "next/link";
import { DEVELOPER_MODULES, MODULE_STATUS_LABEL, type ModuleStatus } from "@/lib/developer/modules";

export const metadata = { title: "Umumiy" };

const STATUS_CLASS: Record<ModuleStatus, string> = {
  PLANNED: "text-muted",
  BUILDING: "text-warning",
  TESTING: "text-accent",
  READY: "text-success",
};

// The master plan at a glance: every stage, what it covers, where it stands.
export default function DeveloperOverviewPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-extrabold">Developer</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Bu yerda qurilayotgan modullar asosiy mahsulotdan alohida turadi va mijozlarga
          ko’rinmaydi. Har bir modul testlardan o’tib, siz tasdiqlaganingizdan keyingina asosiy
          UI ga qo’shiladi.
        </p>
      </div>

      <ol className="grid gap-3 sm:grid-cols-2">
        {DEVELOPER_MODULES.map((module) => {
          const body = (
            <>
              <div className="flex items-start justify-between gap-3">
                <span className="label-mono text-[11px] font-semibold text-muted">
                  ETAP {module.etap}
                </span>
                <span
                  className={`whitespace-nowrap text-xs font-semibold ${STATUS_CLASS[module.status]}`}
                >
                  {MODULE_STATUS_LABEL[module.status]}
                </span>
              </div>
              <h2 className="mt-1 font-semibold text-foreground">{module.title}</h2>
              <p className="mt-1 text-sm text-muted">{module.summary}</p>
            </>
          );
          return (
            <li key={module.key}>
              {module.href ? (
                <Link
                  href={module.href}
                  className="block h-full rounded-lg border border-border bg-surface p-4 transition-colors hover:border-accent/40"
                >
                  {body}
                </Link>
              ) : (
                <div className="h-full rounded-lg border border-dashed border-border p-4 opacity-70">
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
