"use client";

/**
 * Create Automation → Instagram → trigger → builder.
 *
 * Every ETAP 3 trigger is listed with a one-line explanation. Direct, ad
 * message, ig.me link and Story Mention open the DM-trigger builder here;
 * Story Reply keeps its V1 builder; live and post comments live in the
 * Comment 2.0 builder, so they link there. Story Reaction is shown but
 * disabled: it runs in observation mode until Meta confirms the payload.
 * `?type=<KIND>` skips straight to the builder.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AUTOMATION_KIND_LABELS } from "@/lib/triggers/display";
import StoryReplyBuilder, { type BuilderAccount } from "./story-reply-builder";
import DmTriggerBuilder from "@/components/developer/dm-triggers/dm-trigger-builder";
import { isDmKind, type DmKind } from "@/components/developer/dm-triggers/shared";
import type { IntentOption } from "@/components/developer/comments/shared";
import { Choice, DevBadge } from "@/components/developer/ui";

type BuildKind = DmKind | "STORY_REPLY";

const TRIGGERS: Array<{ key: string; href?: string }> = [
  { key: "DIRECT" },
  { key: "AD_MESSAGE" },
  { key: "LINK" },
  { key: "STORY_MENTION" },
  { key: "STORY_REPLY" },
  { key: "LIVE_COMMENT", href: "/comments/new?source=live" },
];

export default function CreateAutomation({
  accounts,
  intents,
  initialType,
}: {
  accounts: BuilderAccount[];
  intents: IntentOption[];
  initialType?: string | null;
}) {
  const router = useRouter();
  const preset: BuildKind | null =
    initialType === "STORY_REPLY" || isDmKind(initialType) ? (initialType as BuildKind) : null;
  const [step, setStep] = useState<"channel" | "trigger" | "build">(preset ? "build" : "channel");
  const [kind, setKind] = useState<BuildKind>(preset ?? "DIRECT");

  function pick(key: string, href?: string) {
    if (href) {
      router.push(href);
      return;
    }
    setKind(key as BuildKind);
    setStep("build");
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <Link href="/triggers" className="text-sm text-muted hover:text-foreground">
          ← Instagram Triggers
        </Link>
        <div className="mt-2 flex items-center gap-2">
          <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground">
            {step === "build" ? `Yangi automation · ${AUTOMATION_KIND_LABELS[kind].title}` : "Yangi automation"}
          </h1>
          <DevBadge />
        </div>
        <ol className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
          <li className={step === "channel" ? "font-semibold text-foreground" : ""}>1. Kanal</li>
          <li aria-hidden="true">→</li>
          <li className={step === "trigger" ? "font-semibold text-foreground" : ""}>2. Trigger</li>
          <li aria-hidden="true">→</li>
          <li className={step === "build" ? "font-semibold text-foreground" : ""}>3. Sozlash</li>
        </ol>
      </div>

      {step === "channel" && (
        <div className="grid max-w-2xl gap-2 sm:grid-cols-2">
          <Choice checked={false} onSelect={() => setStep("trigger")} title="Instagram" description="Direct, Story, Live, reklama, havola" />
          <Choice checked={false} disabled onSelect={() => {}} title="Telegram" badge="keyin" />
        </div>
      )}

      {step === "trigger" && (
        <div className="max-w-2xl space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            {TRIGGERS.map((trigger) => (
              <Choice
                key={trigger.key}
                checked={false}
                onSelect={() => pick(trigger.key, trigger.href)}
                title={AUTOMATION_KIND_LABELS[trigger.key].title}
                description={AUTOMATION_KIND_LABELS[trigger.key].description}
                badge={trigger.href ? "Comment 2.0 builder" : undefined}
              />
            ))}
            <div>
              <Choice
                checked={false}
                disabled
                onSelect={() => {}}
                title="Story reaction"
                description="Kuzatuv rejimi — Meta hali tasdiqlamagan"
              />
              <Link
                href="/triggers?tab=logs&type=MESSAGE_REACTION"
                className="mt-1 inline-block px-1 text-xs text-accent hover:underline"
              >
                Kelgan reaksiyalarni logda ko&apos;rish →
              </Link>
            </div>
          </div>
          <p className="text-xs text-muted">
            Post ostidagi kommentlar uchun:{" "}
            <Link href="/comments/new" className="text-accent hover:underline">
              Comment Automation 2.0
            </Link>
            .
          </p>
          <button type="button" onClick={() => setStep("channel")} className="text-sm text-muted hover:text-foreground">
            ← Orqaga
          </button>
        </div>
      )}

      {step === "build" && (
        <div className="space-y-3">
          {!preset && (
            <button type="button" onClick={() => setStep("trigger")} className="text-sm text-muted hover:text-foreground">
              ← Boshqa trigger tanlash
            </button>
          )}
          {kind === "STORY_REPLY" ? (
            <StoryReplyBuilder accounts={accounts} />
          ) : (
            <DmTriggerBuilder key={kind} accounts={accounts} intents={intents} initialKind={kind} />
          )}
        </div>
      )}
    </div>
  );
}
