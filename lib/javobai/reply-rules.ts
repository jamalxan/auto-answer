/**
 * Reply validators (live test B-09 / B-10): at most ONE question per message,
 * and never a question about a field the customer already gave. Pure text
 * post-processing, applied after the model's reply is composed; code-chosen
 * questions (phone / qualification) replace the model's own question so the
 * message never carries two.
 */

export interface KnownFields {
  name?: boolean;
  budget?: boolean;
  location?: boolean;
  phone?: boolean;
  product?: boolean;
}

interface Unit {
  /** Sentence text without its trailing whitespace. */
  text: string;
  /** Whitespace that followed it in the original (kept when rejoining). */
  ws: string;
}

/**
 * Split one line into sentences. A boundary is a run of [.!?…؟] that is followed
 * by whitespace or the end of the line, so decimals ("2.5 mln", "120.000"),
 * times ("9.30"), URLs, emails and "1,5" are never cut.
 */
function splitUnits(line: string): Unit[] {
  const units: Unit[] = [];
  const boundary = /[.!?…؟]+(?=\s|$)(\s*)/gu;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = boundary.exec(line)) !== null) {
    const end = m.index + m[0].length - m[1].length;
    const text = line.slice(start, end).trim();
    if (text) units.push({ text, ws: m[1] });
    start = m.index + m[0].length;
  }
  const tail = line.slice(start).trim();
  if (tail) units.push({ text: tail, ws: "" });
  return units;
}

/** Split into sentences, keeping the terminator; newlines also separate. */
export function splitSentences(text: string): string[] {
  return text.split(/\n+/).flatMap((line) => splitUnits(line).map((u) => u.text));
}

/** A question mark that ends a word (not the "?" inside a URL query string). */
const isQuestion = (sentence: string) => /[?؟](?=\s|$)/.test(sentence);

const FIELD_PATTERNS: Record<keyof KnownFields, RegExp> = {
  budget: /(byudjet|budjet|бюджет|буджет|qancha\s*(?:gacha|ga)?\s*(?:mo'ljal|sarfla)|на какую сумму|how much.*(?:budget|spend))/i,
  location: /(qaysi\s+(?:shahar|hudud|viloyat|tuman)|shahar(?:da|dasiz)|hududda|manzilingiz|шаҳар|ҳудуд|в каком (?:городе|районе)|откуда вы|where are you)/i,
  phone: /(telefon|raqam|nomer|номер|телефон|рақам|phone)/i,
  name: /(ismingiz|исмингиз|ismingizni|как вас зовут|ваше имя|your name|nima deb murojaat)/i,
  product: /(qaysi\s+(?:mahsulot|xizmat|model)|какой товар|какая услуга|which product)/i,
};

/** Keep line structure: map the sentences of each line, drop lines that end up empty; original spacing is preserved. */
function filterSentences(reply: string, keep: (sentence: string) => boolean | string): string {
  return reply
    .split(/\n+/)
    .map((line) => {
      let out = "";
      for (const u of splitUnits(line)) {
        const r = keep(u.text);
        if (r === false || r === "") continue;
        out += (typeof r === "string" ? r : u.text) + u.ws;
      }
      return out.trim();
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

const QUESTION_WORDS = /(?<![\p{L}\p{N}])(?:qaysi|qayer\p{L}*|qanday|nima\p{L}*|qancha|necha|kim|qachon|какой|какая|какие|где|что|когда|сколько|how|what|which|where|when)(?![\p{L}\p{N}])/iu;

function mentionsKnownField(text: string, known: KnownFields): boolean {
  return (Object.keys(FIELD_PATTERNS) as Array<keyof KnownFields>).some((k) => known[k] && FIELD_PATTERNS[k].test(text));
}

/**
 * A question about a known field: drop only the clause that asks it. If the
 * sentence also asks / says something else, that part stays; otherwise the
 * whole sentence goes.
 */
function trimKnownClauses(sentence: string, known: KnownFields): string {
  const terminator = /[.!?…؟]+$/.exec(sentence)?.[0] ?? "";
  const body = terminator ? sentence.slice(0, sentence.length - terminator.length) : sentence;
  const clauses = body.match(/[^,;]+(?:[,;]\s*|$)/g) ?? [body];
  const kept = clauses.filter((c) => !mentionsKnownField(c, known));
  if (kept.length === 0) return "";
  if (kept.length === clauses.length) return sentence;
  let text = kept.join("").trim().replace(/[,;\s]+$/, "");
  if (!text) return "";
  text = text.charAt(0).toUpperCase() + text.slice(1);
  const questionish = kept.some((c) => QUESTION_WORDS.test(c));
  return text + (questionish ? "?" : ".");
}

/**
 * Remove question sentences about fields that are already known (only the
 * known-field clause of a compound sentence). May return "" when the whole
 * reply was such a question; the caller then falls back to a template.
 */
export function dropKnownFieldQuestions(reply: string, known: KnownFields): string {
  return filterSentences(reply, (s) => {
    if (!isQuestion(s)) return true;
    if (!mentionsKnownField(s, known)) return true;
    return trimKnownClauses(s, known);
  });
}

/** Remove every question sentence (statements stay). */
export function stripQuestions(reply: string): string {
  return filterSentences(reply, (s) => !isQuestion(s));
}

/** Keep everything up to and including the first question; later questions are dropped, statements stay. */
export function limitToOneQuestion(reply: string): string {
  let seen = false;
  return filterSentences(reply, (s) => {
    if (!isQuestion(s)) return true;
    if (seen) return false;
    seen = true;
    return true;
  });
}

export function countQuestions(reply: string): number {
  return splitSentences(reply).filter(isQuestion).length;
}
