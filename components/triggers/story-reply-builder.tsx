"use client";

/**
 * Story Reply campaign builder (dev).
 *
 *   Trigger   Story Reply
 *   Scope     All stories | Specific story
 *   Condition Every reply | Keyword contains | Exact
 *   Action    Send Message   (Flow / AI / Tag / Lead / Operator / Webhook — V2)
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { MATCH_MODE_LABELS, shortStoryId } from "@/lib/triggers/display";
import {
  ChipInput,
  Choice,
  DevBadge,
  Field,
  formatDateTime,
  inputClass,
  primaryButton,
  secondaryButton,
  Toggle,
} from "@/components/developer/ui";

export interface BuilderAccount {
  id: string;
  username: string;
  tokenStatus: string;
}

export interface BuilderCampaign {
  id: string;
  name: string;
  instagramAccountId: string;
  storyScope: "ALL" | "SPECIFIC";
  storyIds: string[];
  matchingMode: "EVERY" | "CONTAINS" | "EXACT";
  keywords: string[];
  responseMessage: string;
  active: boolean;
}

interface LiveStory {
  id: string;
  mediaType: string | null;
  previewUrl: string | null;
  permalink: string | null;
  timestamp: string | null;
}

interface RepliedStory {
  storyId: string;
  storyUrl: string | null;
  lastReplyAt: string;
  replies: number;
}

const MAX_RESPONSE = 1000;

const FUTURE_ACTIONS = [
  "Start Flow",
  "Ask Question",
  "AI javob",
  "Add Tag",
  "Create Lead",
  "Assign Operator",
  "Webhook",
];

function StoryPicker({
  accountId,
  selected,
  onChange,
}: {
  accountId: string;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [live, setLive] = useState<LiveStory[]>([]);
  const [replied, setReplied] = useState<RepliedStory[]>([]);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading flag for the fetch below
    setLoading(true);
    fetch(`/api/developer/triggers/stories?accountId=${encodeURIComponent(accountId)}`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (data.success) {
          setLive(data.data.live);
          setReplied(data.data.replied);
          setLiveError(data.data.liveError);
        } else {
          setLiveError(data.error ?? "Yuklab bo'lmadi");
        }
      })
      .catch(() => !cancelled && setLiveError("Yuklab bo'lmadi"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);

  return (
    <div className="space-y-4 rounded-lg border border-border p-3">
      <div>
        <p className="mb-2 text-xs font-semibold text-muted">Hozir faol storylar</p>
        {loading ? (
          <p className="text-xs text-muted">Yuklanmoqda…</p>
        ) : live.length > 0 ? (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {live.map((story) => {
              const on = selected.includes(story.id);
              return (
                <button
                  key={story.id}
                  type="button"
                  onClick={() => toggle(story.id)}
                  aria-pressed={on}
                  className={`relative aspect-[9/16] overflow-hidden rounded-lg border-2 bg-surface-hover ${
                    on ? "border-accent" : "border-transparent"
                  }`}
                >
                  {story.previewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- Instagram CDN, short-lived URLs
                    <img src={story.previewUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="grid h-full place-items-center text-xs text-muted">{story.mediaType ?? "Story"}</span>
                  )}
                  <span className="absolute inset-x-0 bottom-0 bg-black/60 px-1 py-0.5 text-[10px] text-white">
                    {shortStoryId(story.id)}
                  </span>
                  {on && (
                    <span className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-accent text-xs font-bold text-background">
                      ✓
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-muted">
            {liveError ? `Instagram'dan olib bo'lmadi: ${liveError}` : "Hozir faol story yo'q."}
          </p>
        )}
      </div>

      {replied.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-semibold text-muted">Reply kelgan storylar</p>
          <div className="flex flex-wrap gap-1.5">
            {replied.map((story) => {
              const on = selected.includes(story.storyId);
              return (
                <button
                  key={story.storyId}
                  type="button"
                  onClick={() => toggle(story.storyId)}
                  aria-pressed={on}
                  className={`rounded-md border px-2 py-1 text-xs ${
                    on ? "border-accent bg-accent/10 text-foreground" : "border-border text-muted hover:text-foreground"
                  }`}
                  title={`Oxirgi reply: ${formatDateTime(story.lastReplyAt)}`}
                >
                  Story {shortStoryId(story.storyId)} · {story.replies} reply
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div>
        <p className="mb-2 text-xs font-semibold text-muted">Tanlangan story ID lar (qo&apos;lda ham qo&apos;shish mumkin)</p>
        <ChipInput values={selected} onChange={onChange} placeholder="Story ID kiriting va Enter" />
      </div>
    </div>
  );
}

function Preview({ keyword, mode, message }: { keyword: string; mode: string; message: string }) {
  const sample = mode === "EVERY" ? "Narxi qancha?" : mode === "EXACT" ? keyword || "narx" : `${keyword || "narx"}i qancha?`;
  return (
    <div className="panel rounded-xl p-4">
      <p className="label-mono mb-3 text-[11px] font-semibold text-muted">Ko&apos;rinishi</p>
      <div className="space-y-3">
        <div className="mx-auto w-28 rounded-lg bg-gradient-to-b from-accent/30 to-gold/20 p-2 text-center text-[10px] text-foreground">
          📸 Story
          <br />
          “Bugun barcha kurslarga -20% 🔥”
        </div>
        <div className="flex justify-start">
          <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-surface-hover px-3 py-2 text-sm text-foreground">
            <span className="mb-1 block text-[10px] text-muted">Storyga javob berdi</span>
            {sample}
          </div>
        </div>
        <div className="flex justify-end">
          <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-accent/20 px-3 py-2 text-sm text-foreground">
            {message.trim() || "Javob matni shu yerda ko'rinadi"}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function StoryReplyBuilder({
  accounts,
  campaign,
}: {
  accounts: BuilderAccount[];
  campaign?: BuilderCampaign;
}) {
  const router = useRouter();
  const isEdit = Boolean(campaign);
  const [name, setName] = useState(campaign?.name ?? "Story reply");
  const [accountId, setAccountId] = useState(campaign?.instagramAccountId ?? accounts[0]?.id ?? "");
  const [storyScope, setStoryScope] = useState<"ALL" | "SPECIFIC">(campaign?.storyScope ?? "ALL");
  const [storyIds, setStoryIds] = useState<string[]>(campaign?.storyIds ?? []);
  const [matchingMode, setMatchingMode] = useState<"EVERY" | "CONTAINS" | "EXACT">(campaign?.matchingMode ?? "CONTAINS");
  const [keywords, setKeywords] = useState<string[]>(campaign?.keywords ?? []);
  const [responseMessage, setResponseMessage] = useState(campaign?.responseMessage ?? "");
  const [active, setActive] = useState(campaign?.active ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const account = useMemo(() => accounts.find((a) => a.id === accountId), [accounts, accountId]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(isEdit ? `/api/developer/triggers/campaigns/${campaign!.id}` : "/api/developer/triggers/campaigns", {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          instagramAccountId: accountId,
          triggerType: "STORY_REPLY",
          storyScope,
          storyIds,
          matchingMode,
          keywords,
          responseType: "SEND_MESSAGE",
          responseMessage,
          active,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error ?? "Saqlab bo'lmadi");
        return;
      }
      router.push("/developer/triggers?tab=campaigns");
      router.refresh();
    } catch {
      setError("Tarmoq xatosi — qayta urinib ko'ring");
    } finally {
      setSaving(false);
    }
  }

  if (accounts.length === 0) {
    return (
      <div className="panel rounded-xl p-6 text-sm text-muted">
        Avval Instagram akkaunt ulang: <Link className="text-accent" href="/settings">Sozlamalar</Link>.
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-5">
        <section className="panel space-y-4 rounded-xl p-4 sm:p-5">
          <Field label="Campaign nomi">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </Field>
          <Field
            label="Instagram akkaunt"
            error={account?.tokenStatus === "BROKEN" ? "Bu akkaunt ulanishi uzilgan — javoblar yuborilmaydi." : null}
          >
            <select className={inputClass} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.username}
                </option>
              ))}
            </select>
          </Field>
        </section>

        <section className="panel space-y-4 rounded-xl p-4 sm:p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Trigger</h2>
            <span className="rounded-md bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent">Story Reply</span>
          </div>

          <Field label="Scope">
            <div className="grid gap-2 sm:grid-cols-2">
              <Choice
                checked={storyScope === "ALL"}
                onSelect={() => setStoryScope("ALL")}
                title="All Stories"
                description="Har qanday storyga kelgan reply"
              />
              <Choice
                checked={storyScope === "SPECIFIC"}
                onSelect={() => setStoryScope("SPECIFIC")}
                title="Specific Story"
                description="Faqat tanlangan storylar"
              />
            </div>
          </Field>
          {storyScope === "SPECIFIC" && <StoryPicker accountId={accountId} selected={storyIds} onChange={setStoryIds} />}

          <Field label="Trigger condition">
            <div className="grid gap-2 sm:grid-cols-3">
              {(["EVERY", "CONTAINS", "EXACT"] as const).map((mode) => (
                <Choice
                  key={mode}
                  checked={matchingMode === mode}
                  onSelect={() => setMatchingMode(mode)}
                  title={MATCH_MODE_LABELS[mode]}
                />
              ))}
            </div>
          </Field>
          {matchingMode !== "EVERY" && (
            <Field
              label="Kalit so'zlar"
              hint={
                matchingMode === "CONTAINS"
                  ? "Katta-kichik harf farqi yo'q. “narx” → narx, narxi, narxi qancha? ni ushlaydi."
                  : "Reply butunlay shu so'zga teng bo'lsa (tinish belgisi va emoji hisobga olinmaydi)."
              }
            >
              <ChipInput values={keywords} onChange={setKeywords} placeholder="narx, цена, kurs…" />
            </Field>
          )}
        </section>

        <section className="panel space-y-4 rounded-xl p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-foreground">Action</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            <Choice checked onSelect={() => {}} title="Send Message" description="DM orqali javob yuborish" />
            {FUTURE_ACTIONS.map((label) => (
              <Choice key={label} checked={false} disabled onSelect={() => {}} title={label} badge="V2" />
            ))}
          </div>
          <Field label="Javob matni" hint={`${responseMessage.length}/${MAX_RESPONSE}`}>
            <textarea
              className={`${inputClass} min-h-32`}
              value={responseMessage}
              maxLength={MAX_RESPONSE}
              onChange={(e) => setResponseMessage(e.target.value)}
              placeholder="Assalomu alaykum! 😊 Kurs narxi 450 000 so'm. Qaysi darajada ekaningizni aytsangiz, sizga mos kursni tavsiya qilaman."
            />
          </Field>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
            <div>
              <p className="text-sm font-medium text-foreground">Faol</p>
              <p className="text-xs text-muted">O&apos;chirilgan campaign reply&apos;larga javob bermaydi.</p>
            </div>
            <Toggle on={active} onChange={setActive} label="Faol" />
          </div>
        </section>

        {error && <p className="rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">{error}</p>}

        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={primaryButton} onClick={save} disabled={saving}>
            {saving ? "Saqlanmoqda…" : isEdit ? "Saqlash" : "Campaign yaratish"}
          </button>
          <Link href="/developer/triggers?tab=campaigns" className={secondaryButton}>
            Bekor qilish
          </Link>
          <DevBadge />
        </div>
      </div>

      <aside className="lg:sticky lg:top-4 lg:self-start">
        <Preview keyword={keywords[0] ?? ""} mode={matchingMode} message={responseMessage} />
      </aside>
    </div>
  );
}
