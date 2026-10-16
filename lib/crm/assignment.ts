/**
 * ETAP 5.3 — operator assignment, DB side (TZ 31, 53).
 *
 *   event (lead / HOT / handoff / stage) ─▶ assignContact
 *     rules of the workspace ─▶ rulesFor (priority, trigger, stage)
 *     for each rule: chooseAssignee (round robin / team / specialist)
 *       null → next rule (SPECIALIST without a keyword match falls through)
 *       pick → persist the cursor atomically (updateMany where rrCursor = old,
 *              retry on a lost race), close the previous active CrmAssignment,
 *              create the new one, denormalise CrmContact.assignedMemberId,
 *              ASSIGNED activity, Telegram alert to the workspace chat with
 *              "Qabul qildim" / "Bo'shatish" buttons (owner decision 3)
 *
 *   Telegram crm:take / crm:release, inbox reply, lead "Bog'lanildi" ─▶
 *     takeContact / releaseContact for the member behind the user
 *   Team / contact UI ─▶ manualAssign (assign_leads; OPERATOR only to self)
 *
 * Candidates are the workspace members with `assign_leads` (OWNER, ADMIN,
 * MANAGER, OPERATOR / MEMBER) in createdAt order; VIEWER is never assigned.
 */

import { z } from "zod";
import type { CrmAssignment, CrmAssignmentRule, CrmAssignmentTrigger, WorkspaceMember } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { esc, type InlineKeyboard } from "@/lib/telegram/api";
import { notifyWorkspaceChats } from "@/lib/telegram/notify";
import { can, normalizeRole } from "@/lib/workspace-permissions";
import { recordActivity } from "./activity";
import { chooseAssignee, rulesFor, type AssignmentCandidate, type AssignmentContext } from "./assignment-logic";
import { forbidden, notFound, unprocessable } from "./errors";
import { registerCrmListener, type CrmEvent } from "./hooks";
import { tagsOfContact } from "./tags";
import { ASSIGNMENT_TRIGGER_LABELS, type CrmAssignmentRuleRow } from "./types";

// ─── Messages ─────────────────────────────────────────────────────────────────

export const RULE_NOT_FOUND = "Qoida topilmadi";
export const CONTACT_NOT_FOUND = "Kontakt topilmadi";
export const MEMBER_NOT_FOUND = "A'zo topilmadi";
export const NOT_A_MEMBER = "Siz bu workspace a'zosi emassiz";
export const ASSIGN_FORBIDDEN = "Leadlarni biriktirishga ruxsatingiz yo'q";
export const OPERATOR_SELF_ONLY = "Operator kontaktni faqat o'ziga biriktira oladi";
export const RELEASE_OTHERS_FORBIDDEN = "Faqat o'zingizga biriktirilgan kontaktni bo'shata olasiz";
export const TAKE_OTHERS_FORBIDDEN = "Bu kontakt boshqa operatorga biriktirilgan — uni faqat menejer yoki admin qayta biriktira oladi";
export const VIEWER_NOT_ASSIGNABLE = "Kuzatuvchiga kontakt biriktirib bo'lmaydi";
export const MEMBERS_NOT_IN_WORKSPACE = "Ba'zi a'zolar bu workspace'da yo'q";
export const STAGE_REQUIRED = "Bosqich qoidasi uchun bosqichni tanlang";
export const STAGE_ONLY_FOR_ON_STAGE = "Bosqich faqat \"Bosqichga o'tganda\" triggeri uchun";
export const STAGE_NOT_FOUND = "Bosqich topilmadi";
export const TEAM_NEEDS_MEMBERS = "Jamoa strategiyasi uchun kamida bitta a'zo tanlang";
export const SPECIALIST_NEEDS = "Mutaxassis strategiyasi uchun kamida bitta a'zo va bitta mahsulot kalit so'zi kerak";

export const MAX_PRODUCT_KEYWORDS = 20;

// ─── Rules ────────────────────────────────────────────────────────────────────

const TRIGGERS = ["ON_HOT", "ON_LEAD", "ON_HANDOFF", "ON_STAGE", "MANUAL"] as const;
const STRATEGIES = ["ROUND_ROBIN", "TEAM", "SPECIALIST"] as const;

