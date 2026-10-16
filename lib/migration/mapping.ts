/**
 * ETAP 11 — pure mapping rules from ManyChat objects to SocialAuto ones:
 *
 *   tags          → CRM tag slugs (create / merge / skip)
 *   custom fields → contact.customFields.<key> (snake_case) + a flow variable kind
 *   bot fields    → flow variables (`vars.<key>`) with default values
 *   project state → the Uzbek checklist (done / todo) and the contact guidance
 *
 * No database, no model.
 */

import { tagSlug } from "@/lib/crm/defaults";
import { normalizeForMatch } from "@/lib/triggers/keywords";
import type { ManychatBotField, ManychatCustomField, ManychatTag } from "./manychat-types";

// ─── Tags ─────────────────────────────────────────────────────────────────────

/** "Hot Lead!" → "hot-lead" (same rule as the CRM); falls back to "teg". */
export function slugifyTag(name: string): string {
  return tagSlug(name) || "teg";
}

export type TagAction = "create" | "merge" | "skip";

export interface MappedTag {
  sourceId: string;
  name: string;
  targetSlug: string;
  action: TagAction;
}

/**
 * Existing slug (workspace) or an earlier ManyChat tag with the same slug →
 * "merge" (contacts of both end up under one tag); a name without letters or
 * digits → "skip"; otherwise "create".
 */
export function mapTags(manychatTags: readonly ManychatTag[], existingSlugs: Iterable<string>): MappedTag[] {
  const known = new Set(existingSlugs);
  const seenInBatch = new Set<string>();
  return manychatTags.map((tag) => {
    const slug = tagSlug(tag.name);
    if (!slug) return { sourceId: tag.id, name: tag.name, targetSlug: "", action: "skip" as const };
    const merge = known.has(slug) || seenInBatch.has(slug);
    seenInBatch.add(slug);
    return { sourceId: tag.id, name: tag.name, targetSlug: slug, action: merge ? ("merge" as const) : ("create" as const) };
  });
}

// ─── Keys ─────────────────────────────────────────────────────────────────────

export const VAR_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/** "Telefon raqami" / "Номер телефона" / "3rd-party ID" → a valid flow variable key. */
export function toVariableKey(name: string, fallback = "field"): string {
  let key = normalizeForMatch(name)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!key) key = fallback;
  if (!/^[a-z]/.test(key)) key = `f_${key}`;
  return key.slice(0, 32).replace(/_+$/g, "") || fallback;
}

/** Adds `_2`, `_3`... until the key is free; records it in `taken`. */
export function uniqueKey(base: string, taken: Set<string>): string {
  let key = base;
  for (let n = 2; taken.has(key); n += 1) {
    const suffix = `_${n}`;
    key = `${base.slice(0, 32 - suffix.length)}${suffix}`;
  }
  taken.add(key);
  return key;
}

// ─── Custom fields ────────────────────────────────────────────────────────────

export type MappedFieldType = "string" | "number" | "boolean" | "date" | "list";

export interface MappedCustomField {
  key: string;
  type: MappedFieldType;
  note: string;
}

const FIELD_TYPE: Record<string, MappedFieldType> = {
  text: "string",
  string: "string",
  number: "number",
  numeric: "number",
  boolean: "boolean",
  bool: "boolean",
  date: "date",
  datetime: "date",
  array: "list",
  multiselect: "list",
};

export function fieldTypeOf(manychatType: string): MappedFieldType {
  return FIELD_TYPE[manychatType.trim().toLowerCase()] ?? "string";
}

/** Flow variable kinds only know string / number / boolean (+ phone / email); dates and lists are strings. */
export function flowVarKind(type: MappedFieldType): "string" | "number" | "boolean" {
  return type === "number" ? "number" : type === "boolean" ? "boolean" : "string";
}

export function mapCustomField(field: Pick<ManychatCustomField, "name" | "type">): MappedCustomField {
  const type = fieldTypeOf(field.type);
  const key = toVariableKey(field.name);
  const note =
    type === "date"
      ? "Sana matn sifatida saqlanadi (ISO yoki kiritilgan ko'rinishda)"
      : type === "list"
        ? "Ro'yxat vergul bilan ajratilgan matn bo'ladi"
        : type === "boolean"
          ? "Ha / yo'q qiymati"
          : type === "number"
            ? "Son qiymati"
            : "Matn qiymati";
  return { key, type, note };
}

export interface MappedCustomFieldWithSource extends MappedCustomField {
  sourceId: string;
  name: string;
}

/** Whole list, collision-free (`phone`, `phone_2`...); `reserved` keys (e.g. bot fields) are avoided. */
export function mapCustomFields(fields: readonly ManychatCustomField[], reserved: Iterable<string> = []): MappedCustomFieldWithSource[] {
  const taken = new Set(reserved);
  return fields.map((field) => {
    const mapped = mapCustomField(field);
    return { ...mapped, key: uniqueKey(mapped.key, taken), sourceId: field.id, name: field.name };
  });
}

// ─── Bot fields ───────────────────────────────────────────────────────────────

export interface MappedBotField {
  varKey: string;
  value: string;
  sourceId: string;
  name: string;
  /** False when ManyChat returned no value (the variable is declared but has no default). */
  hasValue: boolean;
}

export const MAX_BOT_VALUE = 500;

/** Bot (global) fields → flow variables with their values; keys unique and valid. */
export function mapBotFields(fields: readonly ManychatBotField[], reserved: Iterable<string> = []): MappedBotField[] {
  const taken = new Set(reserved);
  return fields.map((field) => {
    const base = toVariableKey(field.name, "bot_field");
    const value = (field.value ?? "").replace(/[{}]/g, "").trim().slice(0, MAX_BOT_VALUE);
    return { varKey: uniqueKey(base, taken), value, sourceId: field.id, name: field.name, hasValue: value.length > 0 };
  });
}

