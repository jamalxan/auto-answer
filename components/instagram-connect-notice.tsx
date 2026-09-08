"use client";

import { useSearchParams } from "next/navigation";
import { useLanguage } from "@/components/language-provider";
import type { Dictionary } from "@/lib/i18n/dictionary";

type Tone = "error" | "warning" | "success";

const TONE_CLASSES: Record<Tone, string> = {
  error: "border-error/20 bg-error/10 text-error",
  warning: "border-warning/20 bg-warning/10 text-warning",
  success: "border-success/20 bg-success/10 text-success",
};

function getMessages(
  t: Dictionary
): Record<string, { tone: Tone; title: string; detail: string }> {
  return {
    denied: {
      tone: "warning",
      title: t.instagramNotice.deniedTitle,
      detail: t.instagramNotice.deniedDetail,
    },
    invalid: {
      tone: "error",
      title: t.instagramNotice.invalidTitle,
      detail: t.instagramNotice.invalidDetail,
    },
    forbidden: {
      tone: "error",
      title: t.instagramNotice.forbiddenTitle,
      detail: t.instagramNotice.forbiddenDetail,
    },
    already_connected: {
      tone: "warning",
      title: t.instagramNotice.alreadyConnectedTitle,
      detail: t.instagramNotice.alreadyConnectedDetail,
    },
  };
}

export function InstagramConnectNotice() {
  const searchParams = useSearchParams();
  const { t } = useLanguage();
  const status = searchParams.get("instagram");

  if (!status) return null;

  if (status === "misconfigured") {
    const missing = (searchParams.get("missing") ?? "")
      .split(",")
      .filter(Boolean);

    return (
      <Notice tone="error" title={t.instagramNotice.misconfiguredTitle}>
        <p>
          {missing.length > 0
            ? t.instagramNotice.setTheseVars
            : t.instagramNotice.setRequiredVars}
        </p>
        {missing.length > 0 && (
          <ul className="mt-2 space-y-1">
            {missing.map((name) => (
              <li key={name} className="font-mono text-xs">
                {name}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2">{t.instagramNotice.fromMetaDashboard}</p>
      </Notice>
    );
  }

  if (status === "failed") {
    const reason = searchParams.get("reason");

    return (
      <Notice tone="error" title={t.instagramNotice.failedTitle}>
        <p>{t.instagramNotice.failedDetail}</p>
        {reason && (
          <p className="mt-2 font-mono text-xs break-words opacity-80">
            {reason}
          </p>
        )}
      </Notice>
    );
  }

  const known = getMessages(t)[status];
  if (!known) return null;

  return (
    <Notice tone={known.tone} title={known.title}>
      <p>{known.detail}</p>
    </Notice>
  );
}

function Notice({
  tone,
  title,
  children,
}: {
  tone: Tone;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded border p-4 text-sm ${TONE_CLASSES[tone]}`}>
      <p className="font-semibold">{title}</p>
      <div className="mt-1 opacity-90">{children}</div>
    </div>
  );
}
