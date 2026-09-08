"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Shell from "@/components/panel/Shell";
import { Bay, StatusPill } from "@/components/ui/Kit";
import { Spark, Table, Td } from "@/components/ui/Data";
import Icon from "@/components/ui/Icon";
import { usePanelEntrance } from "@/components/motion/useActs";
import {
  ApiError,
  getAccounts,
  getCampaigns,
  getEvents,
  type Account,
  type Campaign,
  type CampaignEvent,
} from "@/lib/api";
import { STATUS_UZ, MATCH_RESULT_UZ, REPLY_STATUS_UZ } from "@/lib/labels";

function dayKey(d: Date) {
  return d.toISOString().slice(0, 10);
}

export default function DashboardPage() {
  const scope = useRef<HTMLDivElement>(null);
  usePanelEntrance(scope);

  const [account, setAccount] = useState<Account | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [events, setEvents] = useState<CampaignEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const since = new Date();
    since.setDate(since.getDate() - 6);
    since.setHours(0, 0, 0, 0);

    Promise.all([getAccounts(), getCampaigns(), getEvents({ date_from: since.toISOString(), limit: 500 })])
      .then(([accs, camps, evs]) => {
        if (cancelled) return;
        setAccount(accs[0] ?? null);
        setCampaigns(camps);
        setEvents(evs);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Ma'lumotlarni yuklab bo'lmadi.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const todayKey = dayKey(new Date());
  const todayEvents = events.filter((e) => dayKey(new Date(e.received_at)) === todayKey);
  const triggersToday = todayEvents.length;
  const deliveredToday = todayEvents.filter((e) => e.public_reply_status === "sent").length;
  const failedToday = todayEvents.filter((e) => e.public_reply_status === "failed").length;

  const days: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(dayKey(d));
  }
  const spark = days.map((k) => events.filter((e) => dayKey(new Date(e.received_at)) === k).length);

  const recentEvents = [...events]
    .sort((a, b) => +new Date(b.received_at) - +new Date(a.received_at))
    .slice(0, 8);
  const activeCampaigns = campaigns.filter((c) => c.status === "active").slice(0, 6);

  const tokenDaysLeft = account?.token_expires_at
    ? Math.max(0, Math.ceil((new Date(account.token_expires_at).getTime() - Date.now()) / 86400000))
    : null;

  return (
    <Shell
      title="Bugungi holat"
      crumb={`${new Date().toLocaleDateString("uz-UZ", { day: "2-digit", month: "long" })} · Toshkent vaqti`}
      actions={
        <Link href="/campaigns/new" className="btn btn-primary">
          <Icon name="plus" size={16} />
          Kampaniya
        </Link>
      }
    >
      <div ref={scope} className="space-y-4">
        {error && (
          <p
            className="util px-4 py-3 rounded-bay"
            style={{ background: "var(--c-madder)", color: "var(--c-paper)" }}
          >
            {error}
          </p>
        )}

        {/* focal bay: today's number, the only signal-coloured thing here */}
        <Bay
          paper
          label="Bugun ishga tushdi"
          right={<span className="util text-ink-soft">oxirgi 7 kun</span>}
        >
          <div className="flex flex-wrap items-end gap-x-10 gap-y-4">
            <p className="display text-[clamp(3rem,9vw,6rem)]" style={{ color: "var(--c-field)" }}>
              {loading ? "…" : triggersToday}
            </p>
            <div className="min-w-[220px] flex-1">
              <Spark points={spark} color="var(--c-field)" />
              <p className="util text-ink-soft mt-1">
                {days[0].slice(5)} → {days[6].slice(5)}
              </p>
            </div>
            <dl className="flex gap-8">
              <div>
                <dt className="util text-ink-soft">havola yetdi</dt>
                <dd className="font-display text-d-1">{deliveredToday}</dd>
              </div>
              <div>
                <dt className="util text-ink-soft">yetmadi</dt>
                <dd className="font-display text-d-1" style={{ color: "var(--c-madder)" }}>
                  {failedToday}
                </dd>
              </div>
            </dl>
          </div>
        </Bay>

        <div className="grid lg:grid-cols-[1.4fr_1fr] gap-4">
          {/* live stream */}
          <Bay
            paper
            label="Oxirgi izohlar"
            right={
              <Link href="/logs" className="util hover:underline" style={{ color: "var(--c-field)" }}>
                Barchasi
              </Link>
            }
          >
            {recentEvents.length === 0 ? (
              <p className="text-ink-soft text-[15px] py-6 text-center">
                {loading ? "Yuklanmoqda…" : "Hali hech qanday izoh qayd etilmagan."}
              </p>
            ) : (
              <Table head={["Vaqt", "Foydalanuvchi", "Izoh", "Natija"]}>
                {recentEvents.map((e) => (
                  <tr key={e.id}>
                    <Td mono>
                      {new Date(e.received_at).toLocaleTimeString("uz-UZ", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </Td>
                    <Td>{e.ig_username ? `@${e.ig_username}` : e.ig_user_id}</Td>
                    <Td className="max-w-[220px] truncate">{e.comment_text}</Td>
                    <Td>
                      <StatusPill
                        state={e.match_result === "matched" ? e.public_reply_status : e.match_result}
                        label={
                          e.match_result === "matched"
                            ? REPLY_STATUS_UZ[e.public_reply_status]
                            : MATCH_RESULT_UZ[e.match_result]
                        }
                      />
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Bay>

          <div className="space-y-4">
            {/* connection health */}
            <Bay
              label="Ulanish"
              right={
                account && (
                  <StatusPill
                    state={account.status === "active" ? "active" : "paused"}
                    label={account.status === "active" ? "ulangan" : account.status}
                  />
                )
              }
            >
              {account ? (
                <>
                  <p className="text-b-0">@{account.ig_username}</p>
                  <dl className="util mt-3 space-y-2 text-paper/60">
                    <div className="flex justify-between gap-3">
                      <dt>token</dt>
                      <dd style={{ color: "var(--c-saffron)" }}>
                        {tokenDaysLeft !== null ? `${tokenDaysLeft} kun qoldi` : "noma'lum"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt>webhook</dt>
                      <dd className="text-paper/85">{account.webhook_subscribed ? "faol" : "ulanmagan"}</dd>
                    </div>
                  </dl>
                </>
              ) : (
                <p className="text-paper/70 text-[15px]">
                  {loading ? "Yuklanmoqda…" : "Instagram akkounti ulanmagan."}
                </p>
              )}
              <Link href="/accounts" className="btn btn-ghost mt-4 w-full">
                Ulanishni boshqarish
              </Link>
            </Bay>

            {/* active campaigns */}
            <Bay label="Faol kampaniyalar">
              {activeCampaigns.length === 0 ? (
                <p className="text-paper/70 text-[15px]">
                  {loading ? "Yuklanmoqda…" : "Faol kampaniya yo'q."}
                </p>
              ) : (
                <ul className="space-y-2">
                  {activeCampaigns.map((c) => (
                    <li key={c.id}>
                      <Link
                        href={`/campaigns/${c.id}`}
                        className="flex items-center gap-3 px-3 py-2.5 rounded-bay min-h-[44px] transition-colors duration-200 hover:bg-field-lift"
                        style={{ border: "1px solid var(--c-line)" }}
                      >
                        <span className="min-w-0">
                          <span className="block truncate">{c.name}</span>
                          <span className="util text-paper/50">
                            {c.keywords
                              .filter((k) => !k.is_negative)
                              .map((k) => k.keyword)
                              .join(" · ") || "kalit so'z yo'q"}
                          </span>
                        </span>
                        <span className="ml-auto shrink-0">
                          <StatusPill state={c.status} label={STATUS_UZ[c.status]} />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Bay>
          </div>
        </div>
      </div>
    </Shell>
  );
}
