import { findProfile } from "@/lib/assistant/profile";
import { findInstructionLikeFields } from "@/lib/assistant/profile-write";
import { MAX_PROFILE_CHARS, profileCharCount } from "@/lib/assistant/prompt";

type LoadedProfile = NonNullable<Awaited<ReturnType<typeof findProfile>>>;

export function serializeProfile(profile: LoadedProfile) {
  const categories = Array.isArray(profile.categories)
    ? (profile.categories as Array<{ name: string; note?: string }>)
    : [];
  const hours =
    profile.workingHours && typeof profile.workingHours === "object"
      ? (profile.workingHours as Record<string, unknown>)
      : null;
  const faqs = profile.faqs.map((f) => ({ id: f.id, question: f.question, answer: f.answer, source: f.source }));
  return {
    id: profile.id,
    instagramAccountId: profile.instagramAccountId,
    enabled: profile.enabled,
    approvedAt: profile.approvedAt,
    companyName: profile.companyName,
    description: profile.description,
    pricePolicy: profile.pricePolicy,
    tone: profile.tone,
    personaName: profile.personaName,
    extraFieldLabel: profile.extraFieldLabel,
    finalMessageTemplate: profile.finalMessageTemplate,
    handleCampaignReplies: profile.handleCampaignReplies,
    handleInboundDm: profile.handleInboundDm,
    operatorPauseHours: profile.operatorPauseHours,
    maxBotMessages: profile.maxBotMessages,
    fallbackLeadWithoutPhone: profile.fallbackLeadWithoutPhone,
    postHandoffReply: profile.postHandoffReply,
    workingHours: hours,
    offHoursMessage: profile.offHoursMessage,
    address: profile.address,
    delivery: profile.delivery,
    paymentMethods: profile.paymentMethods,
    categories,
    priceReminderEnabled: profile.priceReminderEnabled,
    source: profile.source,
    updatedAt: profile.updatedAt,
    products: profile.products.map((p) => ({
      id: p.id,
      name: p.name,
      note: p.note,
      price: p.price === null ? null : Number(p.price),
      priceIsFrom: p.priceIsFrom,
      currency: p.currency,
      unit: p.unit,
      priceUpdatedAt: p.priceUpdatedAt,
    })),
    faqs,
    charCount: profileCharCount({
      companyName: profile.companyName,
      description: profile.description,
      categories,
      faqs,
      address: profile.address,
      delivery: profile.delivery,
      workingHours: typeof hours?.text === "string" ? hours.text : null,
    }),
    charLimit: MAX_PROFILE_CHARS,
    instructionWarnings: findInstructionLikeFields({
      description: profile.description,
      address: profile.address,
      delivery: profile.delivery,
      faqs,
      categories,
    }),
  };
}
