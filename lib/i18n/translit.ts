/**
 * Uzbek Latin -> Cyrillic transliteration (2021 alphabet rules), used for the
 * "uz-Cyrl" UI locale so every Uzbek string gets a Cyrillic form without a
 * second copy of the dictionary.
 */

// Brand / technical words that must stay in Latin script.
const KEEP = new Set(
  [
    "Instagram", "Telegram", "amoCRM", "Bitrix24", "ManyChat", "SocialAuto", "JavobAI", "Gemini", "OpenAI",
    "Google", "Meta", "WhatsApp", "Facebook", "API", "MCP", "CRM", "AI", "DM", "URL", "JSON", "CSV", "SQL",
    "HTTP", "HTTPS", "OK", "ID", "UTM", "RSC", "LLM", "STT", "OAuth", "Webhook", "webhook", "PRICE_ASKED",
  ].map((w) => w.toLowerCase())
);

const APOSTROPHES = /[ʻʼ‘’`´']/;
const A = "['ʻʼ‘’`´]";
const VOWELS = "aeiou";

function caseLike(src: string, out: string, upperWord: boolean): string {
  if (src[0] === src[0].toLowerCase() && src[0] !== src[0].toUpperCase()) return out;
  // Capitalised digraph in an all-caps word -> all caps; otherwise just the first letter.
  return upperWord ? out.toUpperCase() : out[0].toUpperCase() + out.slice(1);
}

/** Transliterate one run of Latin letters (no spaces). */
function translitWord(word: string): string {
  const letters = word.replace(new RegExp(A, "g"), "");
  const upperWord = letters.length > 1 && letters === letters.toUpperCase();
  let out = "";
  let i = 0;
  const lower = word.toLowerCase();
  const isApos = (idx: number) => idx < word.length && APOSTROPHES.test(word[idx]);

  while (i < word.length) {
    const c = lower[i];
    const orig = word[i];
    const next = lower[i + 1];
    const atStart = i === 0;
    const prevIsVowel = i > 0 && VOWELS.includes(lower[i - 1]);

    if (APOSTROPHES.test(orig)) {
      // Tutuq belgisi: after a vowel in the middle of a word -> ъ.
      out += prevIsVowel && i < word.length - 1 ? "ъ" : "";
      i += 1;
      continue;
    }

    const emit = (cyr: string, consumed: number) => {
      out += caseLike(word.slice(i, i + consumed), cyr, upperWord);
      i += consumed;
    };

    if ((c === "o" || c === "g") && isApos(i + 1)) {
      emit(c === "o" ? "ў" : "ғ", 2);
    } else if (c === "s" && next === "h") emit("ш", 2);
    else if (c === "c" && next === "h") emit("ч", 2);
    else if (c === "n" && next === "g") emit("нг", 2);
    else if (c === "y" && next === "o" && isApos(i + 2)) emit("й", 1);
    else if (c === "y" && next === "o") emit("ё", 2);
    else if (c === "y" && next === "u") emit("ю", 2);
    else if (c === "y" && next === "a") emit("я", 2);
    else if (c === "y" && next === "e") emit("е", 2);
    else if (c === "e") emit(atStart ? "э" : "е", 1);
    else {
      const map: Record<string, string> = {
        a: "а", b: "б", c: "ц", d: "д", f: "ф", g: "г", h: "ҳ", i: "и", j: "ж", k: "к", l: "л", m: "м",
        n: "н", o: "о", p: "п", q: "қ", r: "р", s: "с", t: "т", u: "у", v: "в", w: "в", x: "х", y: "й", z: "з",
      };
      const cyr = map[c];
      if (cyr === undefined) {
        out += orig;
        i += 1;
      } else emit(cyr, 1);
    }
  }
  return out;
}

/** A token we must not touch: URLs, emails, ids, code, mixed alnum, keep-list. */
function isProtectedToken(core: string): boolean {
  if (KEEP.has(core.toLowerCase())) return true;
  if (/[@/\_:#=<>{}[\]|~^]/.test(core)) return true;
  if (/\d/.test(core) && /[A-Za-z]/.test(core)) return true; // gpt4, v2, 3d
  if (/[a-z][A-Z]/.test(core)) return true; // camelCase identifiers
  if (/[A-Za-z]\.[A-Za-z]/.test(core)) return true; // domain.tld, file.ext
  return false;
}

const WORD = new RegExp(`[A-Za-z]+(?:${A}[A-Za-z]+)*`, "g");

/** Transliterate free text; non-Latin and protected tokens pass through untouched. */
export function uzLatinToCyrillic(text: string): string {
  return text.replace(/\S+/g, (token) => {
    const core = token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
    if (!core || isProtectedToken(core)) return token;
    return token.replace(WORD, (w) => (KEEP.has(w.toLowerCase()) ? w : translitWord(w)));
  });
}
