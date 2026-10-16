/**
 * Event → Contact → Conversation → Message.
 *
 * Every step is idempotent so a retried job can run it again safely: the
 * contact and conversation are found-or-created on unique keys, and the
 * inbound message is unique per (conversation, mid). Interaction counters only
 * move when the message is new, so a retry never counts the same reply twice.
 */

import { crmTouch } from "@/lib/crm/hooks";
import { prisma } from "@/lib/db/client";
import { getMessagingProfile } from "@/lib/meta/client";
import type {
  InstagramContact,
  InstagramEventType,
  TriggerConversation,
  TriggerMessageDirection,
} from "@/app/generated/prisma/client";
import { isUniqueViolation } from "./ingest";

export interface InteractionEvent {
  id: string;
  workspaceId: string;
  instagramAccountId: string;
  eventType: InstagramEventType;
  senderId: string;
  senderUsername: string | null;
  messageId: string;
  storyId: string | null;
  text: string;
  timestamp: Date;
}

async function findOrCreateContact(event: InteractionEvent): Promise<InstagramContact> {
  const where = {
    instagramAccountId_igUserId: { instagramAccountId: event.instagramAccountId, igUserId: event.senderId },
  };
  const existing = await prisma.instagramContact.findUnique({ where });
  if (existing) return existing;

  try {
    return await prisma.instagramContact.create({
      data: {
        workspaceId: event.workspaceId,
        instagramAccountId: event.instagramAccountId,
        igUserId: event.senderId,
        username: event.senderUsername,
        source: event.eventType,
        firstInteractionAt: event.timestamp,
        lastInteractionAt: event.timestamp,
        interactionCount: 0,
      },
    });
  } catch (error) {
    // Two events from the same new person processed at once.
    if (!isUniqueViolation(error)) throw error;
    return prisma.instagramContact.findUniqueOrThrow({ where });
  }
}

async function findOrCreateConversation(contact: InstagramContact, at: Date): Promise<TriggerConversation> {
  const existing = await prisma.triggerConversation.findUnique({ where: { contactId: contact.id } });
  if (existing) return existing;
  try {
    return await prisma.triggerConversation.create({
      data: {
        workspaceId: contact.workspaceId,
        instagramAccountId: contact.instagramAccountId,
        contactId: contact.id,
        lastMessageAt: at,
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return prisma.triggerConversation.findUniqueOrThrow({ where: { contactId: contact.id } });
  }
}

/** Returns false when a message with this mid is already stored. */
export async function storeMessage(input: {
  conversationId: string;
  direction: TriggerMessageDirection;
  text: string;
  mid: string | null;
  eventType?: InstagramEventType | null;
  storyId?: string | null;
  eventId?: string | null;
  executionId?: string | null;
}): Promise<boolean> {
  try {
    await prisma.triggerMessage.create({
      data: {
        conversationId: input.conversationId,
        direction: input.direction,
        text: input.text,
        mid: input.mid,
        eventType: input.eventType ?? null,
        storyId: input.storyId ?? null,
        eventId: input.eventId ?? null,
        executionId: input.executionId ?? null,
      },
    });
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

export interface RecordedInteraction {
  contact: InstagramContact;
  conversation: TriggerConversation;
  /** True the first time this event is recorded (false on a retry). */
  isNewMessage: boolean;
  isNewContact: boolean;
}

export async function recordInteraction(event: InteractionEvent): Promise<RecordedInteraction> {
  let contact = await findOrCreateContact(event);
  const isNewContact = contact.interactionCount === 0;
  const conversation = await findOrCreateConversation(contact, event.timestamp);

  const isNewMessage = await storeMessage({
    conversationId: conversation.id,
    direction: "INBOUND",
    text: event.text,
    mid: event.messageId,
    eventType: event.eventType,
    storyId: event.storyId,
    eventId: event.id,
  });

  if (isNewMessage) {
    const later = (a: Date, b: Date) => (a.getTime() >= b.getTime() ? a : b);
    contact = await prisma.instagramContact.update({
      where: { id: contact.id },
      data: {
        interactionCount: { increment: 1 },
        lastInteractionAt: later(contact.lastInteractionAt, event.timestamp),
        username: contact.username ?? event.senderUsername,
      },
    });
    await prisma.triggerConversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: later(conversation.lastMessageAt, event.timestamp) },
    });
    void crmTouch({ kind: "trigger_interaction", instagramContactId: contact.id, at: event.timestamp, payload: { eventType: event.eventType, eventId: event.id } });
  }

  await prisma.instagramEvent.update({
    where: { id: event.id },
    data: { contactId: contact.id, conversationId: conversation.id },
  });

  return { contact, conversation, isNewMessage, isNewContact };
}

/**
 * Fill in username / name from Instagram once. Best effort: a failure here
 * must never stop the reply, it only leaves the contact as an id.
 */
export async function enrichContact(contact: InstagramContact, accessToken: string): Promise<InstagramContact> {
  if (contact.username && contact.name) return contact;
  try {
    const profile = await getMessagingProfile(accessToken, contact.igUserId);
    if (!profile.username && !profile.name) return contact;
    return await prisma.instagramContact.update({
      where: { id: contact.id },
      data: {
        username: contact.username ?? profile.username ?? null,
        name: contact.name ?? profile.name ?? null,
      },
    });
  } catch {
    return contact;
  }
}
