"use client";

/**
 * Import Campaigns Page
 *
 * Paste a CSV of everything except the post. Each row is queued and opened in
 * the campaign builder prefilled and editable, one at a time, so you review
 * each campaign and pick its reel before saving.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AccountSelect, { type AccountOption } from "@/components/account-select";
import { parseCsv } from "@/lib/utils/csv";
import { IMPORT_QUEUE_KEY, IMPORT_ACCOUNT_KEY } from "@/lib/import-queue";
import { useLanguage } from "@/components/language-provider";
import { PageHeader } from "@/components/ui/page";

const SAMPLE = `keywords,dm_message,public_reply,tracked_url,opening_dm,opening_dm_button
"yc","here it is: {link}","sent. check dms","https://events.ycombinator.com/startup-school-2026","hey! click below for the referral","send link"
"LINK,SHOP","grab it here: {link}","dmed u",,,`;

/** Column name inside the description: lime emphasis, same face as the text. */
function Col({ children }: { children: string }) {
  return <code className="font-sans font-semibold text-lime">{children}</code>;
}

export default function ImportCampaignsPage() {
  const router = useRouter();
  const { t } = useLanguage();
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [csv, setCsv] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/dashboard/stats")
      .then((res) => res.json())
      .then((payload) => {
        if (payload.success) {
          const next = payload.data.instagramAccounts ?? [];
          setAccounts(next);
          setSelectedAccountId(next[0]?.id ?? "");
        }
      })
      .catch(() => setAccounts([]));
  }, []);

  function startImport() {
    setError(null);
    const parsed = parseCsv(csv);
    if (parsed.length === 0) {
      setError(t.campaignImport.errorEmptyCsv);
      return;
    }

    const rows = [];
    for (let i = 0; i < parsed.length; i++) {
      const r = parsed[i];
      const keywords = (r.keywords ?? "")
        .split(/[,;]/)
        .map((k) => k.trim())
        .filter(Boolean)
        .slice(0, 10);
      const dmMessage = (r.dm_message ?? r.message ?? "").trim();
      if (keywords.length === 0 || !dmMessage) {
        setError(t.campaignImport.errorRowMissing(i + 1));
        return;
      }
      rows.push({
        name: (r.name ?? "").trim(),
        keywords,
        dmMessage,
        publicReply: (r.public_reply ?? "").trim(),
        trackedUrl: (r.tracked_url ?? "").trim(),
        openingDmMessage: (r.opening_dm ?? "").trim(),
        openingDmButtonLabel: (r.opening_dm_button ?? "").trim(),
      });
    }

    try {
      window.localStorage.setItem(IMPORT_QUEUE_KEY, JSON.stringify(rows));
      if (selectedAccountId) {
        window.localStorage.setItem(IMPORT_ACCOUNT_KEY, selectedAccountId);
      }
    } catch {
      setError(t.campaignImport.errorStagingFailed);
      return;
    }
    router.push("/campaigns/new");
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* The top bar shows the page title; only the description lives here. */}
      <PageHeader
        description={
          <>
            {t.campaignImport.description}{" "}
            {t.campaignImport.requiredColumnsLabel} <Col>keywords</Col>,{" "}
            <Col>dm_message</Col>. {t.campaignImport.optionalColumnsLabel}{" "}
            <Col>name</Col>, <Col>public_reply</Col>, <Col>tracked_url</Col>,{" "}
            <Col>opening_dm</Col>, <Col>opening_dm_button</Col>.{" "}
            {t.campaignImport.keywordsNote}
          </>
        }
      />

      {error && (
        <div className="rounded-2xl bg-error/12 p-4 text-sm leading-6 text-error">
          {error}
        </div>
      )}

      {accounts.length > 1 && (
        <AccountSelect
          accounts={accounts}
          value={selectedAccountId}
          onChange={setSelectedAccountId}
          includeAll={false}
          label={t.campaignImport.accountLabel}
        />
      )}

      <div className="space-y-2">
        <label className="block text-sm font-semibold text-white">
          {t.campaignImport.csvLabel}
        </label>
        <textarea
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          placeholder={SAMPLE}
          rows={10}
          className="input min-h-56 font-mono text-sm"
        />
        <button
          type="button"
          onClick={() => setCsv(SAMPLE)}
          className="text-xs font-semibold text-muted hover:text-white"
        >
          {t.campaignImport.fillSample}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button onClick={startImport} className="btn btn-lime">
          {t.campaignImport.reviewAndImport}
        </button>
        <button onClick={() => router.push("/campaigns")} className="btn btn-ghost">
          {t.campaignImport.cancel}
        </button>
      </div>
    </div>
  );
}
