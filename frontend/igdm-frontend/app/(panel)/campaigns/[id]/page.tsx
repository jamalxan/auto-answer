"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Shell from "@/components/panel/Shell";
import { Bay, Empty, Field, StatusPill, Toggle } from "@/components/ui/Kit";
import { ChatPreview } from "@/components/ui/Data";
import Icon from "@/components/ui/Icon";
import { usePanelEntrance } from "@/components/motion/useActs";
import {
  ApiError,
  createCampaign,
  deleteCampaign,
  getAccounts,
  getCampaign,
  getMedia,
  patchCampaign,
  testCampaign,
  type Account,
  type Campaign,
  type MediaItem,
  type MediaTarget,
  type Template,
  type TestResult,
} from "@/lib/api";
import { GATE_UZ, MATCH_UZ, STATUS_UZ } from "@/lib/labels";

const STEP_LABEL: Record<Template["step"], string> = {
  public_reply: "Ochiq javob — izoh ostida ko'rinadi",
  opening: "Birinchi direkt — izohga javoban",
  gate: "Shart xabari",
  reward: "Havola xabari",
  retry: "Shart bajarilmasa",
  decline: "Rad javobi",
};

const DEFAULT_STEPS: Template[] = [
  { step: "public_reply", body: "Yubordik! Direktni oching {username}", quick_replies: [], sort_order: 0 },
  {
    step: "opening",
    body: "Assalomu alaykum {username}! «{keyword}» deb yozdingiz — darslikni yuboraman.",
    quick_replies: [
      { label: "Ha, yuboring", payload: "YES" },
      { label: "Keyinroq", payload: "NO" },
    ],
    sort_order: 0,
  },
  {
    step: "gate",
    body: "Avval sahifamizga obuna bo'ling, keyin quyidagi tugmani bosing.",
    quick_replies: [{ label: "Obuna bo'ldim", payload: "SUBSCRIBED" }],
    sort_order: 0,
  },
  { step: "reward", body: "Rahmat! Mana havola: {link}", quick_replies: [], sort_order: 0 },
  {
    step: "retry",
    body: "Obunani hali ko'rmadik. Obuna bo'lib, tugmani yana bosing (3 tagacha).",
    quick_replies: [{ label: "Qayta tekshirish", payload: "SUBSCRIBED" }],
    sort_order: 0,
  },
  {
    step: "decline",
    body: "Yaxshi, bezovta qilmaymiz. Kerak bo'lsa yana «{keyword}» deb yozing.",
    quick_replies: [],
    sort_order: 0,
  },
];

function mergeSteps(existing: Template[]): Template[] {
  return DEFAULT_STEPS.map((def) => existing.find((t) => t.step === def.step) ?? def);
}

function splitList(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseUtm(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of s.split("&")) {
    const [k, v] = pair.split("=");
    if (k?.trim()) out[k.trim()] = (v ?? "").trim();
  }
  return out;
}