export const ruleInputSchema = z.object({
  name: z.string().trim().min(1, "Qoida nomi kiritilmagan").max(80, "Qoida nomi 80 belgidan oshmasin"),
  active: z.boolean().default(true),
  priority: z.number().int().min(-1000).max(1000).default(0),
  trigger: z.enum(TRIGGERS, { message: "Trigger noto'g'ri" }),
  stageId: z.string().min(1).nullable().optional(),
  strategy: z.enum(STRATEGIES, { message: "Strategiya noto'g'ri" }),
  memberIds: z.array(z.string().min(1)).max(100, "Ko'pi bilan 100 a'zo").default([]),
  productKeywords: z
    .array(z.string().trim().min(1).max(60, "Kalit so'z 60 belgidan oshmasin"))
    .max(MAX_PRODUCT_KEYWORDS, `Ko'pi bilan ${MAX_PRODUCT_KEYWORDS} ta kalit so'z`)
    .default([]),
  onlyUnassigned: z.boolean().default(true),
});
export type RuleInput = z.infer<typeof ruleInputSchema>;
export const ruleUpdateSchema = ruleInputSchema.partial();

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Noto'g'ri ma'lumot";
  const path = issue.path.filter((p) => typeof p === "string").join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

const unique = (values: string[]) => [...new Set(values)];

/** Cross-field checks + membership of memberIds / stageId in the workspace. */
async function validateRule(workspaceId: string, rule: RuleInput): Promise<RuleInput> {
  const memberIds = unique(rule.memberIds);
  const productKeywords = unique(rule.productKeywords.map((k) => k.trim()).filter(Boolean));
  if (rule.trigger === "ON_STAGE") {
    if (!rule.stageId) throw unprocessable(STAGE_REQUIRED);
    const stage = await prisma.crmStage.findFirst({ where: { id: rule.stageId, pipeline: { workspaceId } }, select: { id: true } });
    if (!stage) throw unprocessable(STAGE_NOT_FOUND);
  } else if (rule.stageId) {
    throw unprocessable(STAGE_ONLY_FOR_ON_STAGE);
  }
  if (rule.strategy === "TEAM" && memberIds.length === 0) throw unprocessable(TEAM_NEEDS_MEMBERS);
  if (rule.strategy === "SPECIALIST" && (memberIds.length === 0 || productKeywords.length === 0)) throw unprocessable(SPECIALIST_NEEDS);
  if (memberIds.length > 0) {
    const members = await prisma.workspaceMember.findMany({ where: { workspaceId, id: { in: memberIds } }, select: { id: true } });
    if (members.length !== memberIds.length) throw unprocessable(MEMBERS_NOT_IN_WORKSPACE);
  }
  return { ...rule, memberIds, productKeywords, stageId: rule.trigger === "ON_STAGE" ? rule.stageId : null };
}

export async function listRules(workspaceId: string): Promise<CrmAssignmentRule[]> {
  return prisma.crmAssignmentRule.findMany({ where: { workspaceId }, orderBy: [{ priority: "desc" }, { createdAt: "asc" }] });
}

export async function createRule(workspaceId: string, input: unknown): Promise<CrmAssignmentRule> {
  const parsed = ruleInputSchema.safeParse(input);
  if (!parsed.success) throw unprocessable(firstIssue(parsed.error));
  const rule = await validateRule(workspaceId, parsed.data);
  return prisma.crmAssignmentRule.create({ data: { workspaceId, ...rule, stageId: rule.stageId ?? null } });
}

export async function updateRule(workspaceId: string, ruleId: string, input: unknown): Promise<CrmAssignmentRule> {
  const parsed = ruleUpdateSchema.safeParse(input);
  if (!parsed.success) throw unprocessable(firstIssue(parsed.error));
  const existing = await prisma.crmAssignmentRule.findFirst({ where: { id: ruleId, workspaceId } });
  if (!existing) throw notFound(RULE_NOT_FOUND);
  const merged = await validateRule(workspaceId, {
    name: parsed.data.name ?? existing.name,
    active: parsed.data.active ?? existing.active,
    priority: parsed.data.priority ?? existing.priority,
    trigger: parsed.data.trigger ?? existing.trigger,
    stageId: parsed.data.stageId !== undefined ? parsed.data.stageId : existing.stageId,
    strategy: parsed.data.strategy ?? existing.strategy,
    memberIds: parsed.data.memberIds ?? existing.memberIds,
    productKeywords: parsed.data.productKeywords ?? existing.productKeywords,
    onlyUnassigned: parsed.data.onlyUnassigned ?? existing.onlyUnassigned,
  });
  // The pool changed: start the rotation over so the cursor stays in range.
  const poolChanged = merged.memberIds.join(",") !== existing.memberIds.join(",") || merged.strategy !== existing.strategy;
  return prisma.crmAssignmentRule.update({
    where: { id: existing.id },
    data: { ...merged, stageId: merged.stageId ?? null, ...(poolChanged ? { rrCursor: 0 } : {}) },
  });
}

