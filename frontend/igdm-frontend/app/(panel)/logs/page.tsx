"use client";

import { useEffect, useRef, useState } from "react";
import Shell from "@/components/panel/Shell";
import { Bay, Empty, StatusPill } from "@/components/ui/Kit";
import { Table, Td } from "@/components/ui/Data";
import { usePanelEntrance } from "@/components/motion/useActs";
import { ApiError, getCampaigns, getEvents, type Campaign, type CampaignEvent } from "@/lib/api";
import { MATCH_RESULT_UZ, REPLY_STATUS_UZ } from "@/lib/labels";

export default function LogsPage() {
  const scope = useRef<HTMLDivElement>(null);
  usePanelEntrance(scope);

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [events, setEvents] = useState<CampaignEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [q, setQ] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [matchResult, setMatchResult] = useState("");

  useEffect(() => {
    getCampaigns()
      .then(setCampaigns)
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getEvents({ campaign_id: campaignId || undefined, status: matchResult || undefined, limit: 200 })
      .then((evs) => {
        if (!cancelled) setEvents(evs);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Jurnalni yuklab bo'lmadi.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [campaignId, matchResult]);

  const campaignName = (id: string | null) => (id ? campaigns.find((c) => c.id === id)?.name ?? id : "—");

  const rows = events.filter(
    (e) =>
      e.comment_text.toLowerCase().includes(q.toLowerCase()) ||
      (e.ig_username ?? "").toLowerCase().includes(q.toLowerCase())
  );

  return (
    <Shell title="Jurnal" crumb="har bir izoh va uning taqdiri">
      <div ref={scope} className="space-y-4">
        {error && (
          <p
            className="util px-4 py-3 rounded-bay"
            style={{ background: "var(--c-madder)", color: "var(--c-paper)" }}
          >
            {error}
          </p>
        )}

        <Bay paper label="Filtr">
          <div className="grid sm:grid-cols-4 gap-3">
            <label className="sm:col-span-2 relative">
              <span className="util block text-ink-soft mb-1.5">Izoh yoki username bo'yicha qidirish</span>
              <input
                className="input"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="tizim"
              />
            </label>
            <label>
              <span className="util block text-ink-soft mb-1.5">Kampaniya</span>
              <select className="input" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
                <option value="">Barchasi</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="util block text-ink-soft mb-1.5">Natija</span>
              <select className="input" value={matchResult} onChange={(e) => setMatchResult(e.target.value)}>
                <option value="">Barchasi</option>
                {Object.entries(MATCH_RESULT_UZ).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </Bay>

        <Bay paper label={`Hodisalar · ${rows.length} ta`}>
          {rows.length === 0 ? (
            <Empty
              title={loading ? "Yuklanmoqda…" : "Bunday izoh topilmadi"}
              body="Qidiruvni qisqartiring yoki boshqa kampaniyani tanlang. Jurnal 12 oy saqlanadi."
              action={
                (q || campaignId || matchResult) && (
                  <button
                    className="btn btn-ghost"
                    onClick={() => {
                      setQ("");
                      setCampaignId("");
                      setMatchResult("");
                    }}
                    type="button"
                  >
                    Filtrni tozalash
                  </button>
                )
              }
            />
          ) : (
            <Table head={["Vaqt", "Kampaniya", "Foydalanuvchi", "Izoh", "Mos so'z", "Ochiq javob", "Natija"]}>
              {rows.map((e) => (
                <tr key={e.id}>
                  <Td mono>
                    {new Date(e.received_at).toLocaleString("uz-UZ", {
                      day: "2-digit",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </Td>
                  <Td className="max-w-[200px] truncate">{campaignName(e.campaign_id)}</Td>
                  <Td>{e.ig_username ? `@${e.ig_username}` : e.ig_user_id}</Td>
                  <Td className="max-w-[220px] truncate">{e.comment_text}</Td>
                  <Td mono>{e.matched_keyword ?? "—"}</Td>
                  <Td>{REPLY_STATUS_UZ[e.public_reply_status] ?? e.public_reply_status}</Td>
                  <Td>
                    <StatusPill state={e.match_result} label={MATCH_RESULT_UZ[e.match_result] ?? e.match_result} />
                    {e.public_reply_status === "failed" && e.public_reply_error && (
                      <span className="block text-[13px] mt-1" style={{ color: "var(--c-madder)" }}>
                        {e.public_reply_error}
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Bay>
      </div>
    </Shell>
  );
}