export default function CampaignEditor({ params }: { params: { id: string } }) {
  const scope = useRef<HTMLFormElement>(null);
  usePanelEntrance(scope);
  const router = useRouter();

  const isNew = params.id === "new";

  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [campaign, setCampaign] = useState<Campaign | null>(null);

  const [name, setName] = useState("");
  const [targetMode, setTargetMode] = useState<"specific" | "all">("specific");
  const [keywordsStr, setKeywordsStr] = useState("");
  const [negativeStr, setNegativeStr] = useState("");
  const [matchMode, setMatchMode] = useState<"exact" | "contains" | "word">("word");
  const [cyrillicNormalise, setCyrillicNormalise] = useState(true);
  const [replyEnabled, setReplyEnabled] = useState(true);
  const [gate, setGate] = useState("self_confirm");
  const [rewardLink, setRewardLink] = useState("");
  const [utmStr, setUtmStr] = useState("");
  const [cooldownHours, setCooldownHours] = useState("24");
  const [gateMaxRetries, setGateMaxRetries] = useState("3");
  const [steps, setSteps] = useState<Template[]>(DEFAULT_STEPS);

  const [mediaList, setMediaList] = useState<MediaItem[] | null>(null);
  const [mediaError, setMediaError] = useState("");
  const [selectedMedia, setSelectedMedia] = useState<MediaTarget[]>([]);
  const [mediaTouched, setMediaTouched] = useState(false);

  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setLoading(true);
      try {
        const accs = await getAccounts();
        if (cancelled) return;
        setAccounts(accs);

        if (!isNew) {
          const c = await getCampaign(params.id);
          if (cancelled) return;
          setCampaign(c);
          setName(c.name);
          setTargetMode(c.target_mode);
          setKeywordsStr(c.keywords.filter((k) => !k.is_negative).map((k) => k.keyword).join(", "));
          setNegativeStr(c.keywords.filter((k) => k.is_negative).map((k) => k.keyword).join(", "));
          setMatchMode(c.match_mode);
          setCyrillicNormalise(c.cyrillic_normalise);
          setReplyEnabled(c.reply_enabled);
          setGate(c.gate_strategy);
          setRewardLink(c.reward_link);
          setCooldownHours(String(c.cooldown_hours));
          setGateMaxRetries(String(c.gate_max_retries));
          setSteps(mergeSteps(c.templates));
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) setNotFound(true);
        else setError(err instanceof ApiError ? err.message : "Yuklab bo'lmadi.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  const accountId = isNew ? accounts[0]?.id : campaign?.account_id;

  useEffect(() => {
    if (targetMode !== "specific" || !accountId) {
      setMediaList(null);
      return;
    }
    let cancelled = false;
    getMedia(accountId)
      .then((items) => {
        if (!cancelled) setMediaList(items);
      })
      .catch((err) => {
        if (cancelled) return;
        setMediaList([]);
        setMediaError(err instanceof ApiError ? err.message : "Postlarni olib bo'lmadi.");
      });
    return () => {
      cancelled = true;
    };
  }, [targetMode, accountId]);

  function toggleMedia(item: MediaItem) {
    setMediaTouched(true);
    setSelectedMedia((cur) => {
      const exists = cur.some((m) => m.ig_media_id === item.ig_media_id);
      if (exists) return cur.filter((m) => m.ig_media_id !== item.ig_media_id);
      return [
        ...cur,
        {
          ig_media_id: item.ig_media_id,
          media_type: item.media_type,
          permalink: item.permalink,
          thumbnail_url: item.thumbnail_url,
        },
      ];
    });
  }

  const edit = (i: number, body: string) => setSteps((s) => s.map((x, k) => (k === i ? { ...x, body } : x)));

  async function save(e: React.SyntheticEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      const keywords = [
        ...splitList(keywordsStr).map((keyword) => ({ keyword, is_negative: false })),
        ...splitList(negativeStr).map((keyword) => ({ keyword, is_negative: true })),
      ];
      const templates = steps.map((s) => ({
        step: s.step,
        body: s.body,
        quick_replies: s.quick_replies,
        sort_order: s.sort_order,
      }));

      const payload: Record<string, unknown> = {
        name,
        target_mode: targetMode,
        reply_enabled: replyEnabled,
        match_mode: matchMode,
        cyrillic_normalise: cyrillicNormalise,
        gate_strategy: gate,
        reward_link: rewardLink,
        cooldown_hours: Number(cooldownHours) || 24,
        gate_max_retries: Number(gateMaxRetries) || 3,
        keywords,
        templates,
      };
      if (utmStr.trim()) payload.utm_params = parseUtm(utmStr);
      if (mediaTouched) payload.media_targets = selectedMedia;

      if (isNew) {
        if (!accounts[0]) {
          setError("Avval Instagram akkountini ulang.");
          return;
        }
        payload.account_id = accounts[0].id;
        const created = await createCampaign(payload);
        router.push(`/campaigns/${created.id}`);
        return;
      }

      const updated = await patchCampaign(params.id, payload);
      setCampaign(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Saqlab bo'lmadi.");
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    if (isNew) return;
    setError("");
    setTestBusy(true);
    setTestResult(null);
    try {
      const firstKeyword = splitList(keywordsStr)[0] || "tizim";
      const result = await testCampaign(params.id, {
        ig_user_id: "test_user",
        ig_username: "test_user",
        comment_text: firstKeyword,
      });
      setTestResult(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Test ishlamadi.");
    } finally {
      setTestBusy(false);
    }
  }

  async function remove() {
    if (isNew) return;
    if (!confirm("Kampaniyani o'chirasizmi? Bu amalni qaytarib bo'lmaydi.")) return;
    try {
      await deleteCampaign(params.id);
      router.push("/campaigns");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "O'chirib bo'lmadi.");
    }
  }

  if (notFound) {
    return (
      <Shell title="Topilmadi" crumb="kampaniya">
        <Bay paper label="Kampaniya topilmadi">
          <Empty
            title="Bunday kampaniya yo'q"
            body="O'chirilgan yoki noto'g'ri havola bo'lishi mumkin."
            action={
              <Link href="/campaigns" className="btn btn-ghost">
                Kampaniyalar ro'yxatiga qaytish
              </Link>
            }
          />
        </Bay>
      </Shell>
    );
  }

  if (loading) {
    return (
      <Shell title={isNew ? "Yangi kampaniya" : "Yuklanmoqda…"} crumb="sozlash">
        <p className="text-ink-soft text-[15px] py-6">Yuklanmoqda…</p>
      </Shell>
    );
  }

  if (isNew && !accounts[0]) {
    return (
      <Shell title="Yangi kampaniya" crumb="sozlash">
        <Bay paper label="Avval akkount ulang">
          <Empty
            title="Instagram akkounti ulanmagan"
            body="Kampaniya yaratishdan oldin kamida bitta Instagram Business akkountini ulashingiz kerak."
            action={
              <Link href="/accounts" className="btn btn-primary">
                Akkountlar sahifasiga o'tish
              </Link>
            }
          />
        </Bay>
      </Shell>
    );
  }

  return (
    <Shell
      title={isNew ? "Yangi kampaniya" : campaign?.name ?? ""}
      crumb={isNew ? "sozlash" : `kampaniya · ${STATUS_UZ[campaign?.status ?? "draft"]}`}
      actions={
        <>
          {!isNew && (
            <button className="btn btn-ghost" type="button" onClick={runTest} disabled={testBusy}>
              <Icon name="play" size={14} />
              {testBusy ? "Tekshirilmoqda…" : "Test qilish"}
            </button>
          )}
          <button className="btn btn-primary" type="button" onClick={save} disabled={saving}>
            {saving ? "Saqlanmoqda…" : "Saqlash"}
          </button>
        </>
      }
    >
      {error && (
        <p
          role="alert"
          className="util mb-4 px-4 py-3 rounded-bay"
          style={{ background: "var(--c-madder)", color: "var(--c-paper)" }}
        >
          {error}
        </p>
      )}
      {saved && (
        <p
          role="status"
          className="util mb-4 px-4 py-3 rounded-bay"
          style={{ background: "var(--c-signal)", color: "var(--c-field-deep)" }}
        >
          Saqlandi. O'zgarishlar keyingi izohdan boshlab ishlaydi.
        </p>
      )}
      {testResult && (
        <p
          role="status"
          className="util mb-4 px-4 py-3 rounded-bay space-y-1"
          style={{ background: "var(--c-field-lift)", color: "var(--c-paper)" }}
        >
          <span className="block">
            {testResult.matched ? `Mos keldi: "${testResult.matched_keyword}"` : `Mos kelmadi (${testResult.reason})`}
          </span>
          {testResult.matched && (
            <span className="block text-paper/70">
              {testResult.would_send_public_reply ? "Ochiq javob yozilardi. " : ""}
              Shart: {GATE_UZ[testResult.gate_strategy]?.split(" — ")[0] ?? testResult.gate_strategy}.{" "}
              {testResult.note}
            </span>
          )}
        </p>
      )}

      <form ref={scope} onSubmit={save} className="grid xl:grid-cols-[1fr_400px] gap-4 items-start">
        {/* ── settings column ── */}
        <div className="space-y-4">
          <Bay paper label="Nishon" index="01">
            <div className="grid sm:grid-cols-2 gap-4">
              <Field label="Kampaniya nomi" htmlFor="name" hint="Faqat siz ko'rasiz.">
                <input
                  id="name"
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Masalan: Reels — bepul darslik"
                  required
                />
              </Field>
              <Field
                label="Qaysi postlar"
                htmlFor="target"
                hint="Reelsni tanlasangiz, faqat o'sha ostidagi izohlar hisobga olinadi."
              >
                <select
                  id="target"
                  className="input"
                  value={targetMode}
                  onChange={(e) => setTargetMode(e.target.value as "specific" | "all")}
                >
                  <option value="specific">Tanlangan Reels/postlar</option>
                  <option value="all">Barcha postlar</option>
                </select>
              </Field>
            </div>

            {targetMode === "specific" && (
              <div className="mt-4">
                {!accountId ? (
                  <p className="text-[14px] text-ink-soft">Avval akkount ulang.</p>
                ) : mediaList === null ? (
                  <p className="text-[14px] text-ink-soft">Postlar yuklanmoqda…</p>
                ) : mediaList.length === 0 ? (
                  <p className="text-[14px] text-ink-soft">
                    {mediaError || "Hozircha post topilmadi."}
                  </p>
                ) : (
                  <>
                    <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                      {mediaList.map((m) => {
                        const on = selectedMedia.some((s) => s.ig_media_id === m.ig_media_id);
                        return (
                          <button
                            key={m.ig_media_id}
                            type="button"
                            onClick={() => toggleMedia(m)}
                            className="relative aspect-[4/5] rounded-bay overflow-hidden text-left bg-cover bg-center"
                            style={{
                              background: m.thumbnail_url
                                ? `var(--c-field) url(${m.thumbnail_url}) center/cover`
                                : "var(--c-field)",
                              outline: on ? "3px solid var(--c-signal)" : "1px solid rgba(22,22,46,.2)",
                            }}
                            aria-pressed={on}
                          >
                            {on && (
                              <span
                                className="util absolute top-1 left-1 px-1"
                                style={{ background: "var(--c-signal)", color: "var(--c-field-deep)" }}
                              >
                                tanlandi
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-[13px] text-ink-soft mt-2">
                      Avval tanlangan postlarni panel ko'rsata olmaydi — kerak bo'lsa qayta tanlang.
                    </p>
                  </>
                )}
              </div>
            )}
          </Bay>

          <Bay paper label="Kalit so'zlar" index="02">
            <div className="grid sm:grid-cols-2 gap-4">
              <Field label="Ishga tushiruvchi so'zlar" htmlFor="kw" hint="Vergul bilan ajrating. Katta-kichik harf farqi yo'q.">
                <input id="kw" className="input" value={keywordsStr} onChange={(e) => setKeywordsStr(e.target.value)} />
              </Field>
              <Field label="Istisno so'zlar" htmlFor="neg" hint="Bu so'zlar bo'lsa kampaniya ishga tushmaydi.">
                <input
                  id="neg"
                  className="input"
                  value={negativeStr}
                  onChange={(e) => setNegativeStr(e.target.value)}
                  placeholder="narx, qancha"
                />
              </Field>
            </div>
            <div className="grid sm:grid-cols-2 gap-4 mt-4">
              <Field label="Qanday moslashsin" htmlFor="mode">
                <select
                  id="mode"
                  className="input"
                  value={matchMode}
                  onChange={(e) => setMatchMode(e.target.value as "exact" | "contains" | "word")}
                >
                  {Object.entries(MATCH_UZ).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="space-y-3 pt-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="util text-ink-soft">Lotin va kirill bir xil</span>
                  <Toggle
                    id="cyr"
                    checked={cyrillicNormalise}
                    onClick={() => setCyrillicNormalise((v) => !v)}
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="util text-ink-soft">Ochiq javob yozilsin</span>
                  <Toggle id="reply" checked={replyEnabled} onClick={() => setReplyEnabled((v) => !v)} />
                </div>
              </div>
            </div>
          </Bay>

          <Bay paper label="Shart" index="03">
            <div className="space-y-2">
              {Object.entries(GATE_UZ).map(([k, v]) => (
                <label
                  key={k}
                  className="flex items-start gap-3 p-3 rounded-bay cursor-pointer"
                  style={{
                    border: gate === k ? "2px solid var(--c-field)" : "1px solid rgba(22,22,46,.18)",
                    background: gate === k ? "rgba(26,27,114,.06)" : "transparent",
                  }}
                >
                  <input
                    type="radio"
                    name="gate"
                    value={k}
                    checked={gate === k}
                    onChange={() => setGate(k)}
                    className="mt-1 w-5 h-5 accent-[var(--c-field)]"
                  />
                  <span>
                    <span className="block font-semibold">{v.split(" — ")[0]}</span>
                    <span className="block text-[14px] text-ink-soft">{v.split(" — ")[1]}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="text-[14px] text-ink-soft mt-3 measure">
              Instagram «bu odam obuna bo'lganmi?» degan savolga javob bermaydi —
              bunday so'rov API'da yo'q. Shuning uchun shart yo tasdiq tugmasi,
              yo sizning ro'yxatingiz orqali tekshiriladi.
            </p>
          </Bay>

          <Bay paper label="Xabarlar" index="04">
            <div className="space-y-4">
              {steps.map((s, i) => (
                <Field
                  key={s.step}
                  label={STEP_LABEL[s.step]}
                  htmlFor={`s-${s.step}`}
                  hint="O'ringa qo'yiladi: {username} · {link} · {keyword}"
                >
                  <textarea
                    id={`s-${s.step}`}
                    className="input min-h-[86px] resize-y"
                    value={s.body}
                    onChange={(e) => edit(i, e.target.value)}
                  />
                </Field>
              ))}
            </div>
          </Bay>

          <Bay paper label="Havola va cheklovlar" index="05">
            <div className="grid sm:grid-cols-2 gap-4">
              <Field label="Yuboriladigan havola" htmlFor="link">
                <input id="link" className="input" value={rewardLink} onChange={(e) => setRewardLink(e.target.value)} placeholder="https://" />
              </Field>
              <Field label="UTM belgilari" htmlFor="utm" hint="Havolaga avtomatik qo'shiladi. Bo'sh qoldirsangiz o'zgarmaydi.">
                <input
                  id="utm"
                  className="input"
                  value={utmStr}
                  onChange={(e) => setUtmStr(e.target.value)}
                  placeholder="utm_source=instagram&utm_medium=comment"
                />
              </Field>
              <Field label="Takror yuborish oralig'i (soat)" htmlFor="cd" hint="Shu vaqt ichida bir odam faqat bir marta javob oladi.">
                <input id="cd" type="number" min={1} className="input" value={cooldownHours} onChange={(e) => setCooldownHours(e.target.value)} />
              </Field>
              <Field label="Shartni necha marta qayta so'rasin" htmlFor="rt">
                <input id="rt" type="number" min={0} className="input" value={gateMaxRetries} onChange={(e) => setGateMaxRetries(e.target.value)} />
              </Field>
            </div>
          </Bay>
        </div>

        {/* ── preview column ── */}
        <div className="xl:sticky xl:top-28 space-y-4">
          <Bay label="Odam nimani ko'radi" right={<StatusPill state="active" label="jonli" />}>
            <ChatPreview steps={steps} compact />
            <p className="util text-paper/45 mt-3">matnni o'zgartirsangiz shu yerda darhol yangilanadi</p>
          </Bay>

          {!isNew && (
            <Bay label="Xavfli amallar">
              <button className="btn btn-danger w-full" type="button" onClick={remove}>
                Kampaniyani o'chirish
              </button>
              <p className="util text-paper/45 mt-2">jurnal va lidlar saqlanib qoladi</p>
            </Bay>
          )}
        </div>
      </form>
    </Shell>
  );
}