export async function deleteRule(workspaceId: string, ruleId: string): Promise<void> {
  const existing = await prisma.crmAssignmentRule.findFirst({ where: { id: ruleId, workspaceId } });
  if (!existing) throw notFound(RULE_NOT_FOUND);
  await prisma.crmAssignmentRule.delete({ where: { id: existing.id } });
}

function toRuleRow(rule: CrmAssignmentRule): CrmAssignmentRuleRow & { onlyUnassigned: boolean } {
  return {
    id: rule.id,
    workspaceId: rule.workspaceId,
    name: rule.name,
    active: rule.active,
    trigger: rule.trigger,
    strategy: rule.strategy,
    stageId: rule.stageId,
    memberIds: rule.memberIds,
    productKeywords: rule.productKeywords,
    priority: rule.priority,
    cursor: rule.rrCursor,
    createdAt: rule.createdAt,
    onlyUnassigned: rule.onlyUnassigned,
  };
}

// ─── Candidates / context ─────────────────────────────────────────────────────

type MemberRow = Pick<WorkspaceMember, "id" | "userId" | "role">;

/** Members who may hold a contact, oldest first; `active` = has assign_leads. */
export async function assignmentCandidates(workspaceId: string): Promise<AssignmentCandidate[]> {
  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
    select: { id: true, role: true },
  });
  return members.map((member) => ({ memberId: member.id, active: can(member.role, "assign_leads") }));
}

export interface AssignContextInput {
  product?: string | null;
  leadProduct?: string | null;
  tags?: string[];
}

/** Product (JavobAI extracted), lead product and tags, loaded when the caller did not pass them. */
async function buildContext(
  contact: { id: string; instagramAccountId: string; igUserId: string; conversationId: string | null },
  input: AssignContextInput | undefined
): Promise<AssignmentContext> {
  const tags = input?.tags ?? (await tagsOfContact(contact.id)).flatMap((tag) => [tag.slug, tag.name]);
  let product = input?.product ?? null;
  if (product === null && contact.conversationId) {
    const state = await prisma.aiConversationState.findUnique({ where: { conversationId: contact.conversationId }, select: { extracted: true } });
    const extracted = state?.extracted as Record<string, unknown> | null | undefined;
    product = typeof extracted?.product === "string" ? extracted.product : null;
  }
  let leadProduct = input?.leadProduct ?? null;
  if (leadProduct === null) {
    const lead = await prisma.lead.findFirst({
      where: { instagramAccountId: contact.instagramAccountId, igUserId: contact.igUserId },
      orderBy: { createdAt: "desc" },
      select: { productInterest: true },
    });
    leadProduct = lead?.productInterest ?? null;
  }
  return { product, leadProduct, tags };
}

// ─── Apply ────────────────────────────────────────────────────────────────────

type ContactRow = {
  id: string;
  workspaceId: string;
  instagramAccountId: string;
  igUserId: string;
  username: string | null;
  name: string | null;
  phoneE164: string | null;
  conversationId: string | null;
  assignedMemberId: string | null;
};

const CONTACT_SELECT = {
  id: true,
  workspaceId: true,
  instagramAccountId: true,
  igUserId: true,
  username: true,
  name: true,
  phoneE164: true,
  conversationId: true,
  assignedMemberId: true,
} as const;

async function loadContact(workspaceId: string, contactId: string): Promise<ContactRow> {
  const contact = await prisma.crmContact.findFirst({ where: { id: contactId, workspaceId }, select: CONTACT_SELECT });
  if (!contact) throw notFound(CONTACT_NOT_FOUND);
  return contact;
}

async function loadMember(workspaceId: string, memberId: string): Promise<(MemberRow & { name: string }) | null> {
  const member = await prisma.workspaceMember.findFirst({
    where: { id: memberId, workspaceId },
    select: { id: true, userId: true, role: true, user: { select: { name: true, email: true } } },
  });
  if (!member) return null;
  return { id: member.id, userId: member.userId, role: member.role, name: member.user?.name || member.user?.email || member.id };
}