// ─── Checklist ────────────────────────────────────────────────────────────────

export interface ChecklistItem {
  kind: string;
  status: string;
}

export interface ChecklistInput {
  instagramAccountId?: string | null;
  items: readonly ChecklistItem[];
}

export interface Checklist {
  done: string[];
  todo: string[];
}

/** Uzbek explanation of why contacts are not copied and how they come back. */
export const CONTACT_MIGRATION_GUIDANCE = [
  "ManyChat obunachilari ko'chirilmaydi: Instagram kontakti faqat o'zi yozganda yoki trigger orqali yangidan «rozilik» berganda ro'yxatga tushadi.",
  "Mijozlarni qaytarish yo'llari: (1) profil / reklama / QR uchun ig.me/<akkaunt>?ref=<kod> havolasi — bosganda Direct trigger ishga tushadi; (2) postlarga kalit so'zli Comment 2.0 trigger; (3) Story mention va Story javob; (4) Instagram profilidagi tugma va bio havola.",
  "Meta qoidasi: mijozga faqat u yozganidan keyin 24 soat ichida xabar yuborish mumkin — eski ro'yxatga ommaviy xabar yuborib bo'lmaydi.",
  "Eski ManyChat avtomatizatsiyalarini yangi oqimlar sinovdan o'tib, ishga tushgandan keyingina o'chiring — aks holda mijoz ikki marta javob oladi.",
].join("\n");

const count = (items: readonly ChecklistItem[], kind: string, statuses: readonly string[]) =>
  items.filter((item) => item.kind === kind && statuses.includes(item.status)).length;

export function buildChecklist(project: ChecklistInput): Checklist {
  const { items } = project;
  const done: string[] = ["ManyChat API kaliti ulandi va tahlil qilindi"];
  const todo: string[] = [];

  const tagsDone = count(items, "TAG", ["IMPORTED"]);
  const tagsOpen = count(items, "TAG", ["PENDING", "MAPPED"]);
  if (tagsDone) done.push(`${tagsDone} ta teg CRM'ga import qilindi`);
  if (tagsOpen) todo.push(`${tagsOpen} ta tegni ko'rib chiqing va CRM'ga import qiling («Asosiy ma'lumotlar»)`);

  const cfDone = count(items, "CUSTOM_FIELD", ["IMPORTED"]);
  const cfOpen = count(items, "CUSTOM_FIELD", ["PENDING", "MAPPED"]);
  if (cfDone) done.push(`${cfDone} ta maxsus maydon contact.customFields kalitlariga moslandi`);
  if (cfOpen) todo.push(`${cfOpen} ta maxsus maydon kalitini tasdiqlang («Asosiy ma'lumotlar»)`);

  const bfDone = count(items, "BOT_FIELD", ["IMPORTED"]);
  const bfOpen = count(items, "BOT_FIELD", ["PENDING", "MAPPED"]);
  if (bfDone) done.push(`${bfDone} ta bot maydoni oqim o'zgaruvchisi sifatida saqlandi`);
  if (bfOpen) todo.push(`${bfOpen} ta bot maydonini o'zgaruvchi sifatida import qiling («Asosiy ma'lumotlar»)`);

  const flowsNeedText = count(items, "FLOW", ["PENDING"]);
  const flowsNeedConvert = count(items, "FLOW", ["MAPPED"]);
  const flowsNeedImport = count(items, "FLOW", ["CONVERTED"]);
  const flowsImported = count(items, "FLOW", ["IMPORTED"]);
  const flowsFailed = count(items, "FLOW", ["FAILED"]);
  if (flowsImported) done.push(`${flowsImported} ta oqim qoralama (DRAFT) sifatida import qilindi`);
  if (flowsNeedText) todo.push(`${flowsNeedText} ta oqim uchun ManyChat'dagi qadamlar matnini kiriting yoki skrinshot yuklang (ManyChat oqim mazmunini API orqali bermaydi)`);
  if (flowsNeedConvert) todo.push(`${flowsNeedConvert} ta oqimni AI bilan konvertatsiya qiling va natijani ko'rib chiqing`);
  if (flowsNeedImport) todo.push(`${flowsNeedImport} ta konvertatsiya qilingan oqimni qoralama sifatida import qiling`);
  if (flowsFailed) todo.push(`${flowsFailed} ta oqim xato bilan to'xtadi — matnni tekshirib qayta urinib ko'ring`);
  if (flowsImported) todo.push("Import qilingan oqimlarni Oqimlar bo'limida Test konsolida sinang, ogohlantirishlarni ko'rib chiqing va nashr qiling (AI oqimlari tasdiqlashni talab qiladi)");

  const tools = count(items, "GROWTH_TOOL", ["PENDING", "MAPPED", "UNSUPPORTED", "CONVERTED"]);
  if (tools) todo.push(`${tools} ta Growth Tool ni qo'lda qayta yarating: komment → Comment 2.0, ref havola / reklama / QR → Direct trigger, story → Story mention yoki Story Reply (ManyChat qoidalarni API orqali bermaydi)`);

  if (!project.instagramAccountId) todo.push("Instagram akkauntni ulang va migratsiya loyihasi uchun tanlang");
  todo.push("Kontaktlarni qayta obuna qiling: ig.me?ref= havolasi va komment / story triggerlari orqali (obunachilar ko'chirilmaydi)");
  todo.push("24 soatlik xabar oynasini tekshiring: eski ro'yxatga ommaviy xabar yuborib bo'lmaydi");
  todo.push("ManyChat avtomatizatsiyalarini yangi oqimlar ishga tushib, sinovdan o'tgandan keyingina o'chiring");

  return { done, todo };
}
