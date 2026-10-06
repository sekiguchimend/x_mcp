// X-accurate text measuring + thread splitting.
//
// X counts a post's length by "weighted" characters, not raw string length:
// most CJK/full-width/emoji code points count as 2, everything else as 1, and
// every URL counts as a fixed 23 (t.co shortening) regardless of its real
// length. preview_post and post_thread both need this to avoid 403s and to
// split long text without cutting a URL in half.

const URL_WEIGHT = 23;
const DEFAULT_LIMIT = 280;
const URL_RE = /https?:\/\/[^\s]+/g;
const SENTENCE_BREAKS = "。！？!?.";

interface Unit {
  text: string;
  weight: number;
  /** A preferred split point lands at the end of this unit (whitespace / sentence end). */
  isBreak: boolean;
  isUrl: boolean;
}

/** Weight of a single code point: 2 for CJK/full-width/emoji, 1 otherwise. */
function charWeight(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (
    (cp >= 0x1100 && cp <= 0x11ff) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303f) || // CJK radicals / punctuation
    (cp >= 0x3040 && cp <= 0x33ff) || // Hiragana, Katakana, CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) || // full-width forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    cp >= 0x1f000 // emoji & supplementary symbols
  ) {
    return 2;
  }
  return 1;
}

/** Break text into weighable units, treating each URL as one atomic 23-weight unit. */
function tokenize(text: string): Unit[] {
  const units: Unit[] = [];
  const pushChars = (s: string) => {
    for (const ch of s) {
      units.push({
        text: ch,
        weight: charWeight(ch),
        isBreak: /\s/.test(ch) || SENTENCE_BREAKS.includes(ch),
        isUrl: false,
      });
    }
  };
  let last = 0;
  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    pushChars(text.slice(last, m.index));
    units.push({ text: m[0], weight: URL_WEIGHT, isBreak: false, isUrl: true });
    last = m.index + m[0].length;
  }
  pushChars(text.slice(last));
  return units;
}

/** X-weighted length of a post, and how many URLs it contains. */
export function weightedLength(text: string): { length: number; urlCount: number } {
  let length = 0;
  let urlCount = 0;
  for (const u of tokenize(text)) {
    length += u.weight;
    if (u.isUrl) urlCount++;
  }
  return { length, urlCount };
}

/**
 * Split long text into a thread where each segment is within `limit` weighted
 * characters, preferring to break at whitespace / sentence boundaries and never
 * cutting a URL. Falls back to a hard split for an unbroken over-limit run.
 */
export function splitIntoTweets(text: string, limit: number = DEFAULT_LIMIT): string[] {
  const units = tokenize(text);
  const tweets: string[] = [];
  let i = 0;
  while (i < units.length) {
    let w = 0;
    let j = i;
    let lastBreak = -1;
    while (j < units.length) {
      if (w + units[j].weight > limit) break;
      w += units[j].weight;
      if (units[j].isBreak) lastBreak = j;
      j++;
    }
    let end: number;
    if (j >= units.length) {
      end = j; // the remainder fits
    } else if (lastBreak >= i) {
      end = lastBreak + 1; // break at the last boundary (keeps punctuation, trims whitespace)
    } else {
      end = Math.max(j, i + 1); // no boundary found — hard split, but always make progress
    }
    const chunk = units.slice(i, end).map((u) => u.text).join("").trim();
    if (chunk) tweets.push(chunk);
    i = end;
  }
  return tweets.length ? tweets : [text.trim()].filter((t) => t.length > 0);
}