export function contactLabel(contact: Pick<ContactRow, "username" | "name" | "igUserId">): string {
  return contact.username ? `@${contact.username}` : (contact.name ?? contact.igUserId);
}

export interface ApplyAssignmentInput {
  contact: ContactRow;
  member: { id: string; userId: string; name: string };
  reason: string;
  ruleId?: string | null;
  dealId?: string | null;
  trigger?: CrmAssignmentTrigger | null;
  /** The member who did it by hand (manual / take); null for rules. */
  actorMemberId?: string | null;
  assignedByUserId?: string | null;
  /** Telegram alert with the take / release buttons. */
  notify: boolean;
  matchedKeyword?: string | null;
}

export interface AssignmentResult {
  assignment: CrmAssignment;
  previousMemberId: string | null;
  /** True when the contact already sat with this member (nothing written). */
  unchanged: boolean;
}

/** The common tail: close the previous assignment, write the new one, denormalise, log, alert. */
export async function applyAssignment(input: ApplyAssignmentInput): Promise<AssignmentResult> {
  const { contact, member } = input;
  const now = new Date();
  const current = await prisma.crmAssignment.findFirst({ where: { contactId: contact.id, active: true }, orderBy: { assignedAt: "desc" } });
  if (current && current.memberId === member.id && contact.assignedMemberId === member.id) {
    return { assignment: current, previousMemberId: member.id, unchanged: true };
  }
  if (current) {
    await prisma.crmAssignment.updateMany({ where: { contactId: contact.id, active: true }, data: { active: false, unassignedAt: now } });
  }
  const assignment = await prisma.crmAssignment.create({
    data: {
      workspaceId: contact.workspaceId,
      contactId: contact.id,
      dealId: input.dealId ?? null,
      memberId: member.id,
      ruleId: input.ruleId ?? null,
      reason: input.reason,
      assignedByUserId: input.assignedByUserId ?? null,
      assignedAt: now,
    },
  });
  await prisma.crmContact.update({ where: { id: contact.id }, data: { assignedMemberId: member.id, assignedAt: now } });
  if (input.dealId) {
    await prisma.crmDeal.updateMany({ where: { id: input.dealId, workspaceId: contact.workspaceId }, data: { assignedMemberId: member.id } });
  }
  await recordActivity({
    workspaceId: contact.workspaceId,
    contactId: contact.id,
    dealId: input.dealId ?? null,
    type: "ASSIGNED",
    occurredAt: now,
    actorKind: input.actorMemberId ? "OPERATOR" : "AUTOMATION",
    actorMemberId: input.actorMemberId ?? null,
    title: `Operator biriktirildi: ${member.name}`,
    payload: {
      memberId: member.id,
      previousMemberId: current?.memberId ?? null,
      reason: input.reason,
      ruleId: input.ruleId ?? null,
      trigger: input.trigger ?? null,
      matchedKeyword: input.matchedKeyword ?? null,
    },
  });
  if (input.notify) {
    await notifyWorkspaceChats(contact.workspaceId, assignmentAlertText(contact, member.name, input.trigger ?? null, input.reason), {
      keyboard: assignmentKeyboard(contact, "assigned"),
    }).catch(() => 0);
  }
  return { assignment, previousMemberId: current?.memberId ?? null, unchanged: false };
}

// ─── Telegram text / keyboard (shared with the bot) ───────────────────────────

export function assignmentAlertText(
  contact: Pick<ContactRow, "username" | "name" | "igUserId" | "phoneE164">,
  memberName: string,
  trigger: CrmAssignmentTrigger | null,
  reason: string
): string {
  const why = reason === "manual" ? "Qo'lda biriktirildi" : trigger ? ASSIGNMENT_TRIGGER_LABELS[trigger] : reason;
  const lines = [
    `👤 <b>Kontakt biriktirildi</b>`,
    `Mijoz: ${esc(contactLabel(contact))}${contact.name && contact.username ? ` (${esc(contact.name)})` : ""}`,
    `Operator: ${esc(memberName)}`,
    `Sabab: ${esc(why)}`,
  ];
  if (contact.phoneE164) lines.push(`📞 ${esc(contact.phoneE164)}`);
  lines.push(`"Qabul qildim" — kontakt sizga o'tadi; "Bo'shatish" — navbatga qaytadi.`);
  return lines.join("\n");
}

