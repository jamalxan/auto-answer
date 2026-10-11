"use client";

/**
 * Create Automation → Instagram → trigger → builder.
 *
 * Only Story Reply is live. The other triggers are listed in their planned
 * order so the shape of the module is visible, but cannot be picked yet.
 */

import Link from "next/link";
import { useState } from "react";
import StoryReplyBuilder, { type BuilderAccount } from "./story-reply-builder";
import { Choice, DevBadge } from "./trigger-ui";

const TRIGGERS: Array<{ key: string; title: string; description: string; ready: boolean }> = [
  { key: "STORY_REPLY", title: "Story Reply", description: "Kimdir story'ga javob yozganda", ready: true },
  { key: "STORY_MENTION", title: "Story Mention", description: "Akkaunt story'da belgilanganda", ready: false },
  { key: "DIRECT_MESSAGE", title: "Direct Message", description: "Direct'ga xabar kelganda", ready: false },
  { key: "LIVE_COMMENT", title: "Live Comment", description: "Jonli efirdagi izoh", ready: false },
  { key: "STORY_REACTION", title: "Story Reaction", description: "API imkoniyati tekshirilmoqda", ready: false },
  { key: "ADS", title: "Ads Trigger", description: "Reklama orqali kelgan xabar", ready: false },
];

export default function CreateAutomation({ accounts }: { accounts: BuilderAccount[] }) {
  const [step, setStep] = useState<"channel" | "trigger" | "build">("channel");

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <Link href="/dev/triggers" className="text-sm text-muted hover:text-foreground">
          ← Instagram Triggers
        </Link>
        <div className="mt-2 flex items-center gap-2">
          <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground">Automation yaratish</h1>
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
          <Choice checked={false} onSelect={() => setStep("trigger")} title="Instagram" description="Story, Direct, Live, Comment" />
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
                disabled={!trigger.ready}
                onSelect={() => setStep("build")}
                title={trigger.title}
                description={trigger.description}
                badge={trigger.ready ? undefined : "keyingi bosqich"}
              />
            ))}
          </div>
          <button type="button" onClick={() => setStep("channel")} className="text-sm text-muted hover:text-foreground">
            ← Orqaga
          </button>
        </div>
      )}

      {step === "build" && <StoryReplyBuilder accounts={accounts} />}
    </div>
  );
}
