// Indian-script lyrics into English letters for the projector.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';
import { hasIndic, scriptOf, transliterate, transliterateLine } from '../src/core/transliterate.js';

test('each script comes out the way song sheets write it', () => {
  const cases: [string, string][] = [
    ['యేసు నన్ను ప్రేమించెను', 'Yesu nannu preminchenu'],
    ['స్తుతి స్తుతి యేసయ్యా', 'Sthuthi sthuthi yesayyaa'],
    ['यीशु मसीह प्रभु है', 'Yeeshu maseeh prabhu hai'],
    ['प्रेम करो एक दूसरे से', 'Prem karo ek doosare se'],
    ['मैं तुझे प्रणाम', 'Main tujhe pranaam'],
    ['அன்பு பாடல்', 'Anbu paadal'],
    ['இயேசு கிறிஸ்து', 'Iyesu kiristhu'],
    ['அம்மா அப்பா', 'Ammaa appaa'],
    ['അദ്ഭുത ദൈവം', 'Adbhutha daivam'],
    ['ಯೇಸು ನನ್ನ ಕರ್ತನು', 'Yesu nanna karthanu'],
    ['ਵਾਹਿਗੁਰੂ ਸਤਿਨਾਮ', 'Vaahiguroo satinaam'],
    ['যীশু আমার প্রভু', 'Yeeshu aamaar probhu'],
    ['ઈસુ મારો પ્રભુ', 'Eesu maaro prabhu'],
    ['हल्लेलूयाह १२३', 'Hallelooyaah 123'],
  ];
  for (const [input, want] of cases) assert.equal(transliterateLine(input), want, input);
});

test('Latin text, chords and section headings pass through untouched', () => {
  assert.equal(transliterateLine('Amazing grace [G] how sweet'), 'Amazing grace [G] how sweet');
  assert.equal(transliterate('[Chorus]\nయేసు [G]నన్ను\n\nAmen'), '[Chorus]\nYesu [G]nannu\n\nAmen');
  assert.equal(hasIndic('hello'), false);
  assert.equal(scriptOf('hello'), null);
  assert.equal(scriptOf('hello యేసు'), 'telugu');
});

test('the projector adds English letters under Indian-script lines when the theme asks', async () => {
  const env = createDemoEnv({ now: () => new Date('2026-10-22T05:00:00.000Z') });
  const db = new Db();
  seedDemo(db, env);
  const engine = createChurchEngine(db, env);
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email: 'pastor@gracechurch.in', audience: 'admin' }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  const owner = JSON.parse(atob(s.accessToken.slice(5)));
  const call = (method: string, path: string, body?: unknown) => engine.handle({ method, path, body, auth: owner }) as Promise<any>;

  const song = await call('POST', '/admin/songs', { title: 'Yesu nannu', author: '', defaultKey: 'G', bpm: null, ccli: '', tags: [], lyrics: 'Verse 1\nయేసు నన్ను ప్రేమించెను\nనా పాపము క్షమించెను', lyricsAlt: '', chordChart: '', attachments: [] });
  const { plan } = await call('GET', '/admin/services/ev_7');
  await call('PUT', '/admin/services/ev_7', { ...plan, items: [{ ...plan.items.find((i: any) => i.kind === 'song'), songId: song.id, title: song.title }] });

  const off = await call('GET', '/admin/services/ev_7/presentation');
  const lyric = off.slides.find((x: any) => x.kind === 'lyrics');
  assert.deepEqual(lyric.roman, []);

  await call('PUT', '/admin/presentation-theme', { transliterate: true });
  const on = await call('GET', '/admin/services/ev_7/presentation');
  const slide = on.slides.find((x: any) => x.kind === 'lyrics');
  assert.deepEqual(slide.roman, ['Yesu nannu preminchenu', 'Naa paapamu kshaminchenu']);
});
