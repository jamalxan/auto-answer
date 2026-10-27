/**
 * Runs once per Next.js server instance (see node_modules/next/dist/docs,
 * guides/instrumentation). Log redaction (audit 2026-10-26, T7): every
 * console.* line of the web process is masked for tokens, phones, e-mails.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { installConsoleRedaction } = await import("./lib/security/redact");
    installConsoleRedaction();
  }
}