export function assignmentKeyboard(contact: Pick<ContactRow, "id" | "conversationId">, state: "assigned" | "taken" | "released"): InlineKeyboard {
  const rows: InlineKeyboard = [];
  const take = { text: "✅ Qabul qildim", callback_data: `crm:take:${contact.id}` };
  const release = { text: "↩️ Bo'shatish", callback_data: `crm:release:${contact.id}` };
  if (state === "assigned") rows.push([take, release]);
  else if (state === "taken") rows.push([release]);
  else rows.push([take]);
  if (contact.conversationId) rows.push([{ text: "💬 Instagram suhbat", url: `${getBaseUrl()}/inbox?conversation=${contact.conversationId}` }]);
  return rows;
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export interface AssignContactInput {
  workspaceId: string;
  contactId: string;
  trigger: CrmAssignmentTrigger;
  dealId?: string | null;
  stageId?: string | null;
  context?: AssignContextInput;
  /** The member acting (MANUAL trigger); rules run as AUTOMATION. */
  actor?: { memberId: string; userId?: string | null } | null;
  /** Default true: Telegram alert to the workspace chat. */
  notify?: boolean;
}

export type AssignContactResult =
  | { assigned: true; memberId: string; ruleId: string | null; assignment: CrmAssignment; unchanged: boolean }
  | { assigned: false; reason: "not_found" | "no_rule" | "already_assigned" | "no_candidate" };

const CURSOR_RETRIES = 3;

/** Reserves the rule's next cursor; false when another assignment moved it first (the caller reloads and retries). */
async function advanceCursor(ruleId: string, from: number, to: number): Promise<boolean> {
  const moved = await prisma.crmAssignmentRule.updateMany({ where: { id: ruleId, rrCursor: from }, data: { rrCursor: to } });
  return moved.count === 1;
}

/**
 * Runs the rules of `trigger` for the contact. The first rule that yields a
 * member wins; a SPECIALIST rule without a keyword match (or a rule whose
 * pool has nobody active) falls through to the next one.
 */
export async function assignContact(input: AssignContactInput): Promise<AssignContactResult> {
  const contact = await prisma.crmContact.findFirst({ where: { id: input.contactId, workspaceId: input.workspaceId }, select: CONTACT_SELECT });
  if (!contact) return { assigned: false, reason: "not_found" };

  const allRules = await prisma.crmAssignmentRule.findMany({ where: { workspaceId: input.workspaceId, active: true } });
  const rules = rulesFor(allRules.map(toRuleRow), input.trigger, input.stageId ?? null);
  if (rules.length === 0) return { assigned: false, reason: "no_rule" };

  const applicable = rules.filter((rule) => !(rule.onlyUnassigned && contact.assignedMemberId));
  if (applicable.length === 0) return { assigned: false, reason: "already_assigned" };

  const candidates = await assignmentCandidates(input.workspaceId);
  const context = await buildContext(contact, input.context);

  for (const rule of applicable) {
    let cursor = rule.cursor;
    for (let attempt = 0; attempt < CURSOR_RETRIES; attempt++) {
      const choice = chooseAssignee({ rule, candidates, cursor, context });
      if (!choice) break; // no keyword match / nobody active → next rule
      if (!(await advanceCursor(rule.id, cursor, choice.nextCursor))) {
        const fresh = await prisma.crmAssignmentRule.findUnique({ where: { id: rule.id }, select: { rrCursor: true } });
        if (!fresh) break;
        cursor = fresh.rrCursor;
        continue;
      }
      const member = await loadMember(input.workspaceId, choice.memberId);
      if (!member) break;
      const result = await applyAssignment({
        contact,
        member,
        reason: `rule:${rule.id}`,
        ruleId: rule.id,
        dealId: input.dealId ?? null,
        trigger: input.trigger,
        actorMemberId: input.actor?.memberId ?? null,
        assignedByUserId: input.actor?.userId ?? null,
        notify: input.notify !== false,
        matchedKeyword: choice.matchedKeyword ?? null,
      });
      return { assigned: true, memberId: member.id, ruleId: rule.id, assignment: result.assignment, unchanged: result.unchanged };
    }
  }
  return { assigned: false, reason: "no_candidate" };
}

// ─── Take / release / manual ──────────────────────────────────────────────────

export type TakeReason = "telegram_take" | "inbox_reply" | "lead_contacted" | "manual";

/**
 * The pressing / replying member takes the contact for themselves (needs
 * assign_leads). An OPERATOR (or legacy MEMBER) cannot take a contact another
 * member actively holds — reassigning someone else's lead is MANAGER+ (TZ 53).
 */
export async function takeContact(workspaceId: string, contactId: string, memberId: string, reason: TakeReason): Promise<AssignmentResult> {
  const member = await loadMember(workspaceId, memberId);
  if (!member) throw forbidden(NOT_A_MEMBER);
  if (!can(member.role, "assign_leads")) throw forbidden(ASSIGN_FORBIDDEN);
  const contact = await loadContact(workspaceId, contactId);
  if (normalizeRole(member.role) === "OPERATOR") {
    const current = await prisma.crmAssignment.findFirst({ where: { contactId: contact.id, active: true }, orderBy: { assignedAt: "desc" } });
    const holder = current?.memberId ?? contact.assignedMemberId;
    if (holder && holder !== member.id) throw forbidden(TAKE_OTHERS_FORBIDDEN);
  }
  return applyAssignment({
    contact,
    member,
    reason,
    actorMemberId: member.id,
    assignedByUserId: member.userId,
    notify: false,
  });
}

export interface ReleaseResult {
  released: boolean;
  previousMemberId: string | null;
}

/** Closes the active assignment. Operators release only their own; MANAGER+ anyone's. */
export async function releaseContact(workspaceId: string, contactId: string, memberId: string, reason = "release"): Promise<ReleaseResult> {
  const member = await loadMember(workspaceId, memberId);
  if (!member) throw forbidden(NOT_A_MEMBER);
  if (!can(member.role, "assign_leads")) throw forbidden(ASSIGN_FORBIDDEN);
  const contact = await loadContact(workspaceId, contactId);
  const current = await prisma.crmAssignment.findFirst({ where: { contactId: contact.id, active: true }, orderBy: { assignedAt: "desc" } });
  const holder = current?.memberId ?? contact.assignedMemberId;
  if (!holder) return { released: false, previousMemberId: null };
  if (holder !== member.id && normalizeRole(member.role) === "OPERATOR") throw forbidden(RELEASE_OTHERS_FORBIDDEN);

  const now = new Date();
  await prisma.crmAssignment.updateMany({ where: { contactId: contact.id, active: true }, data: { active: false, unassignedAt: now } });
  await prisma.crmContact.update({ where: { id: contact.id }, data: { assignedMemberId: null, assignedAt: null } });
  await recordActivity({
    workspaceId,
    contactId: contact.id,
    type: "UNASSIGNED",
    occurredAt: now,
    actorKind: "OPERATOR",
    actorMemberId: member.id,
    title: `Operator bo'shatildi: ${member.name}`,
    payload: { memberId: holder, byMemberId: member.id, reason },
  });
  return { released: true, previousMemberId: holder };
}

/**
 * Assignment from the UI. `actorRole` needs assign_leads; an OPERATOR may only
 * pick themselves (`actorMemberId`); the target must be able to hold contacts.
 */
export async function manualAssign(
  workspaceId: string,
  actorRole: string,
  contactId: string,
  memberId: string,
  actor: { memberId?: string | null; userId?: string | null } = {}
): Promise<AssignmentResult> {
  if (!can(actorRole, "assign_leads")) throw forbidden(ASSIGN_FORBIDDEN);
  if (normalizeRole(actorRole) === "OPERATOR" && memberId !== actor.memberId) throw forbidden(OPERATOR_SELF_ONLY);
  const member = await loadMember(workspaceId, memberId);
  if (!member) throw notFound(MEMBER_NOT_FOUND);
  if (!can(member.role, "assign_leads")) throw unprocessable(VIEWER_NOT_ASSIGNABLE);
  const contact = await loadContact(workspaceId, contactId);
  return applyAssignment({
    contact,
    member,
    reason: "manual",
    trigger: "MANUAL",
    actorMemberId: actor.memberId ?? null,
    assignedByUserId: actor.userId ?? null,
    notify: memberId !== actor.memberId,
  });
}

/** Member row of a user in the workspace (null when not a member). */
export async function memberOfUser(workspaceId: string, userId: string) {
  return prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } }, select: { id: true, role: true, userId: true } });
}

