/**
 * Browser side of the DM file upload: tell the server an uploaded file is no
 * longer wanted. The server keeps it if a saved campaign or rule still uses
 * it, so this is safe to call on every remove / replace / cancel.
 */
export function discardDmFile(key: string | null | undefined): void {
  if (!key) return;
  void fetch(`/api/automations/file?key=${encodeURIComponent(key)}`, {
    method: "DELETE",
    keepalive: true,
  }).catch(() => undefined);
}
