"use client";

import AuditPanel from "@/components/developer/flows/audit-panel";
import { BlockOutline } from "@/components/developer/flows/previews";
import { Pill } from "@/components/developer/ui";
import { warningLine, type ConversionPreview } from "./shared";

/** Preview of an AI conversion: the blocks, the audit / policy verdict and the explicit manual list. */
export default function ConversionPreviewView({ preview }: { preview: ConversionPreview }) {
  // Everything the owner must do by hand: findings that need action, then the fixed follow-ups.
  const manual = [
    ...preview.warnings.filter((w) => w.severity !== "info").map(warningLine),
    "Flows sandbox'ida har bir tarmoqni sinab ko'ring (xabarlar, tugmalar, shartlar).",
    "Matnlar, narxlar va havolalarni o'zingiz tekshiring: AI ularni taxmin qilgan bo'lishi mumkin.",
  ];
  return (
    <div className="space-y-4">
      <section aria-label="Bloklar" className="space-y-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          Yaratilgan bloklar <Pill tone="muted">{preview.graph.nodes.length}</Pill>
        </h3>
        {preview.summary && <p className="text-xs text-muted">{preview.summary}</p>}
        <BlockOutline graph={preview.graph} meta={null} />
      </section>

      <section aria-label="Audit va policy" className="space-y-2">
        <h3 className="text-sm font-semibold text-foreground">Audit va policy</h3>
        <AuditPanel audit={preview.audit} policy={preview.policy} onFocus={() => undefined} />
      </section>

      <section aria-label="Qo'lda bajariladiganlar" className="space-y-2 rounded-xl border border-warning/30 p-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          Qo&apos;lda bajariladiganlar <Pill tone="warning">{manual.length}</Pill>
        </h3>
        <ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
          {manual.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
