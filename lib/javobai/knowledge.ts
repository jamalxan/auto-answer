/**
 * The knowledge base block (TZ 20): everything the agent may state as fact,
 * one line per fact, each with an id the model cites back in `used_facts`:
 *
 *   B#  profile facts (company, address, hours, delivery, payment)
 *   P#  products — the 15 most relevant to the customer's words
 *       (retrieval.ts: transliteration-aware, stems, fuzzy; the rest in
 *       catalog order, so ids are stable within a turn and its retries)
 *   F#  FAQs — the 20 most relevant the same way
 *   K#  verified, active AiKnowledgeEntry rows (discounts, contacts, terms…)
 *
 * Capped at MAX_KB_CHARS (TZ 66; 4000 once the soft budget is exceeded,
 * routing.ts): lines are added in that order until the cap, so profile facts
 * and the best products always make it. The same loader feeds the prompt and
 * the dev UI's "what the AI sees" preview.
 */

import { prisma } from "@/lib/db/client";
import { formatPrice } from "@/lib/assistant/price";
import { findProfile, toSnapshot } from "@/lib/assistant/profile";
import type { PricePolicyValue, ProductSnapshot, ProfileSnapshot } from "@/lib/assistant/prompt";
import type { FilterContext } from "@/lib/assistant/post-filter";
import { selectFaqsV2, selectProductsV2 } from "./retrieval";

export const MAX_KB_CHARS = 6000;
export const MAX_KB_PRODUCTS = 15;
export const MAX_KB_FAQS = 20;

export type KbLineKind = "profile" | "product" | "faq" | "entry";

export interface KbLine {
  id: string;
  kind: KbLineKind;
  text: string;
}

export interface KnowledgeEntrySnapshot {
  kind: string;
  title: string;
  body: string;
}

export interface KnowledgeBlock {
  profile: ProfileSnapshot;
  entries: KnowledgeEntrySnapshot[];
  lines: KbLine[];
  /** The lines rendered for the prompt ("P3: ..."). */
  text: string;
  chars: number;
  truncated: boolean;
  /** What the post-filter checks the reply against (all prices, owner URLs). */
  filterContext: FilterContext;
}

/**
 * Products relevant to the customer's words, best `limit` (4.2: thin alias of
 * `selectProductsV2` — "Нархи дивана" finds "Divan Milan", "devan" too).
 */
export function selectKbProducts(
  products: ProductSnapshot[],
  customerText: string,
  limit = MAX_KB_PRODUCTS
): ProductSnapshot[] {
  return selectProductsV2(customerText, products, limit);
}

function productText(product: ProductSnapshot, policy: PricePolicyValue): string {
  const parts = [product.name];
  if (product.note) parts.push(`(${product.note})`);
  if (policy !== "NEVER" && product.price !== null) {
    parts.push(
      `— ${formatPrice(product.price, product.currency, product.priceIsFrom || policy === "FROM_ONLY")}${
        product.unit ? ` / ${product.unit}` : ""
      }`
    );
  } else if (policy !== "NEVER") {
    parts.push("— narxi kiritilmagan (menejer aytadi)");
  }
  return parts.join(" ");
}

const ENTRY_KIND_LABEL: Record<string, string> = {
  DISCOUNT: "Chegirma",
  CONTACT: "Kontakt",
  TERMS: "Shartlar",
  BRANCH: "Filial",
  POLICY: "Qoida",
  OTHER: "Ma'lumot",
};

