"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Shell from "@/components/panel/Shell";
import { Bay, StatusPill, Toggle } from "@/components/ui/Kit";
import { Spark, Table, Td } from "@/components/ui/Data";
import Icon from "@/components/ui/Icon";
import { usePanelEntrance } from "@/components/motion/useActs";
import { ApiError, getCampaigns, getEvents, patchCampaign, type Campaign, type CampaignEvent } from "@/lib/api";
import { STATUS_UZ, MATCH_UZ } from "@/lib/labels";

function dayKey(d: Date) {
  return d.toISOString().slice(0, 10);
}

export default function CampaignsPage() {
  const scope = useRef<HTMLDivElement>(null);
  usePanelEntrance(scope);

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [events, setEvents] = useState<CampaignEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const since = new Date();
    since.setDate(since.getDate() - 6);
    since.setHours(0, 0, 0, 0);

    Promise.all([getCampaigns(), getEvents({ date_from: since.toISOString(), limit: 500 })])
      .then(([camps, evs]) => {
        if (cancelled) return;
        setCampaigns(camps);
        setEvents(evs);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Kampaniyalarni yuklab bo'lmadi.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const days: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(dayKey(d));
  }

  function statsFor(campaignId: string) {
    const own = events.filter((e) => e.campaign_id === campaignId);
    const spark = days.map((k) => own.filter((e) => dayKey(new Date(e.received_at)) === k).length);
    const delivered = own.filter((e) => e.public_reply_status === "sent").length;
    const failed = own.filter((e) => e.public_reply_status === "failed").length;
    return { spark, delivered, failed };
  }

  async function toggleStatus(c: Campaign) {
    const next = c.status === "active" ? "paused" : "active";
    setBusyId(c.id);
    setCampaigns((cs) => cs.map((x) => (x.id === c.id ? { ...x, status: next } : x)));
    try {
      await patchCampaign(c.id, { status: next });
    } catch (err) {
      setCampaigns((cs) => cs.map((x) => (x.id === c.id ? { ...x, status: c.status } : x)));
      setError(err instanceof ApiError ? err.message : "Holatni o'zgartirib bo'lmadi.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Shell
      title="Kampaniyalar"
      crumb={`${campaigns.length} ta · biri izohga javob beradi`}
      actions={
        <Link href="/campaigns/new" className="btn btn-primary">
          <Icon name="plus" size={16} />
          Yangi kampaniya
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

        <Bay paper label="Ro'yxat" right={<span className="util text-ink-soft">ustuvorlik bo'yicha</span>}>
          {campaigns.length === 0 ? (
            <p className="text-ink-soft text-[15px] py-6 text-center">
              {loading ? "Yuklanmoqda…" : "Hali kampaniya yo'q. \"Yangi kampaniya\" tugmasidan boshlang."}
            </p>
          ) : (
            <Table head={["№", "Nomi", "Kalit so'zlar", "Moslash", "7 kun", "Holat", ""]}>
              {campaigns.map((c, i) => {
                const s = statsFor(c.id);
                return (
                  <tr key={c.id}>
                    {/* the number is the real priority: lower fires first */}
                    <Td mono>{String(i + 1).padStart(2, "0")}</Td>
                    <Td>
                      <Link href={`/campaigns/${c.id}`} className="font-semibold hover:underline">
                        {c.name}
                      </Link>
                      <span className="util block text-ink-soft mt-0.5">
                        oxirgi 7 kunda {s.delivered} havola · {s.failed} xato
                      </span>
                    </Td>
                    <Td>
                      <span className="flex flex-wrap gap-1">
                        {c.keywords
                          .filter((k) => !k.is_negative)
                          .map((k) => (
                            <span
                              key={k.keyword}
                              className="util px-1.5 py-0.5 rounded-jack"
                              style={{ background: "var(--c-field)", color: "var(--c-paper)" }}
                            >
                              {k.keyword}
                            </span>
                          ))}
                        {c.keywords
                          .filter((k) => k.is_negative)
                          .map((k) => (
                            <span
                              key={k.keyword}
                              className="util px-1.5 py-0.5 rounded-jack"
                              style={{ border: "1px solid var(--c-madder)", color: "var(--c-madder)" }}
                              title="Bu so'z bo'lsa ishga tushmaydi"
                            >
                              −{k.keyword}
                            </span>
                          ))}
                      </span>
                    </Td>
                    <Td className="whitespace-nowrap">{MATCH_UZ[c.match_mode]}</Td>
                    <Td className="w-[120px]">
                      <Spark points={s.spark} color="var(--c-field)" />
                    </Td>
                    <Td>
                      <StatusPill state={c.status} label={STATUS_UZ[c.status]} />
                    </Td>
                    <Td>
                      <Toggle
                        id={`t-${c.id}`}
                        checked={c.status === "active"}
                        onLabel="Yoqilgan"
                        offLabel="O'chirilgan"
                        disabled={busyId === c.id || (c.status !== "active" && c.status !== "paused")}
                        onClick={() => toggleStatus(c)}
                      />
                    </Td>
                  </tr>
                );
              })}
            </Table>
          )}
        </Bay>

        <Bay label="Ustuvorlik qanday ishlaydi">
          <p className="text-b-0 measure text-paper/85">
            Bitta izoh bir nechta kampaniyaga mos kelsa, ro'yxatda yuqoridagisi
            ishga tushadi — faqat bittasi. Tartibni o'zgartirish uchun
            kampaniyani sudrab joyini almashtiring.
          </p>
        </Bay>
      </div>
    </Shell>
  );
}
