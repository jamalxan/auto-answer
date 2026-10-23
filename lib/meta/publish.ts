/**
 * Instagram content publishing (Instagram API with Instagram Login).
 *
 * Thin wrappers over graph.instagram.com: create a media container, poll it,
 * publish it, read back the published media, check the daily publishing quota
 * and post the first comment. Every call sends the token in the Authorization
 * header and runs through handleMetaResponse so Meta errors become the same
 * typed errors (TokenExpiredError, MetaApiError, ...) the rest of lib/meta uses.
 */
import { getMetaGraphApiVersion } from "@/lib/env";
import { handleMetaResponse } from "@/lib/meta/client";

export type ContainerStatus = "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED" | "PUBLISHED";

export interface UserTagParam {
  username: string;
  x?: number;
  y?: number;
}

export interface ContainerParams {
  imageUrl?: string;
  videoUrl?: string;
  mediaType?: "REELS" | "STORIES" | "CAROUSEL";
  isCarouselItem?: boolean;
  children?: string[];
  caption?: string;
  userTags?: UserTagParam[];
  collaborators?: string[];
  altText?: string;
  coverUrl?: string;
  thumbOffsetMs?: number;
  shareToFeed?: boolean;
  audioName?: string;
  trialStrategy?: "MANUAL" | "SS_PERFORMANCE";
  locationId?: string;
  isAiGenerated?: boolean;
}

export interface PublishedMedia {
  id: string;
  permalink?: string;
  media_product_type?: string;
  timestamp?: string;
}

function base() {
  return `https://graph.instagram.com/${getMetaGraphApiVersion()}`;
}

/**
 * A hung Graph call must not hold the publish worker (M3). POSTs get longer:
 * media_publish can take tens of seconds; a timeout there is treated as an
 * ambiguous failure and resolved by asking Meta for the container status.
 */
export const META_POST_TIMEOUT_MS = 90_000;
export const META_GET_TIMEOUT_MS = 30_000;

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function postForm<T>(token: string, path: string, body: URLSearchParams): Promise<T> {
  const response = await fetch(`${base()}/${path}`, {
    method: "POST",
    headers: {
      ...authHeaders(token),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(META_POST_TIMEOUT_MS),
  });
  return handleMetaResponse<T>(response);
}

async function getFields<T>(token: string, path: string, fields: string): Promise<T> {
  const url = new URL(`${base()}/${path}`);
  url.searchParams.set("fields", fields);
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: authHeaders(token),
    signal: AbortSignal.timeout(META_GET_TIMEOUT_MS),
  });
  return handleMetaResponse<T>(response);
}

/**
 * Pure mapping from our camelCase params to the Graph API form fields.
 * Undefined fields are omitted; booleans become "true"/"false"; list-ish
 * fields are JSON-encoded except `children`, which the API takes comma-joined.
 */
export function containerParamsToBody(p: ContainerParams): URLSearchParams {
  const body = new URLSearchParams();
  const set = (key: string, value: string | undefined) => {
    if (value !== undefined) body.set(key, value);
  };
  const bool = (v: boolean | undefined) => (v === undefined ? undefined : v ? "true" : "false");

  set("image_url", p.imageUrl);
  set("video_url", p.videoUrl);
  set("media_type", p.mediaType);
  set("is_carousel_item", bool(p.isCarouselItem));
  set("children", p.children === undefined ? undefined : p.children.join(","));
  set("caption", p.caption);
  set(
    "user_tags",
    p.userTags === undefined
      ? undefined
      : JSON.stringify(
          p.userTags.map((t) => {
            const tag: UserTagParam = { username: t.username };
            if (t.x !== undefined) tag.x = t.x;
            if (t.y !== undefined) tag.y = t.y;
            return tag;
          })
        )
  );
  set("collaborators", p.collaborators === undefined ? undefined : JSON.stringify(p.collaborators));
  set("alt_text", p.altText);
  set("cover_url", p.coverUrl);
  set("thumb_offset", p.thumbOffsetMs === undefined ? undefined : String(p.thumbOffsetMs));
  set("share_to_feed", bool(p.shareToFeed));
  set("audio_name", p.audioName);
  set(
    "trial_params",
    p.trialStrategy === undefined ? undefined : JSON.stringify({ graduation_strategy: p.trialStrategy })
  );
  set("location_id", p.locationId);
  set("is_ai_generated", bool(p.isAiGenerated));
  return body;
}

/** POST /{igUserId}/media → container id (not yet published). */
export async function createContainer(
  token: string,
  igUserId: string,
  params: ContainerParams
): Promise<{ id: string }> {
  const data = await postForm<{ id: string }>(token, `${igUserId}/media`, containerParamsToBody(params));
  return { id: data.id };
}

/** GET /{containerId}?fields=status_code,status → processing state of a container. */
export async function getContainerStatus(
  token: string,
  containerId: string
): Promise<{ status: ContainerStatus; statusText?: string }> {
  const data = await getFields<{ id?: string; status_code: ContainerStatus; status?: string }>(
    token,
    containerId,
    "status_code,status"
  );
  return { status: data.status_code, statusText: data.status };
}

/** POST /{igUserId}/media_publish with creation_id → published media id. */
export async function publishContainer(
  token: string,
  igUserId: string,
  creationId: string
): Promise<{ id: string }> {
  const body = new URLSearchParams({ creation_id: creationId });
  const data = await postForm<{ id: string }>(token, `${igUserId}/media_publish`, body);
  return { id: data.id };
}

/** GET /{mediaId}?fields=id,permalink,media_product_type,timestamp. */
export async function getPublishedMedia(token: string, mediaId: string): Promise<PublishedMedia> {
  const data = await getFields<PublishedMedia>(token, mediaId, "id,permalink,media_product_type,timestamp");
  return {
    id: data.id,
    permalink: data.permalink,
    media_product_type: data.media_product_type,
    timestamp: data.timestamp,
  };
}

/**
 * GET /{igUserId}/content_publishing_limit?fields=quota_usage,config.
 * Meta's documented default is 50 posts per rolling 24 h; used when the
 * response carries no config block.
 */
export async function getPublishingLimit(
  token: string,
  igUserId: string
): Promise<{ quotaUsage: number; quotaTotal: number }> {
  const data = await getFields<{
    data?: { quota_usage?: number; config?: { quota_total?: number; quota_duration?: number } }[];
  }>(token, `${igUserId}/content_publishing_limit`, "quota_usage,config");
  const first = data.data?.[0];
  return {
    quotaUsage: first?.quota_usage ?? 0,
    quotaTotal: first?.config?.quota_total ?? 50,
  };
}

/** POST /{mediaId}/comments with message → comment id (used for the first comment). */
export async function createComment(token: string, mediaId: string, message: string): Promise<{ id: string }> {
  const body = new URLSearchParams({ message });
  const data = await postForm<{ id: string }>(token, `${mediaId}/comments`, body);
  return { id: data.id };
}