/** Pure assembly of the block from a snapshot and the verified entries. */
export function buildKnowledgeBlock(
  profile: ProfileSnapshot,
  entries: KnowledgeEntrySnapshot[],
  customerText = "",
  maxChars = MAX_KB_CHARS
): KnowledgeBlock {
  const candidates: KbLine[] = [];
  let b = 0;
  const fact = (text: string) => candidates.push({ id: `B${++b}`, kind: "profile", text });
  fact(`Kompaniya: ${profile.companyName}`);
  if (profile.description) fact(`Faoliyat: ${profile.description}`);
  if (profile.categories.length) {
    fact(`Kategoriyalar: ${profile.categories.map((c) => `${c.name}${c.note ? ` (${c.note})` : ""}`).join("; ")}`);
  }
  if (profile.address) fact(`Manzil: ${profile.address}`);
  if (profile.workingHours) fact(`Ish vaqti: ${profile.workingHours}`);
  if (profile.delivery) fact(`Yetkazib berish: ${profile.delivery}`);
  if (profile.paymentMethods.length) fact(`To'lov: ${profile.paymentMethods.join(", ")}`);

  selectProductsV2(customerText, profile.products, MAX_KB_PRODUCTS).forEach((p, i) =>
    candidates.push({ id: `P${i + 1}`, kind: "product", text: productText(p, profile.pricePolicy) })
  );
  selectFaqsV2(customerText, profile.faqs, MAX_KB_FAQS).forEach((f, i) =>
    candidates.push({ id: `F${i + 1}`, kind: "faq", text: `S: ${f.question} J: ${f.answer}` })
  );
  entries.forEach((e, i) =>
    candidates.push({
      id: `K${i + 1}`,
      kind: "entry",
      text: `${ENTRY_KIND_LABEL[e.kind] ?? e.kind} — ${e.title}: ${e.body}`,
    })
  );

  const lines: KbLine[] = [];
  let chars = 0;
  let truncated = false;
  for (const line of candidates) {
    const rendered = `${line.id}: ${line.text.replace(/\s+/g, " ").trim()}`;
    if (chars + rendered.length + 1 > maxChars) {
      truncated = true;
      continue;
    }
    lines.push({ ...line, text: rendered.slice(line.id.length + 2) });
    chars += rendered.length + 1;
  }

  return {
    profile,
    entries,
    lines,
    text: lines.map((l) => `${l.id}: ${l.text}`).join("\n"),
    chars,
    truncated,
    filterContext: {
      pricePolicy: profile.pricePolicy,
      knownPrices: profile.products
        .filter((p) => p.price !== null)
        .map((p) => ({ amount: p.price as number, currency: p.currency })),
      // Owner-written text: URLs in it are allowed in replies (entries included).
      profileText: [
        profile.description,
        profile.address ?? "",
        profile.delivery ?? "",
        ...profile.faqs.map((f) => `${f.question} ${f.answer}`),
        ...entries.map((e) => `${e.title} ${e.body}`),
      ].join(" "),
    },
  };
}

/** Active + verified entries of a profile, in display order. */
export async function loadKnowledgeEntries(profileId: string): Promise<KnowledgeEntrySnapshot[]> {
  const rows = await prisma.aiKnowledgeEntry.findMany({
    where: { profileId, active: true, verifiedAt: { not: null } },
    orderBy: [{ sort: "asc" }, { createdAt: "asc" }],
    select: { kind: true, title: true, body: true },
  });
  return rows.map((r) => ({ kind: r.kind, title: r.title, body: r.body }));
}

/**
 * The block for one profile id (what the prompt and the preview use). Null
 * when the profile is gone. `maxChars` is the per-turn cap (routing.ts).
 */
export async function loadKnowledgeBlock(profileId: string, customerText = "", maxChars = MAX_KB_CHARS): Promise<KnowledgeBlock | null> {
  const profile = await prisma.assistantProfile.findUnique({
    where: { id: profileId },
    include: { products: { orderBy: { sort: "asc" } }, faqs: { orderBy: { sort: "asc" } } },
  });
  if (!profile) return null;
  const entries = await loadKnowledgeEntries(profileId);
  return buildKnowledgeBlock(toSnapshot(profile), entries, customerText, maxChars);
}

/** "What the AI sees" for the dev UI: the block with no customer text. */
export async function previewKnowledge(
  workspaceId: string,
  instagramAccountId: string
): Promise<{ lines: { id: string; kind: string; text: string }[]; chars: number; truncated: boolean }> {
  const profile = await findProfile(workspaceId, instagramAccountId);
  if (!profile) return { lines: [], chars: 0, truncated: false };
  const block = await loadKnowledgeBlock(profile.id);
  if (!block) return { lines: [], chars: 0, truncated: false };
  return { lines: block.lines.map((l) => ({ id: l.id, kind: l.kind, text: l.text })), chars: block.chars, truncated: block.truncated };
}
