/**
 * ETAP 13 — the error a content service throws to a route: an HTTP status
 * and an Uzbek message, turned into `{ success: false, error }` by
 * lib/content/service `run()`. Publish-time error classification (Meta
 * codes → PUBLISH_* catalog codes and retry policy) also lives here.
 */

export class ContentError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string
  ) {
    super(message);
    this.name = "ContentError";
  }
}

export const NOT_FOUND = "Post topilmadi";
export const MEDIA_NOT_FOUND = "Media topilmadi";

export function notFound(message = NOT_FOUND): ContentError {
  return new ContentError(404, message);
}
