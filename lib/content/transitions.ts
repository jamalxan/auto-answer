/**
 * ETAP 13 — the post status machine (spec §7). Pure; the service and the
 * pipeline both consult it before a compare-and-swap update.
 */

import type { PostStatusValue } from "./schema";

export const TRANSITIONS: Record<PostStatusValue, PostStatusValue[]> = {
  DRAFT: ["SCHEDULED", "PENDING_REVIEW", "CANCELED"],
  PENDING_REVIEW: ["SCHEDULED", "REJECTED", "EXPIRED_REVIEW", "DRAFT"],
  SCHEDULED: ["PREPARING", "PAUSED", "DRAFT", "NEEDS_MANUAL", "FAILED", "CANCELED", "PUBLISHING"],
  PAUSED: ["SCHEDULED", "DRAFT", "CANCELED"],
  PREPARING: ["READY_TO_PUBLISH", "FAILED", "SCHEDULED", "NEEDS_MANUAL"],
  READY_TO_PUBLISH: ["PUBLISHING", "FAILED", "SCHEDULED", "PAUSED"],
  PUBLISHING: ["PUBLISHED", "FAILED"],
  PUBLISHED: [],
  NEEDS_MANUAL: ["PUBLISHED_MANUAL", "CANCELED", "DRAFT"],
  PUBLISHED_MANUAL: [],
  FAILED: ["SCHEDULED", "NEEDS_MANUAL", "DRAFT", "CANCELED"],
  REJECTED: ["DRAFT"],
  EXPIRED_REVIEW: ["DRAFT"],
  CANCELED: ["DRAFT"],
};

export function canTransition(from: PostStatusValue, to: PostStatusValue): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Statuses a user may still edit (FR-S5): nothing in flight or finished. */
export const EDITABLE: PostStatusValue[] = ["DRAFT", "SCHEDULED", "PAUSED", "FAILED", "NEEDS_MANUAL", "REJECTED", "EXPIRED_REVIEW", "CANCELED"];

export const TERMINAL: PostStatusValue[] = ["PUBLISHED", "PUBLISHED_MANUAL"];

/** Statuses that hold a slot in the queue (count against the 24-hour quota). */
export const QUEUED: PostStatusValue[] = ["SCHEDULED", "PREPARING", "READY_TO_PUBLISH", "PUBLISHING"];
