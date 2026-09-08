/** Backend enum -> the word the person sees. One vocabulary everywhere. */
export const STATE_UZ: Record<string, string> = {
  completed: "havola yetdi",
  gate_pending: "shart kutilmoqda",
  declined: "rad etdi",
  failed: "yetmadi",
  opened: "boshlandi",
  awaiting_confirm: "tasdiq kutilmoqda",
  abandoned: "javobsiz",
  undeliverable: "direkt yopiq",
};

export const STATUS_UZ: Record<string, string> = {
  active: "faol",
  paused: "to'xtatilgan",
  draft: "qoralama",
  archived: "arxiv",
};

export const GATE_UZ: Record<string, string> = {
  none: "Shartsiz — havola darhol ketadi",
  self_confirm: "O'zi tasdiqlaydi — «Obuna bo'ldim» tugmasi",
  external_db: "Tashqi baza — sizning ro'yxatingizdan tekshiriladi",
  engagement: "Javob yozsin — direktga bitta xabar yozishi kifoya",
};

export const MATCH_UZ: Record<string, string> = {
  exact: "To'liq mos",
  contains: "Ichida bo'lsa",
  word: "Alohida so'z sifatida",
};

/** CommentEvent.match_result — nega izoh e'tiborga olinmadi yoki olindi. */
export const MATCH_RESULT_UZ: Record<string, string> = {
  matched: "mos keldi",
  no_match: "mos kelmadi",
  self_comment: "o'z izohi",
  spam_guard: "spam filtri",
  duplicate: "takroriy",
  cooldown: "kutish davri",
};

/** CommentEvent.public_reply_status */
export const REPLY_STATUS_UZ: Record<string, string> = {
  pending: "navbatda",
  sent: "yuborildi",
  failed: "yetmadi",
  disabled: "o'chirilgan",
  skipped: "o'tkazib yuborildi",
};

/** Lead.gate_result */
export const GATE_RESULT_UZ: Record<string, string> = {
  pass: "bajarildi",
  fail: "bajarilmadi",
  pending: "kutilmoqda",
  not_applicable: "shart yo'q",
};
