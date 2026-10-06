/**
 * Speech-to-text behind an interface (TZ 3A.4). Owners answer onboarding
 * questions with Telegram voice notes; the provider is chosen from `.env`:
 *
 *   STT_PROVIDER = openai   (OpenAI-compatible /audio/transcriptions: whisper-1,
 *                            gpt-4o-transcribe, or a self-hosted compatible server)
 *   STT_API_KEY  = key (falls back to OPENAI_API_KEY)
 *   STT_MODEL    = model id, default whisper-1
 *   STT_BASE_URL = optional endpoint override
 *
 * Adding a dedicated Uzbek provider (e.g. a local ASR service) means writing one
 * more class that implements `SpeechToTextProvider`.
 */

export const MAX_VOICE_BYTES = 20 * 1024 * 1024;
export const MAX_VOICE_SECONDS = 180;

export interface SpeechToTextProvider {
  readonly name: string;
  /** `language`: ISO-639-1 hint ("uz" | "ru"). */
  transcribe(audio: Buffer, mimeType: string, language?: string): Promise<string>;
}

export class SttError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SttError";
  }
}

export class OpenAISttProvider implements SpeechToTextProvider {
  readonly name = "openai";
  constructor(
    private apiKey: string,
    private model = "whisper-1",
    private baseUrl = "https://api.openai.com/v1"
  ) {}

  async transcribe(audio: Buffer, mimeType: string, language?: string): Promise<string> {
    const form = new FormData();
    const ext = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mpeg") ? "mp3" : "m4a";
    form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), `voice.${ext}`);
    form.append("model", this.model);
    if (language) form.append("language", language);

    const response = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new SttError(`STT ${response.status}: ${body.slice(0, 200)}`);
    }
    const data = (await response.json()) as { text?: string };
    return (data.text ?? "").trim();
  }
}

let override: SpeechToTextProvider | null | undefined;

export function setSttProviderForTests(provider: SpeechToTextProvider | null | undefined) {
  override = provider;
}

export function getSttProvider(): SpeechToTextProvider | null {
  if (override !== undefined) return override;
  const kind = (process.env.STT_PROVIDER ?? "openai").toLowerCase();
  if (kind !== "openai") return null;
  const key = process.env.STT_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!key) return null;
  return new OpenAISttProvider(key, process.env.STT_MODEL ?? "whisper-1", process.env.STT_BASE_URL);
}
