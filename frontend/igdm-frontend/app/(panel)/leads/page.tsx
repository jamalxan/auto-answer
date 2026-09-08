"use client";

import { useEffect, useRef, useState } from "react";
import Shell from "@/components/panel/Shell";
import { Bay, StatusPill } from "@/components/ui/Kit";
import { Table, Td } from "@/components/ui/Data";
import Icon from "@/components/ui/Icon";
import { usePanelEntrance } from "@/components/motion/useActs";
import { ApiError, exportLeadsCsv, getCampaigns, getLeads, type Campaign, type Lead } from "@/lib/api";
import { GATE_RESULT_UZ } from "@/lib/labels";

function fmt(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("uz-UZ", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default function LeadsPage() {
  const scope = useRef<HTMLDivElement>(null);
  usePanelEntrance(scope);

  const [leads, setLeads] = useState<Lead[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getLeads(), getCampaigns()])
      .then(([l, c]) => {
        if (cancelled) return;
        setLeads(l);
        setCampaigns(c);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Lidlarni yuklab bo'lmadi.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const campaignName = (id: string) => campaigns.find((c) => c.id === id)?.name ?? id;

  async function download() {
    setExporting(true);
    try {
      await exportLeadsCsv();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Eksport qilib bo'lmadi.");
    } finally {
      setExporting(false);
    }
  }

  const opened = leads.filter((l) => l.link_clicked_at).length;
  const pending = leads.filter((l) => l.gate_result === "pending").length;

  return (
    <Shell
      title="Lidlar"
      crumb="oqimni oxirigacha bosib o'tganlar"
      actions={
        <button className="btn btn-primary" type="button" onClick={download} disabled={exporting}>
          <Icon name="download" size={16} />
          {exporting ? "Tayyorlanmoqda…" : "CSV yuklab olish"}
        </button>
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

        <div className="grid sm:grid-cols-3 gap-4">
          <Bay label="Jami lid">
            <p className="display text-d-3" style={{ color: "var(--c-signal)" }}>
              {loading ? "…" : leads.length}
            </p>
          </Bay>
          <Bay label="Havolani ochganlar">
            <p className="display text-d-3">{loading ? "…" : opened}</p>
            <p className="util text-paper/50 mt-1">
              {leads.length > 0 ? `${Math.round((opened / leads.length) * 100)}% · jami lidlardan` : "—"}
            </p>
          </Bay>
          <Bay label="Shart kutayotganlar">
            <p className="display text-d-3" style={{ color: "var(--c-saffron)" }}>
              {loading ? "…" : pending}
            </p>
          </Bay>
        </div>

        <Bay paper label="Ro'yxat" right={<span className="util text-ink-soft">yangi → eski</span>}>
          {leads.length === 0 ? (
            <p className="text-ink-soft text-[15px] py-6 text-center">
              {loading ? "Yuklanmoqda…" : "Hali lid yo'q."}
            </p>
          ) : (
            <Table head={["Foydalanuvchi", "Kampaniya", "Shart", "Boshlangan", "Havola ochilgan"]}>
              {leads.map((l) => (
                <tr key={l.id}>
                  <Td>{l.ig_username ? `@${l.ig_username}` : l.ig_user_id}</Td>
                  <Td className="max-w-[200px] truncate">{campaignName(l.campaign_id)}</Td>
                  <Td>
                    <StatusPill state={l.gate_result} label={GATE_RESULT_UZ[l.gate_result]} />
                  </Td>
                  <Td mono>{fmt(l.first_triggered_at)}</Td>
                  <Td mono>{fmt(l.link_clicked_at)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Bay>

        <Bay label="Ma'lumot saqlash">
          <p className="text-b-0 measure text-paper/85">
            Faqat oqim uchun kerak bo'lgan ma'lumot saqlanadi: username,
            Instagram identifikatori, kampaniya va vaqt. Odam so'rasa,
            yozuvini o'chirib berasiz.
          </p>
        </Bay>
      </div>
    </Shell>
  );
}
