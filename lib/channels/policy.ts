/**
 * Channel messaging policy (audit 2026-10-26, T4), checked before an adapter
 * is called, from the capability matrix:
 *
 *   private reply   once per comment, within private_reply_window_days
 *                   (Facebook: 7 days). A ChannelPrivateReply row is claimed
 *                   (unique channel + comment) before the send, so a retry
 *                   or a second worker never sends twice. A send that Meta
 *                   refused (auth / permission / invalid / window) frees the
 *                   comment again; one whose outcome is unknown (timeout)
 *                   stays used — a duplicate DM is worse than a miss.
 *   DM              only inside dm_window_hours after the customer's last
 *                   message (Messenger: 24 h, RESPONSE messaging type).
 */

import { prisma } from "@/lib/db/client";
import { usableCredentials } from "./access";
import { capabilitiesOf, dmWindowOpen, privateReplyAllowed } from "./capabilities";
import { adapterFor } from "./registry";
import { ChannelError, type ChannelErrorKind } from "./types";

/** The platform answered "no": nothing reached the customer, the comment may be tried again. */
const REFUSED = new Set<ChannelErrorKind>(["auth", "permission", "invalid", "window_closed", "not_supported"]);

export interface PrivateReplyInput {
  workspaceId: string;
  credentialId: string;
  commentId: string;
  commentAt: Date;
  text: string;
  now?: Date;
}

export async function sendPrivateReply(input: PrivateReplyInput): Promise<{ externalId: string }> {
  const now = input.now ?? new Date();
  const creds = await usableCredentials(input.workspaceId, input.credentialId, now);
  const caps = capabilitiesOf(creds.channel);
  if (caps.private_reply_window_days === null) throw new ChannelError("not_supported", "Bu kanalda shaxsiy javob yo'q");
  if (!privateReplyAllowed(creds.channel, input.commentAt, now)) {
    throw new ChannelError("window_closed", `Shaxsiy javob faqat ${caps.private_reply_window_days} kun ichida yuboriladi`);
  }
  const adapter = adapterFor(creds.channel);
  if (!adapter) throw new ChannelError("not_supported", `${creds.channel} adapteri yo'q`);

  let claimId: string;
  try {
    const row = await prisma.channelPrivateReply.create({
      data: { workspaceId: input.workspaceId, channel: creds.channel, commentId: input.commentId, credentialId: input.credentialId },
    });
    claimId = row.id;
  } catch (error) {
    if ((error as { code?: string }).code !== "P2002") throw error;
    const existing = await prisma.channelPrivateReply.findUnique({ where: { channel_commentId: { channel: creds.channel, commentId: input.commentId } } });
    const refused = existing?.status === "FAILED" && REFUSED.has((existing.error ?? "").split(":")[0] as ChannelErrorKind);
    if (!existing || !refused) throw new ChannelError("invalid", "Bu kommentga shaxsiy javob allaqachon yuborilgan");
    const reclaimed = await prisma.channelPrivateReply.updateMany({ where: { id: existing.id, status: "FAILED" }, data: { status: "SENDING", error: null } });
    if (reclaimed.count === 0) throw new ChannelError("invalid", "Bu kommentga shaxsiy javob allaqachon yuborilmoqda");
    claimId = existing.id;
  }

  try {
    const sent = await adapter.privateReply(creds, input.commentId, input.text);
    await prisma.channelPrivateReply.update({ where: { id: claimId }, data: { status: "SENT", externalId: sent.externalId } });
    return sent;
  } catch (error) {
    const kind: ChannelErrorKind = error instanceof ChannelError ? error.kind : "transient";
    const message = error instanceof Error ? error.message : String(error);
    await prisma.channelPrivateReply.update({ where: { id: claimId }, data: { status: "FAILED", error: `${kind}: ${message}`.slice(0, 500) } });
    throw error;
  }
}

export interface DmInput {
  workspaceId: string;
  credentialId: string;
  recipientId: string;
  text: string;
  /** The customer's last inbound message in this conversation. */
  lastInboundAt: Date | null;
  now?: Date;
}

export async function sendDmInWindow(input: DmInput): Promise<{ externalId: string }> {
  const now = input.now ?? new Date();
  const creds = await usableCredentials(input.workspaceId, input.credentialId, now);
  const caps = capabilitiesOf(creds.channel);
  if (!caps.supports_dm) throw new ChannelError("not_supported", "Bu kanalda shaxsiy xabar yo'q");
  if (!dmWindowOpen(creds.channel, input.lastInboundAt, now)) {
    throw new ChannelError("window_closed", `Mijoz oxirgi ${caps.dm_window_hours} soat ichida yozmagan — xabar yuborib bo'lmaydi`);
  }
  const adapter = adapterFor(creds.channel);
  if (!adapter) throw new ChannelError("not_supported", `${creds.channel} adapteri yo'q`);
  return adapter.sendDm(creds, input.recipientId, input.text);
}
