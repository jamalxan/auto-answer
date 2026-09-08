"use client";

import { useLanguage } from "@/components/language-provider";

export interface AccountOption {
  id: string;
  username: string;
  instagramId: string;
  name?: string | null;
}

interface AccountSelectProps {
  accounts: AccountOption[];
  value: string;
  onChange: (value: string) => void;
  includeAll?: boolean;
  label?: string;
}

export default function AccountSelect({
  accounts,
  value,
  onChange,
  includeAll = true,
  label,
}: AccountSelectProps) {
  const { t } = useLanguage();
  return (
    <label className="flex flex-col gap-2 text-sm">
      <span className="label-mono text-[11px] font-semibold text-muted">
        {label ?? t.common.instagramAccountLabel}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-52 rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40"
      >
        {includeAll && <option value="all">{t.common.allAccounts}</option>}
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            @{account.username}
          </option>
        ))}
      </select>
    </label>
  );
}
