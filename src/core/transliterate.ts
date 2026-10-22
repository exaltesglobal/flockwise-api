// Transliteration of Indian-language words into plain English letters, so people who speak Telugu,
// Hindi or Tamil but cannot read the script can still sing along from the projector.
//
// The nine Brahmic scripts in Unicode share one layout: each block is 128 code points and the same
// letter sits at the same offset in every block (ka is +0x15 in Devanagari, Telugu, Tamil, ...).
// One table over that offset therefore covers all of them, with a few per-script quirks below.
// The spelling aims at how Indian Christians already write song sheets ("Yesu", "prema", "stuthi"),
// not at a scholarly standard, so it reads naturally to a congregation.

export type IndicScript = 'devanagari' | 'bengali' | 'gurmukhi' | 'gujarati' | 'odia' | 'tamil' | 'telugu' | 'kannada' | 'malayalam';

const BLOCKS: { base: number; script: IndicScript }[] = [
  { base: 0x0900, script: 'devanagari' },
  { base: 0x0980, script: 'bengali' },
  { base: 0x0a00, script: 'gurmukhi' },
  { base: 0x0a80, script: 'gujarati' },
  { base: 0x0b00, script: 'odia' },
  { base: 0x0b80, script: 'tamil' },
  { base: 0x0c00, script: 'telugu' },
  { base: 0x0c80, script: 'kannada' },
  { base: 0x0d00, script: 'malayalam' },
];

const blockOf = (code: number) => BLOCKS.find((b) => code >= b.base && code < b.base + 0x80) ?? null;

/** Independent vowels, by offset from the block start. */
const VOWELS: Record<number, string> = { 0x05: 'a', 0x06: 'aa', 0x07: 'i', 0x08: 'ee', 0x09: 'u', 0x0a: 'oo', 0x0b: 'ri', 0x0c: 'li', 0x0d: 'e', 0x0e: 'e', 0x0f: 'e', 0x10: 'ai', 0x11: 'o', 0x12: 'o', 0x13: 'o', 0x14: 'au', 0x60: 'ree', 0x61: 'lee' };
/** Vowel signs that follow a consonant. */
const SIGNS: Record<number, string> = { 0x3e: 'aa', 0x3f: 'i', 0x40: 'ee', 0x41: 'u', 0x42: 'oo', 0x43: 'ri', 0x44: 'ree', 0x45: 'e', 0x46: 'e', 0x47: 'e', 0x48: 'ai', 0x49: 'o', 0x4a: 'o', 0x4b: 'o', 0x4c: 'au', 0x57: 'au', 0x62: 'li', 0x63: 'lee' };
const VIRAMA = 0x4d;
/** Consonants ka..ha, then the nukta forms (qa, khha, ghha, za, dddha, rha, fa, yya). */
const CONSONANTS: Record<number, string> = {
  0x15: 'k', 0x16: 'kh', 0x17: 'g', 0x18: 'gh', 0x19: 'ng',
  0x1a: 'ch', 0x1b: 'chh', 0x1c: 'j', 0x1d: 'jh', 0x1e: 'ny',
  0x1f: 't', 0x20: 'th', 0x21: 'd', 0x22: 'dh', 0x23: 'n',
  0x24: 'th', 0x25: 'th', 0x26: 'd', 0x27: 'dh', 0x28: 'n', 0x29: 'n',
  0x2a: 'p', 0x2b: 'ph', 0x2c: 'b', 0x2d: 'bh', 0x2e: 'm',
  0x2f: 'y', 0x30: 'r', 0x31: 'r', 0x32: 'l', 0x33: 'l', 0x34: 'zh', 0x35: 'v',
  0x36: 'sh', 0x37: 'sh', 0x38: 's', 0x39: 'h',
  0x58: 'q', 0x59: 'kh', 0x5a: 'g', 0x5b: 'z', 0x5c: 'r', 0x5d: 'rh', 0x5e: 'f', 0x5f: 'y',
};
/** The dental "ta" (0x24) is written "th" in the south ("stuthi") and "t" in the north ("tu"). */
const SOUTH: IndicScript[] = ['tamil', 'telugu', 'kannada', 'malayalam'];
/** Hindi and its neighbours drop the inherent "a" at the end of a word (prem, not prema). */
const DROPS_FINAL_A: IndicScript[] = ['devanagari', 'gurmukhi', 'gujarati', 'bengali'];
const LABIAL = new Set([0x2a, 0x2b, 0x2c, 0x2d, 0x2e]);
/** Malayalam chillu letters: consonants with no vowel at all. */
const CHILLU: Record<number, string> = { 0x0d7a: 'n', 0x0d7b: 'n', 0x0d7c: 'r', 0x0d7d: 'l', 0x0d7e: 'l', 0x0d7f: 'k' };

/** The script most of the text is written in, or null for Latin and everything else. */
export function scriptOf(text: string): IndicScript | null {
  const counts = new Map<IndicScript, number>();
  for (const ch of text) {
    const b = blockOf(ch.codePointAt(0)!);
    if (b) counts.set(b.script, (counts.get(b.script) ?? 0) + 1);
  }
  let best: IndicScript | null = null;
  let n = 0;
  for (const [s, c] of counts) if (c > n) { best = s; n = c; }
  return best;
}

