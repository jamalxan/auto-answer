"use client";

import { useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { secondaryButton } from "@/components/developer/ui";
import { copyText } from "./shared";

/**
 * The signing secret, shown exactly once (it is stored encrypted and never
 * returned again). The owner copies it into the receiver, then dismisses.
 */
export default function SecretBox({
  secret,
  title,
  note,
  onDismiss,
}: {
  secret: string;
  title: string;
  note?: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);

  return (
    <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-3" role="status">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="text-xs text-muted">
        Bu kalit faqat hozir ko&apos;rsatiladi — sahifani yopsangiz qayta ko&apos;rib bo&apos;lmaydi. Qabul qiluvchi serverga saqlab qo&apos;ying.
        {note ? ` ${note}` : ""}
      </p>
      <code className="block break-all rounded-md bg-surface px-3 py-2 font-mono text-xs text-foreground" aria-label="Maxfiy kalit">
        {secret}
      </code>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={secondaryButton}
          onClick={async () => setCopied((await copyText(secret)) ? "yes" : "no")}
        >
          Nusxalash
        </button>
        <button type="button" className={secondaryButton} onClick={onDismiss}>
          Nusxaladim, yopish
        </button>
        {copied === "yes" && <span className="text-xs text-success">Nusxalandi</span>}
        {copied === "no" && <Notice tone="warning">Brauzer nusxalashga ruxsat bermadi — kalitni qo&apos;lda belgilab oling.</Notice>}
      </div>
    </div>
  );
}
