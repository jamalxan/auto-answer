"use client";

import { useSearchParams } from "next/navigation";
import { useLanguage } from "@/components/language-provider";
import type { Dictionary } from "@/lib/i18n/dictionary";

type Tone = "error" | "warning" | "success";

// Filled tints only, no outline: the tone is the surface.
const TONE_CLASSES: Record<Tone, string> = {
  error: "bg-error/12 text-error",
  warning: "bg-warning/12 text-warning",
  success: "bg-lime/12 text-lime",
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
              // Environment variable names are code, so they keep the mono face.
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
          <p className="mt-2 break-words text-xs opacity-80">
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
    <div className={`rounded-2xl p-4 text-sm leading-6 ${TONE_CLASSES[tone]}`}>
      <p className="font-semibold">{title}</p>
      <div className="mt-1 opacity-90">{children}</div>
    </div>
  );
}
