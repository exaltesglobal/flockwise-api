// Bible passages for the projector: the operator types a reference ("John 3:16-18", "Ps 23") and
// gets the verses in a public-domain English translation (King James or World English Bible).
// Indian-language Bibles are still under copyright, so for those the operator pastes the words.
// Looks the passage up online (bible-api.com); a few well-loved passages are built in for offline use.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { BiblePassage } from '../types.js';

export const TRANSLATIONS = { kjv: 'King James Version', web: 'World English Bible' } as const;
export type Translation = keyof typeof TRANSLATIONS;

/** King James Version (public domain), for when the server is offline or in the demo. */
const BUILT_IN: Record<string, { reference: string; verses: [number, string][] }> = {
  'john 3:16-17': { reference: 'John 3:16-17', verses: [[16, 'For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.'], [17, 'For God sent not his Son into the world to condemn the world; but that the world through him might be saved.']] },
  'john 3:16': { reference: 'John 3:16', verses: [[16, 'For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.']] },
  'psalms 23': { reference: 'Psalms 23', verses: [[1, 'The LORD is my shepherd; I shall not want.'], [2, 'He maketh me to lie down in green pastures: he leadeth me beside the still waters.'], [3, 'He restoreth my soul: he leadeth me in the paths of righteousness for his name’s sake.'], [4, 'Yea, though I walk through the valley of the shadow of death, I will fear no evil: for thou art with me; thy rod and thy staff they comfort me.'], [5, 'Thou preparest a table before me in the presence of mine enemies: thou anointest my head with oil; my cup runneth over.'], [6, 'Surely goodness and mercy shall follow me all the days of my life: and I will dwell in the house of the LORD for ever.']] },
  'romans 8:28': { reference: 'Romans 8:28', verses: [[28, 'And we know that all things work together for good to them that love God, to them who are the called according to his purpose.']] },
  'philippians 4:13': { reference: 'Philippians 4:13', verses: [[13, 'I can do all things through Christ which strengtheneth me.']] },
  'jeremiah 29:11': { reference: 'Jeremiah 29:11', verses: [[11, 'For I know the thoughts that I think toward you, saith the LORD, thoughts of peace, and not of evil, to give you an expected end.']] },
  'matthew 11:28-30': { reference: 'Matthew 11:28-30', verses: [[28, 'Come unto me, all ye that labour and are heavy laden, and I will give you rest.'], [29, 'Take my yoke upon you, and learn of me; for I am meek and lowly in heart: and ye shall find rest unto your souls.'], [30, 'For my yoke is easy, and my burden is light.']] },
};

const ALIASES: Record<string, string> = { ps: 'psalms', psa: 'psalms', psalm: 'psalms', jn: 'john', jhn: 'john', rom: 'romans', phil: 'philippians', php: 'philippians', jer: 'jeremiah', mt: 'matthew', matt: 'matthew', gen: 'genesis', ex: 'exodus', isa: 'isaiah', prov: 'proverbs', pr: 'proverbs', rev: 'revelation', heb: 'hebrews', eph: 'ephesians', col: 'colossians', gal: 'galatians', lk: 'luke', mk: 'mark', acts: 'acts', '1cor': '1 corinthians', '2cor': '2 corinthians' };

/** "Ps 23", "jn 3:16–17" → "psalms 23", "john 3:16-17". */
export function tidyReference(ref: string): string {
  const t = ref.replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
  const m = /^([1-3]?\s?[a-z]+)\.?\s*(\d.*)?$/.exec(t);
  if (!m) return t;
  const book = m[1].replace(/\s/g, '');
  return `${ALIASES[book] ?? m[1]}${m[2] ? ` ${m[2].replace(/\s/g, '')}` : ''}`;
}

export async function lookupPassage(ctx: Ctx, ref: string, translation: Translation = 'kjv'): Promise<BiblePassage> {
  const wanted = tidyReference(ref);
  if (!/\d/.test(wanted)) throw new ApiError(422, 'invalid', 'Type a reference like John 3:16 or Psalm 23.', { ref: 'Book, chapter and verse' });
  const built = BUILT_IN[wanted];
  if ((ctx.env.demo || !ctx.env.http) && built && translation === 'kjv') return { reference: built.reference, translation: TRANSLATIONS.kjv, verses: built.verses.map(([verse, text]) => ({ verse, text })) };
  if (!ctx.env.http || ctx.env.demo) throw new ApiError(422, 'offline', 'This passage is not available offline. Paste the words under Text instead.');
  const r = await ctx.env.http({ method: 'GET', url: `https://bible-api.com/${encodeURIComponent(wanted)}?translation=${translation}`, timeoutMs: 8000 }).catch(() => null);
  if (!r || r.status >= 500) {
    if (built && translation === 'kjv') return { reference: built.reference, translation: TRANSLATIONS.kjv, verses: built.verses.map(([verse, text]) => ({ verse, text })) };
    throw new ApiError(502, 'bible_unreachable', 'Could not reach the Bible service. Try again, or paste the words under Text.');
  }
  if (r.status === 404) throw new ApiError(404, 'not_found', `Could not find ${ref}. Check the book, chapter and verse.`);
  const data = JSON.parse(r.text) as { reference?: string; verses?: { verse: number; text: string }[] };
  const verses = (data.verses ?? []).slice(0, 60).map((v) => ({ verse: Number(v.verse), text: String(v.text).replace(/\s+/g, ' ').trim() })).filter((v) => v.text);
  if (!verses.length) throw new ApiError(404, 'not_found', `Could not find ${ref}. Check the book, chapter and verse.`);
  return { reference: data.reference ?? ref, translation: TRANSLATIONS[translation], verses };
}

/** One verse per paragraph, so each verse gets its own slide. */
export const passageText = (p: BiblePassage) => p.verses.map((v) => `${v.verse} ${v.text}`).join('\n\n');

export function registerBible(r: Router) {
  r.get('/admin/bible', { staff: true }, (ctx) => {
    const tr = String(ctx.query.tr ?? 'kjv') as Translation;
    return lookupPassage(ctx, String(ctx.query.ref ?? ''), tr in TRANSLATIONS ? tr : 'kjv');
  });
}