export const hasIndic = (text: string) => [...text].some((ch) => blockOf(ch.codePointAt(0)!));

/** One word (no spaces) into English letters. */
function word(w: string): string {
  const cps = [...w.normalize('NFC')].map((c) => c.codePointAt(0)!);
  let out = '';
  let pendingConsonant: { text: string; script: IndicScript } | null = null;
  let sawVowel = false;
  const flush = (vowel: string | null, atEnd: boolean) => {
    if (!pendingConsonant) return;
    const { text, script } = pendingConsonant;
    pendingConsonant = null;
    if (vowel !== null) { out += text + vowel; sawVowel = true; return; }
    // Inherent vowel. Hindi-family words drop it at the end once the word already has a vowel.
    const drop = atEnd && sawVowel && DROPS_FINAL_A.includes(script);
    out += text + (drop ? '' : script === 'bengali' ? 'o' : 'a');
    sawVowel = true;
  };
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    const next = cps[i + 1];
    const b = blockOf(cp);
    if (!b) {
      if (CHILLU[cp]) { flush(null, false); out += CHILLU[cp]; continue; }
      flush(null, false);
      out += String.fromCodePoint(cp);
      continue;
    }
    const off = cp - b.base;
    const nextOff = next !== undefined && blockOf(next)?.base === b.base ? next - b.base : -1;
    if (CONSONANTS[off]) {
      flush(null, false);
      let c = CONSONANTS[off];
      if (off === 0x24 && !SOUTH.includes(b.script)) c = 't';
      if (off === 0x25 && !SOUTH.includes(b.script)) c = 'th';
      const afterCluster = i > 0 && cps[i - 1] - b.base === VIRAMA;
      // Tamil has no separate letters for ga/da/ba: between vowels or after a nasal the hard consonant softens.
      const softens = out && nextOff !== VIRAMA && (afterCluster ? /[nm]$/.test(out) : !/[kchtp]$/.test(out));
      if (b.script === 'tamil' && softens && (off === 0x15 || off === 0x1a || off === 0x1f || off === 0x24 || off === 0x2a)) c = { 0x15: 'g', 0x1a: 's', 0x1f: 'd', 0x24: 'dh', 0x2a: 'b' }[off]!;
      pendingConsonant = { text: c, script: b.script };
      continue;
    }
    if (off === VIRAMA) {
      // "ng" before a k/g sound is just the nasal: Shankar, thangam.
      if (pendingConsonant) { out += pendingConsonant.text === 'ng' && nextOff >= 0x15 && nextOff <= 0x18 ? 'n' : pendingConsonant.text; pendingConsonant = null; }
      continue;
    }
    if (off === 0x3c) continue; // nukta on its own: the base letter already said what it needed
    if (SIGNS[off]) { flush(SIGNS[off], false); continue; }
    if (VOWELS[off]) { flush(null, false); out += VOWELS[off]; sawVowel = true; continue; }
    if (off === 0x01 || off === 0x02) {
      flush(null, false);
      // Anusvara is "m" before a lip sound (sambhavam) and at the end of southern words (daivam), else "n".
      const atEnd = i === cps.length - 1;
      out += off === 0x02 && (LABIAL.has(nextOff) || (atEnd && SOUTH.includes(b.script))) ? 'm' : 'n';
      continue;
    }
    if (off === 0x03) { flush(null, false); out += 'h'; continue; }
    if (off >= 0x66 && off <= 0x6f) { flush(null, false); out += String(off - 0x66); continue; }
    if (off === 0x64 || off === 0x65) { flush(null, false); out += '.'; continue; }
    if (b.script === 'gurmukhi' && off === 0x70) { flush(null, false); out += 'n'; continue; } // tippi
    if (b.script === 'gurmukhi' && off === 0x71) { flush(null, false); if (CONSONANTS[nextOff]) out += CONSONANTS[nextOff][0]; continue; } // addak doubles the next letter
    if (off === 0x50) { flush(null, false); out += 'om'; continue; }
    // Length marks, abbreviation signs and anything else carry no sound of their own.
    flush(null, false);
  }
  flush(null, true);
  return out;
}

/** One line into English letters. Latin text, chords in [brackets] and punctuation pass through. */
export function transliterateLine(line: string): string {
  if (!hasIndic(line)) return line;
  const out = line.replace(/[^\s\[\]()]+/g, (w) => (hasIndic(w) ? word(w) : w));
  return out.replace(/^(\s*)([a-z])/, (_, s, c) => s + c.toUpperCase());
}

export const transliterateLines = (lines: string[]) => lines.map(transliterateLine);

/** Whole lyrics: section headings like [Chorus] and blank lines are kept as they are. */
export function transliterate(text: string): string {
  return text.split('\n').map((l) => (/^\s*\[.*\]\s*$/.test(l) ? l : transliterateLine(l))).join('\n');
}