/**
 * Lead "Bog'lanildi" by a signed-in user (Telegram button, leads API): the
 * lead's contact goes to that user's member row. No-op when the user is not
 * a member or no CrmContact exists yet. Never throws.
 */
export async function takeContactForLead(leadId: string, userId: string): Promise<AssignmentResult | null> {
  try {
    const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { workspaceId: true, instagramAccountId: true, igUserId: true } });
    if (!lead) return null;
    const member = await memberOfUser(lead.workspaceId, userId);
    if (!member || !can(member.role, "assign_leads")) return null;
    const contact = await prisma.crmContact.findUnique({
      where: { instagramAccountId_igUserId: { instagramAccountId: lead.instagramAccountId, igUserId: lead.igUserId } },
      select: { id: true },
    });
    if (!contact) return null;
    return await takeContact(lead.workspaceId, contact.id, member.id, "lead_contacted");
  } catch {
    return null;
  }
}

// ─── Listener ─────────────────────────────────────────────────────────────────

/** "tg:<tgUserId>" → the linked user; a plain id → that user; "tg:@name" cannot be resolved. */
async function resolveAcceptedBy(workspaceId: string, acceptedBy: string): Promise<{ memberId: string; reason: TakeReason } | null> {
  if (acceptedBy.startsWith("tg:")) {
    const tgUserId = acceptedBy.slice(3);
    if (!/^\d+$/.test(tgUserId)) return null;
    const link = await prisma.telegramUser.findUnique({ where: { tgUserId }, select: { userId: true } });
    if (!link) return null;
    const member = await memberOfUser(workspaceId, link.userId);
    return member ? { memberId: member.id, reason: "telegram_take" } : null;
  }
  const member = await memberOfUser(workspaceId, acceptedBy);
  return member ? { memberId: member.id, reason: "inbox_reply" } : null;
}

