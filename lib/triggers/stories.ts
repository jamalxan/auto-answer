import { getMetaGraphApiVersion } from "@/lib/env";
import { decryptToken } from "@/lib/meta/oauth";

export interface ActiveStory {
  id: string;
  mediaType: string | null;
  previewUrl: string | null;
  permalink: string | null;
  timestamp: string | null;
}

interface GraphStory {
  id: string;
  media_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp?: string;
}

/**
 * Stories currently live on the account (Instagram keeps them 24 hours). Used
 * by the "Specific story" picker. Returns an error string instead of throwing:
 * the picker falls back to stories people already replied to, and manual ids.
 */
export async function fetchActiveStories(
  encryptedToken: string,
  instagramId: string
): Promise<{ stories: ActiveStory[]; error: string | null }> {
  let token: string;
  try {
    token = decryptToken(encryptedToken);
  } catch {
    return { stories: [], error: "Instagram tokenini o'qib bo'lmadi" };
  }

  const url = new URL(`https://graph.instagram.com/${getMetaGraphApiVersion()}/${instagramId}/stories`);
  url.searchParams.set("fields", "id,media_type,media_url,thumbnail_url,permalink,timestamp");
  url.searchParams.set("access_token", token);

  try {
    const response = await fetch(url.toString(), { cache: "no-store" });
    const body = (await response.json()) as { data?: GraphStory[]; error?: { message?: string } };
    if (!response.ok || body.error) {
      return { stories: [], error: body.error?.message ?? `HTTP ${response.status}` };
    }
    return {
      stories: (body.data ?? []).map((story) => ({
        id: story.id,
        mediaType: story.media_type ?? null,
        previewUrl: story.thumbnail_url ?? story.media_url ?? null,
        permalink: story.permalink ?? null,
        timestamp: story.timestamp ?? null,
      })),
      error: null,
    };
  } catch (error) {
    return { stories: [], error: error instanceof Error ? error.message : "Network error" };
  }
}
