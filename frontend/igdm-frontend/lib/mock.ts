import type { Step } from "@/components/ui/Data";

/** Shapes mirror app/schemas/*.py in igdm-backend so swapping mock -> api
 *  is a one-line change in lib/api.ts. */

export const account = {
  id: "a1",
  ig_username: "everest_edu_uz",
  ig_user_id: "17841400000000001",
  status: "connected" as const,
  token_expires_at: "2026-10-04T09:00:00Z",
  webhook_fields: ["comments", "messages", "messaging_postbacks"],
  connected_at: "2026-06-02T11:20:00Z",
};

export const campaigns = [
  {
    id: "c1",
    name: "Reels — bepul darslik",
    status: "active",
    priority: 10,
    target_mode: "specific",
    media: "Reel · 12-avg",
    keywords: ["tizim", "тизим", "TIZIM"],
    negative: ["qancha", "narx"],
    match_mode: "word",
    gate_strategy: "self_confirm",
    reward_link: "https://kurs.uz/reels-funnel",
    cooldown_hours: 24,
    triggers_7d: [41, 66, 58, 92, 130, 108, 147],
    delivered: 512,
    failed: 7,
  },
  {
    id: "c2",
    name: "IELTS mock — ro'yxat",
    status: "paused",
    priority: 20,
    target_mode: "all",
    media: "Barcha postlar",
    keywords: ["mock", "ielts"],
    negative: [],
    match_mode: "contains",
    gate_strategy: "external_db",
    reward_link: "https://everest.uz/mock",
    cooldown_hours: 48,
    triggers_7d: [12, 9, 22, 18, 4, 0, 0],
    delivered: 96,
    failed: 1,
  },
  {
    id: "c3",
    name: "Qish chegirmasi",
    status: "draft",
    priority: 30,
    target_mode: "specific",
    media: "Reel · 02-avg",
    keywords: ["chegirma"],
    negative: [],
    match_mode: "exact",
    gate_strategy: "none",
    reward_link: "",
    cooldown_hours: 24,
    triggers_7d: [0, 0, 0, 0, 0, 0, 0],
    delivered: 0,
    failed: 0,
  },
];

export const steps: Step[] = [
  {
    step: "public_reply",
    body: "Yubordik! Direktni oching {username}",
  },
  {
    step: "opening",
    body: "Assalomu alaykum {username}! «{keyword}» deb yozdingiz — darslikni yuboraman.",
    quick_replies: [
      { label: "Ha, yuboring", payload: "YES" },
      { label: "Keyinroq", payload: "NO" },
    ],
  },
  {
    step: "gate",
    body: "Avval sahifamizga obuna bo'ling, keyin quyidagi tugmani bosing.",
    quick_replies: [{ label: "Obuna bo'ldim", payload: "SUBSCRIBED" }],
  },
  {
    step: "reward",
    body: "Rahmat! Mana havola: {link}",
  },
  {
    step: "retry",
    body: "Obunani hali ko'rmadik. Obuna bo'lib, tugmani yana bosing (3 tagacha).",
    quick_replies: [{ label: "Qayta tekshirish", payload: "SUBSCRIBED" }],
  },
  {
    step: "decline",
    body: "Yaxshi, bezovta qilmaymiz. Kerak bo'lsa yana «{keyword}» deb yozing.",
  },
];

export const events = [
  {
    id: "e1",
    at: "10:42:07",
    campaign: "Reels — bepul darslik",
    username: "dilnoza_s",
    text: "Tizimly",
    matched: "tizim",
    reply: "sent",
    state: "completed",
  },
  {
    id: "e2",
    at: "10:41:52",
    campaign: "Reels — bepul darslik",
    username: "asadbek.dev",
    text: "тизим 🔥🔥",
    matched: "тизим",
    reply: "sent",
    state: "gate_pending",
  },
  {
    id: "e3",
    at: "10:40:18",
    campaign: "—",
    username: "nodira_style",
    text: "narxi qancha?",
    matched: "—",
    reply: "skipped",
    state: "declined",
  },
  {
    id: "e4",
    at: "10:39:03",
    campaign: "Reels — bepul darslik",
    username: "javlon_777",
    text: "TIZIM",
    matched: "tizim",
    reply: "sent",
    state: "failed",
  },
  {
    id: "e5",
    at: "10:37:44",
    campaign: "IELTS mock — ro'yxat",
    username: "mohira.k",
    text: "mock kerak",
    matched: "mock",
    reply: "sent",
    state: "opened",
  },
];

export const leads = [
  { id: "l1", username: "dilnoza_s", campaign: "Reels — bepul darslik", gate: "passed", at: "12-avg 10:42", clicked: "10:43" },
  { id: "l2", username: "asadbek.dev", campaign: "Reels — bepul darslik", gate: "pending", at: "12-avg 10:41", clicked: "—" },
  { id: "l3", username: "mohira.k", campaign: "IELTS mock — ro'yxat", gate: "passed", at: "12-avg 10:37", clicked: "—" },
  { id: "l4", username: "javlon_777", campaign: "Reels — bepul darslik", gate: "passed", at: "12-avg 10:39", clicked: "10:40" },
];

export const stats = {
  triggers_today: 147,
  delivered_today: 131,
  failed_today: 7,
  median_reply_ms: 4200,
  queue_depth: 3,
  events_per_min: 22,
};
