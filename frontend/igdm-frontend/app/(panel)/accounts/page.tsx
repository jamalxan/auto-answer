"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Shell from "@/components/panel/Shell";
import { Bay, Empty, StatusPill } from "@/components/ui/Kit";
import Icon from "@/components/ui/Icon";
import { usePanelEntrance } from "@/components/motion/useActs";
import { ApiError, connectAccount, disconnectAccount, getAccounts, type Account } from "@/lib/api";

const META_APP_ID = process.env.NEXT_PUBLIC_META_APP_ID;
const META_OAUTH_REDIRECT_URI = process.env.NEXT_PUBLIC_META_OAUTH_REDIRECT_URI;

function startConnect(setNote: (s: string) => void) {
  if (!META_APP_ID || !META_OAUTH_REDIRECT_URI) {
    setNote(
      "Meta App hali sozlanmagan (NEXT_PUBLIC_META_APP_ID / NEXT_PUBLIC_META_OAUTH_REDIRECT_URI). Avval Meta Developer App yarating."
    );
    return;
  }
  const url = new URL("https://www.instagram.com/oauth/authorize");
  url.searchParams.set("client_id", META_APP_ID);
  url.searchParams.set("redirect_uri", META_OAUTH_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "instagram_business_basic,instagram_business_manage_comments,instagram_business_manage_messages");
  window.location.href = url.toString();
}

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("uz-UZ", { day: "2-digit", month: "long", year: "numeric" });
}

export default function AccountsPage() {
  return (
    <Suspense fallback={null}>
      <AccountsPageInner />
    </Suspense>
  );
}

