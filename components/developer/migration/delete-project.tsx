"use client";

import { useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { primaryButton, secondaryButton } from "@/components/developer/ui";
import { MIGRATION_API, requestJson } from "./shared";

/** Inline confirm (no window.confirm): deleting wipes the stored ManyChat key and the checklist. */
export default function DeleteProject({
  projectId,
  projectName,
  disabled,
  onDeleted,
}: {
  projectId: string;
  projectName: string;
  disabled?: boolean;
  onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await requestJson(`${MIGRATION_API}/projects/${projectId}`, { method: "DELETE" });
      if (res.ok) onDeleted();
      else setError(res.error);
    } finally {
      setBusy(false);
    }
  }

  if (!confirming) {
    return (
      <button type="button" className={secondaryButton} disabled={disabled} onClick={() => setConfirming(true)} aria-label={`${projectName} loyihasini o'chirish`}>
        Loyihani o&apos;chirish
      </button>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-error/30 bg-error/5 p-3" role="group" aria-label="O'chirishni tasdiqlash">
      <p className="text-sm text-foreground">
        &quot;{projectName}&quot; o&apos;chiriladi: saqlangan ManyChat API kaliti, ro&apos;yxatlar va kiritilgan matnlar butunlay tozalanadi. Import qilingan teglar va yaratilgan qoralama flow&apos;lar saqlanib qoladi. Davom etasizmi?
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={primaryButton} disabled={busy} onClick={() => void remove()}>
          {busy ? "O'chirilmoqda…" : "Ha, o'chirish"}
        </button>
        <button type="button" className={secondaryButton} disabled={busy} onClick={() => setConfirming(false)}>
          Bekor qilish
        </button>
      </div>
    </div>
  );
}