/**
 * The listener (lib/crm/hooks CrmEvent):
 *   lead_created        → ON_LEAD rules (deal + lead product as context)
 *   score.becameHot     → ON_HOT rules
 *   handoff OPENED      → ON_HANDOFF rules
 *   handoff ACCEPTED    → AiHandoff.acceptedBy ("tg:<id>" or a user id) takes the contact
 *   stage_changed       → ON_STAGE rules of the new stage
 *   lead_contacted      → the member who pressed "Bog'lanildi" takes the contact
 *   interaction (operator reply with a member, contact unassigned) → that member takes it
 * Exported so the worker / tests can call it directly.
 */
export async function onCrmEventForAssignment(event: CrmEvent): Promise<void> {
  const base = { workspaceId: event.workspaceId, contactId: event.contactId };
  switch (event.kind) {
    case "lead_created":
      await assignContact({ ...base, trigger: "ON_LEAD", dealId: event.dealId, context: { leadProduct: event.productInterest } });
      return;
    case "score":
      if (event.becameHot) await assignContact({ ...base, trigger: "ON_HOT" });
      return;
    case "handoff": {
      if (event.state === "HANDOFF_OPENED") {
        await assignContact({ ...base, trigger: "ON_HANDOFF" });
      } else if (event.state === "HANDOFF_ACCEPTED") {
        const handoff = await prisma.aiHandoff.findUnique({ where: { id: event.handoffId }, select: { acceptedBy: true } });
        if (!handoff?.acceptedBy) return;
        const who = await resolveAcceptedBy(event.workspaceId, handoff.acceptedBy);
        if (who) await takeContact(event.workspaceId, event.contactId, who.memberId, who.reason);
      }
      return;
    }
    case "stage_changed":
      await assignContact({ ...base, trigger: "ON_STAGE", dealId: event.dealId, stageId: event.toStageId });
      return;
    case "lead_contacted":
      if (event.memberId) await takeContact(event.workspaceId, event.contactId, event.memberId, "lead_contacted");
      return;
    case "interaction":
      if (event.direction === "outbound" && event.memberId && !event.contact.assignedMemberId) {
        await takeContact(event.workspaceId, event.contactId, event.memberId, "inbox_reply");
      }
      return;
    default:
      return;
  }
}

/** Wires the listener (idempotent: the registry is a Set); importing this module does it too (the worker imports lib/crm/assignment). */
export function registerAssignmentListeners(): void {
  registerCrmListener(onCrmEventForAssignment);
}

registerAssignmentListeners();