function AccountsPageInner() {
  const scope = useRef<HTMLDivElement>(null);
  usePanelEntrance(scope);
  const router = useRouter();
  const searchParams = useSearchParams();

  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  function load() {
    getAccounts()
      .then(setAccounts)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Akkountlarni yuklab bo'lmadi."));
  }

  useEffect(load, []);

  // Instagram lands back here with either `code` (success) or `error*`
  // (user declined / Meta-side failure) after the OAuth redirect.
  useEffect(() => {
    const code = searchParams.get("code");
    const oauthError = searchParams.get("error_description") || searchParams.get("error");
    if (!code && !oauthError) return;

    router.replace("/accounts");

    if (oauthError) {
      setError(oauthError);
      return;
    }
    if (code) {
      setConnecting(true);
      connectAccount(code)
        .then(() => {
          setNote("Akkount muvaffaqiyatli ulandi.");
          load();
        })
        .catch((err) => setError(err instanceof ApiError ? err.message : "Akkountni ulab bo'lmadi."))
        .finally(() => setConnecting(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  async function disconnect(a: Account) {
    if (!confirm(`@${a.ig_username} akkountini uzasizmi? Barcha kampaniyalar to'xtaydi.`)) return;
    setBusyId(a.id);
    try {
      await disconnectAccount(a.id);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Uzib bo'lmadi.");
    } finally {
      setBusyId(null);
    }
  }

  const primary = accounts?.[0];
  const secondary = accounts?.[1];
  const tokenDaysLeft = primary?.token_expires_at
    ? Math.max(0, Math.ceil((new Date(primary.token_expires_at).getTime() - Date.now()) / 86400000))
    : null;

  return (
    <Shell
      title="Akkountlar"
      crumb="Instagram ulanishi va ruxsatlar"
      actions={
        <button className="btn btn-primary" type="button" onClick={() => startConnect(setNote)}>
          <Icon name="jack" size={16} />
          Akkount ulash
        </button>
      }
    >
      <div ref={scope} className="grid lg:grid-cols-[1.3fr_1fr] gap-4 items-start">
        {error && (
          <p
            className="lg:col-span-2 util px-4 py-3 rounded-bay"
            style={{ background: "var(--c-madder)", color: "var(--c-paper)" }}
          >
            {error}
          </p>
        )}
        {note && (
          <p
            className="lg:col-span-2 util px-4 py-3 rounded-bay"
            style={{ background: "var(--c-saffron)", color: "var(--c-field-deep)" }}
          >
            {note}
          </p>
        )}
        {connecting && (
          <p
            className="lg:col-span-2 util px-4 py-3 rounded-bay"
            style={{ background: "var(--c-line)", color: "var(--c-paper)" }}
          >
            Akkount ulanmoqda…
          </p>
        )}

        {accounts === null ? (
          <Bay paper label="Ulangan akkount">
            <p className="text-ink-soft text-[15px]">Yuklanmoqda…</p>
          </Bay>
        ) : !primary ? (
          <Bay paper label="Ulangan akkount">
            <Empty
              title="Hali akkount ulanmagan"
              body="Instagram Business akkountingizni ulash uchun tugmani bosing."
              action={
                <button className="btn btn-ghost" type="button" onClick={() => startConnect(setNote)}>
                  Akkount ulash
                </button>
              }
            />
          </Bay>
        ) : (
          <Bay
            paper
            label="Ulangan akkount"
            right={
              <StatusPill
                state={primary.status === "active" ? "active" : "paused"}
                label={primary.status === "active" ? "ishlayapti" : primary.status}
              />
            }
          >
            <div className="flex items-center gap-4">
              <span
                className="w-14 h-14 rounded-jack shrink-0"
                style={{ background: "var(--c-madder)" }}
                aria-hidden
              />
              <div className="min-w-0">
                <p className="font-display text-b-1">@{primary.ig_username}</p>
                <p className="util text-ink-soft mt-0.5">{fmtDate(primary.connected_at)}dan beri ulangan</p>
              </div>
            </div>

            <dl className="mt-6 grid sm:grid-cols-2 gap-4">
              <div>
                <dt className="util text-ink-soft">Token muddati</dt>
                <dd className="text-b-0">
                  {fmtDate(primary.token_expires_at)}
                  {tokenDaysLeft !== null && ` · ${tokenDaysLeft} kun qoldi`}
                </dd>
                <p className="text-[13px] text-ink-soft mt-0.5">
                  Muddat tugashiga 7 kun qolganda o'zi yangilanadi.
                </p>
              </div>
              <div>
                <dt className="util text-ink-soft">Webhook obunasi</dt>
                <dd className="text-b-0">{primary.webhook_subscribed ? "faol" : "ulanmagan"}</dd>
              </div>
            </dl>

            <div className="mt-6 flex flex-wrap gap-3">
              <button
                className="btn btn-danger"
                type="button"
                disabled={busyId === primary.id}
                onClick={() => disconnect(primary)}
              >
                <Icon name="power" size={14} />
                {busyId === primary.id ? "Uzilmoqda…" : "Uzish"}
              </button>
            </div>
            <p className="text-[13px] text-ink-soft mt-2">
              Uzsangiz barcha kampaniyalar to'xtaydi va webhook obunasi olib
              tashlanadi. Jurnal joyida qoladi.
            </p>
          </Bay>
        )}

        <div className="space-y-4">
          <Bay label="Ikkinchi akkount">
            {secondary ? (
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-display text-b-1">@{secondary.ig_username}</p>
                  <StatusPill
                    state={secondary.status === "active" ? "active" : "paused"}
                    label={secondary.status === "active" ? "ishlayapti" : secondary.status}
                  />
                </div>
                <button
                  className="btn btn-ghost"
                  type="button"
                  disabled={busyId === secondary.id}
                  onClick={() => disconnect(secondary)}
                >
                  Uzish
                </button>
              </div>
            ) : (
              <Empty
                title="Bo'sh"
                body="Yana bir Instagram Business akkountini ulasangiz, kampaniyalar alohida yuritiladi."
                action={
                  <button className="btn btn-ghost" type="button" onClick={() => startConnect(setNote)}>
                    Akkount ulash
                  </button>
                }
              />
            )}
          </Bay>

          <Bay label="Nima kerak" index="01">
            <ol className="space-y-3 text-[15px] text-paper/85">
              <li>
                <span className="util text-saffron block">qadam 01</span>
                Instagram akkounti Business yoki Creator turida bo'lsin.
              </li>
              <li>
                <span className="util text-saffron block">qadam 02</span>
                U Facebook sahifasiga bog'langan bo'lsin.
              </li>
              <li>
                <span className="util text-saffron block">qadam 03</span>
                Ulash oynasida izoh va xabar ruxsatlarini tasdiqlang.
              </li>
            </ol>
          </Bay>
        </div>
      </div>
    </Shell>
  );
}
