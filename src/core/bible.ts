// The 66 books, their chapter counts, and their names in the six app languages, so a reading plan
// can be built by chapter count and shown to each member in their own language. Pure data and
// string helpers; nothing here touches the database.
import type { LanguageCode } from './types.js';

export type BibleBook = { en: string; chapters: number; hi: string; ta: string; te: string; ml: string; kn: string; aliases?: string[] };

export const BOOKS: BibleBook[] = [
  { en: 'Genesis', chapters: 50, hi: 'उत्पत्ति', ta: 'ஆதியாகமம்', te: 'ఆదికాండము', ml: 'ഉല്പത്തി', kn: 'ಆದಿಕಾಂಡ' },
  { en: 'Exodus', chapters: 40, hi: 'निर्गमन', ta: 'யாத்திராகமம்', te: 'నిర్గమకాండము', ml: 'പുറപ്പാടു', kn: 'ವಿಮೋಚನಕಾಂಡ' },
  { en: 'Leviticus', chapters: 27, hi: 'लैव्यव्यवस्था', ta: 'லேவியராகமம்', te: 'లేవీయకాండము', ml: 'ലേവ്യപുസ്തകം', kn: 'ಯಾಜಕಕಾಂಡ' },
  { en: 'Numbers', chapters: 36, hi: 'गिनती', ta: 'எண்ணாகமம்', te: 'సంఖ్యాకాండము', ml: 'സംഖ്യാപുസ്തകം', kn: 'ಅರಣ್ಯಕಾಂಡ' },
  { en: 'Deuteronomy', chapters: 34, hi: 'व्यवस्थाविवरण', ta: 'உபாகமம்', te: 'ద్వితీయోపదేశకాండము', ml: 'ആവർത്തനപുസ്തകം', kn: 'ಧರ್ಮೋಪದೇಶಕಾಂಡ' },
  { en: 'Joshua', chapters: 24, hi: 'यहोशू', ta: 'யோசுவா', te: 'యెహోషువ', ml: 'യോശുവ', kn: 'ಯೆಹೋಶುವ' },
  { en: 'Judges', chapters: 21, hi: 'न्यायियों', ta: 'நியாயாதிபதிகள்', te: 'న్యాయాధిపతులు', ml: 'ന്യായാധിപന്മാർ', kn: 'ನ್ಯಾಯಸ್ಥಾಪಕರು' },
  { en: 'Ruth', chapters: 4, hi: 'रूत', ta: 'ரூத்', te: 'రూతు', ml: 'രൂത്ത്', kn: 'ರೂತಳು' },
  { en: '1 Samuel', chapters: 31, hi: '1 शमूएल', ta: '1 சாமுவேல்', te: '1 సమూయేలు', ml: '1 ശമൂവേൽ', kn: '1 ಸಮುವೇಲನು' },
  { en: '2 Samuel', chapters: 24, hi: '2 शमूएल', ta: '2 சாமுவேல்', te: '2 సమూయేలు', ml: '2 ശമൂവേൽ', kn: '2 ಸಮುವೇಲನು' },
  { en: '1 Kings', chapters: 22, hi: '1 राजा', ta: '1 இராஜாக்கள்', te: '1 రాజులు', ml: '1 രാജാക്കന്മാർ', kn: '1 ಅರಸುಗಳು' },
  { en: '2 Kings', chapters: 25, hi: '2 राजा', ta: '2 இராஜாக்கள்', te: '2 రాజులు', ml: '2 രാജാക്കന്മാർ', kn: '2 ಅರಸುಗಳು' },
  { en: '1 Chronicles', chapters: 29, hi: '1 इतिहास', ta: '1 நாளாகமம்', te: '1 దినవృత్తాంతములు', ml: '1 ദിനവൃത്താന്തം', kn: '1 ಪೂರ್ವಕಾಲವೃತ್ತಾಂತ' },
  { en: '2 Chronicles', chapters: 36, hi: '2 इतिहास', ta: '2 நாளாகமம்', te: '2 దినవృత్తాంతములు', ml: '2 ദിനവൃത്താന്തം', kn: '2 ಪೂರ್ವಕಾಲವೃತ್ತಾಂತ' },
  { en: 'Ezra', chapters: 10, hi: 'एज्रा', ta: 'எஸ்றா', te: 'ఎజ్రా', ml: 'എസ്രാ', kn: 'ಎಜ್ರ' },
  { en: 'Nehemiah', chapters: 13, hi: 'नहेम्याह', ta: 'நெகேமியா', te: 'నెహెమ్యా', ml: 'നെഹെമ്യാവു', kn: 'ನೆಹೆಮೀಯ' },
  { en: 'Esther', chapters: 10, hi: 'एस्तेर', ta: 'எஸ்தர்', te: 'ఎస్తేరు', ml: 'എസ്ഥേർ', kn: 'ಎಸ್ತೇರಳು' },
  { en: 'Job', chapters: 42, hi: 'अय्यूब', ta: 'யோபு', te: 'యోబు', ml: 'ഇയ്യോബ്', kn: 'ಯೋಬನು' },
  { en: 'Psalms', chapters: 150, hi: 'भजन संहिता', ta: 'சங்கீதம்', te: 'కీర్తనలు', ml: 'സങ്കീർത്തനങ്ങൾ', kn: 'ಕೀರ್ತನೆಗಳು', aliases: ['Psalm', 'Ps'] },
  { en: 'Proverbs', chapters: 31, hi: 'नीतिवचन', ta: 'நீதிமொழிகள்', te: 'సామెతలు', ml: 'സദൃശവാക്യങ്ങൾ', kn: 'ಜ್ಞಾನೋಕ್ತಿಗಳು' },
  { en: 'Ecclesiastes', chapters: 12, hi: 'सभोपदेशक', ta: 'பிரசங்கி', te: 'ప్రసంగి', ml: 'സഭാപ്രസംഗി', kn: 'ಪ್ರಸಂಗಿ' },
  { en: 'Song of Songs', chapters: 8, hi: 'श्रेष्ठगीत', ta: 'உன்னதப்பாட்டு', te: 'పరమగీతము', ml: 'ഉത്തമഗീതം', kn: 'ಪರಮಗೀತ', aliases: ['Song of Solomon', 'Songs'] },
  { en: 'Isaiah', chapters: 66, hi: 'यशायाह', ta: 'ஏசாயா', te: 'యెషయా', ml: 'യെശയ്യാ', kn: 'ಯೆಶಾಯ' },
  { en: 'Jeremiah', chapters: 52, hi: 'यिर्मयाह', ta: 'எரேமியா', te: 'యిర్మీయా', ml: 'യിരെമ്യാവു', kn: 'ಯೆರೆಮೀಯ' },
  { en: 'Lamentations', chapters: 5, hi: 'विलापगीत', ta: 'புலம்பல்', te: 'విలాపవాక్యములు', ml: 'വിലാപങ്ങൾ', kn: 'ಪ್ರಲಾಪಗಳು' },
  { en: 'Ezekiel', chapters: 48, hi: 'यहेजकेल', ta: 'எசேக்கியேல்', te: 'యెహెజ్కేలు', ml: 'യെഹെസ്കേൽ', kn: 'ಯೆಹೆಜ್ಕೇಲ' },
  { en: 'Daniel', chapters: 12, hi: 'दानिय्येल', ta: 'தானியேல்', te: 'దానియేలు', ml: 'ദാനീയേൽ', kn: 'ದಾನಿಯೇಲ' },
  { en: 'Hosea', chapters: 14, hi: 'होशे', ta: 'ஓசியா', te: 'హోషేయ', ml: 'ഹോശേയ', kn: 'ಹೋಶೇಯ' },
  { en: 'Joel', chapters: 3, hi: 'योएल', ta: 'யோவேல்', te: 'యోవేలు', ml: 'യോവേൽ', kn: 'ಯೋವೇಲ' },
  { en: 'Amos', chapters: 9, hi: 'आमोस', ta: 'ஆமோஸ்', te: 'ఆమోసు', ml: 'ആമോസ്', kn: 'ಆಮೋಸ' },
  { en: 'Obadiah', chapters: 1, hi: 'ओबद्याह', ta: 'ஒபதியா', te: 'ఓబద్యా', ml: 'ഓബദ്യാവു', kn: 'ಓಬದ್ಯ' },
  { en: 'Jonah', chapters: 4, hi: 'योना', ta: 'யோனா', te: 'యోనా', ml: 'യോനാ', kn: 'ಯೋನ' },
  { en: 'Micah', chapters: 7, hi: 'मीका', ta: 'மீகா', te: 'మీకా', ml: 'മീഖാ', kn: 'ಮೀಕ' },
  { en: 'Nahum', chapters: 3, hi: 'नहूम', ta: 'நாகூம்', te: 'నహూము', ml: 'നഹൂം', kn: 'ನಹೂಮ' },
  { en: 'Habakkuk', chapters: 3, hi: 'हबक्कूक', ta: 'ஆபகூக்', te: 'హబక్కూకు', ml: 'ഹബക്കൂക്', kn: 'ಹಬಕ್ಕೂಕ' },
  { en: 'Zephaniah', chapters: 3, hi: 'सपन्याह', ta: 'செப்பனியா', te: 'జెఫన్యా', ml: 'സെഫന്യാവു', kn: 'ಚೆಫನ್ಯ' },
  { en: 'Haggai', chapters: 2, hi: 'हाग्गै', ta: 'ஆகாய்', te: 'హగ్గయి', ml: 'ഹഗ്ഗായി', kn: 'ಹಗ್ಗಾಯ' },
  { en: 'Zechariah', chapters: 14, hi: 'जकर्याह', ta: 'சகரியா', te: 'జెకర్యా', ml: 'സെഖര്യാവു', kn: 'ಜೆಕರ್ಯ' },
  { en: 'Malachi', chapters: 4, hi: 'मलाकी', ta: 'மல்கியா', te: 'మలాకీ', ml: 'മലാഖി', kn: 'ಮಲಾಕಿ' },
  { en: 'Matthew', chapters: 28, hi: 'मत्ती', ta: 'மத்தேயு', te: 'మత్తయి', ml: 'മത്തായി', kn: 'ಮತ್ತಾಯ' },
  { en: 'Mark', chapters: 16, hi: 'मरकुस', ta: 'மாற்கு', te: 'మార్కు', ml: 'മർക്കൊസ്', kn: 'ಮಾರ್ಕ' },
  { en: 'Luke', chapters: 24, hi: 'लूका', ta: 'லூக்கா', te: 'లూకా', ml: 'ലൂക്കൊസ്', kn: 'ಲೂಕ' },
  { en: 'John', chapters: 21, hi: 'यूहन्ना', ta: 'யோவான்', te: 'యోహాను', ml: 'യോഹന്നാൻ', kn: 'ಯೋಹಾನ' },
  { en: 'Acts', chapters: 28, hi: 'प्रेरितों के काम', ta: 'அப்போஸ்தலர்', te: 'అపొస్తలుల కార్యములు', ml: 'അപ്പൊസ്തലപ്രവൃത്തികൾ', kn: 'ಅಪೊಸ್ತಲರ ಕೃತ್ಯಗಳು' },
  { en: 'Romans', chapters: 16, hi: 'रोमियों', ta: 'ரோமர்', te: 'రోమీయులకు', ml: 'റോമർ', kn: 'ರೋಮಾಪುರದವರಿಗೆ' },
  { en: '1 Corinthians', chapters: 16, hi: '1 कुरिन्थियों', ta: '1 கொரிந்தியர்', te: '1 కొరింథీయులకు', ml: '1 കൊരിന്ത്യർ', kn: '1 ಕೊರಿಂಥದವರಿಗೆ' },
  { en: '2 Corinthians', chapters: 13, hi: '2 कुरिन्थियों', ta: '2 கொரிந்தியர்', te: '2 కొరింథీయులకు', ml: '2 കൊരിന്ത്യർ', kn: '2 ಕೊರಿಂಥದವರಿಗೆ' },
  { en: 'Galatians', chapters: 6, hi: 'गलातियों', ta: 'கலாத்தியர்', te: 'గలతీయులకు', ml: 'ഗലാത്യർ', kn: 'ಗಲಾತ್ಯದವರಿಗೆ' },
  { en: 'Ephesians', chapters: 6, hi: 'इफिसियों', ta: 'எபேசியர்', te: 'ఎఫెసీయులకు', ml: 'എഫെസ്യർ', kn: 'ಎಫೆಸದವರಿಗೆ' },
  { en: 'Philippians', chapters: 4, hi: 'फिलिप्पियों', ta: 'பிலிப்பியர்', te: 'ఫిలిప్పీయులకు', ml: 'ഫിലിപ്പിയർ', kn: 'ಫಿಲಿಪ್ಪಿಯವರಿಗೆ' },
  { en: 'Colossians', chapters: 4, hi: 'कुलुस्सियों', ta: 'கொலோசெயர்', te: 'కొలొస్సయులకు', ml: 'കൊലൊസ്സ്യർ', kn: 'ಕೊಲೊಸ್ಸೆಯವರಿಗೆ' },
  { en: '1 Thessalonians', chapters: 5, hi: '1 थिस्सलुनीकियों', ta: '1 தெசலோனிக்கேயர்', te: '1 థెస్సలొనీకయులకు', ml: '1 തെസ്സലൊനീക്യർ', kn: '1 ಥೆಸಲೊನೀಕದವರಿಗೆ' },
  { en: '2 Thessalonians', chapters: 3, hi: '2 थिस्सलुनीकियों', ta: '2 தெசலோனிக்கேயர்', te: '2 థెస్సలొనీకయులకు', ml: '2 തെസ്സലൊനീക്യർ', kn: '2 ಥೆಸಲೊನೀಕದವರಿಗೆ' },
  { en: '1 Timothy', chapters: 6, hi: '1 तीमुथियुस', ta: '1 தீமோத்தேயு', te: '1 తిమోతికి', ml: '1 തിമൊഥെയൊസ്', kn: '1 ತಿಮೊಥೆಯನಿಗೆ' },
  { en: '2 Timothy', chapters: 4, hi: '2 तीमुथियुस', ta: '2 தீமோத்தேயு', te: '2 తిమోతికి', ml: '2 തിമൊഥെയൊസ്', kn: '2 ತಿಮೊಥೆಯನಿಗೆ' },
  { en: 'Titus', chapters: 3, hi: 'तीतुस', ta: 'தீத்து', te: 'తీతుకు', ml: 'തീത്തൊസ്', kn: 'ತೀತನಿಗೆ' },
  { en: 'Philemon', chapters: 1, hi: 'फिलेमोन', ta: 'பிலேமோன்', te: 'ఫిలేమోనుకు', ml: 'ഫിലേമോൻ', kn: 'ಫಿಲೆಮೋನನಿಗೆ' },
  { en: 'Hebrews', chapters: 13, hi: 'इब्रानियों', ta: 'எபிரெயர்', te: 'హెబ్రీయులకు', ml: 'എബ്രായർ', kn: 'ಇಬ್ರಿಯರಿಗೆ' },
  { en: 'James', chapters: 5, hi: 'याकूब', ta: 'யாக்கோபு', te: 'యాకోబు', ml: 'യാക്കോബ്', kn: 'ಯಾಕೋಬನು' },
  { en: '1 Peter', chapters: 5, hi: '1 पतरस', ta: '1 பேதுரு', te: '1 పేతురు', ml: '1 പത്രൊസ്', kn: '1 ಪೇತ್ರನು' },
  { en: '2 Peter', chapters: 3, hi: '2 पतरस', ta: '2 பேதுரு', te: '2 పేతురు', ml: '2 പത്രൊസ്', kn: '2 ಪೇತ್ರನು' },
  { en: '1 John', chapters: 5, hi: '1 यूहन्ना', ta: '1 யோவான்', te: '1 యోహాను', ml: '1 യോഹന്നാൻ', kn: '1 ಯೋಹಾನ' },
  { en: '2 John', chapters: 1, hi: '2 यूहन्ना', ta: '2 யோவான்', te: '2 యోహాను', ml: '2 യോഹന്നാൻ', kn: '2 ಯೋಹಾನ' },
  { en: '3 John', chapters: 1, hi: '3 यूहन्ना', ta: '3 யோவான்', te: '3 యోహాను', ml: '3 യോഹന്നാൻ', kn: '3 ಯೋಹಾನ' },
  { en: 'Jude', chapters: 1, hi: 'यहूदा', ta: 'யூதா', te: 'యూదా', ml: 'യൂദാ', kn: 'ಯೂದನು' },
  { en: 'Revelation', chapters: 22, hi: 'प्रकाशितवाक्य', ta: 'வெளிப்படுத்தல்', te: 'ప్రకటన గ్రంథము', ml: 'വെളിപ്പാടു', kn: 'ಪ್ರಕಟನೆ' },
];

const byName = new Map<string, BibleBook>();
for (const b of BOOKS) for (const n of [b.en, ...(b.aliases ?? [])]) byName.set(n.toLowerCase(), b);

/** A reference like "Genesis 1-3; Psalms 1" with each book name in the member's language. English is returned unchanged. */
export function localizeReading(ref: string, lang: LanguageCode): string {
  if (lang === 'en') return ref;
  return ref.split(';').map((part) => {
    const m = part.trim().match(/^(.+?)\s+(\d[\d\-–:,\s]*)$/);
    const book = m ? byName.get(m[1].trim().toLowerCase()) : byName.get(part.trim().toLowerCase());
    if (!book) return part.trim();
    return m ? `${book[lang]} ${m[2].trim()}` : book[lang];
  }).join('; ');
}

/** Spread a run of chapters over `days` days, consecutive chapters each day, written as "Genesis 1-3; Exodus 1". */
export function spreadChapters(books: BibleBook[], days: number): string[] {
  const chapters: { book: BibleBook; c: number }[] = [];
  for (const b of books) for (let c = 1; c <= b.chapters; c++) chapters.push({ book: b, c });
  const n = chapters.length;
  const out: string[] = [];
  for (let d = 0; d < days; d++) {
    const slice = chapters.slice(Math.floor((d * n) / days), Math.floor(((d + 1) * n) / days));
    const parts: string[] = [];
    let i = 0;
    while (i < slice.length) {
      let j = i;
      while (j + 1 < slice.length && slice[j + 1].book === slice[i].book) j++;
      const first = slice[i].c, last = slice[j].c;
      parts.push(first === last ? `${slice[i].book.en} ${first}` : `${slice[i].book.en} ${first}-${last}`);
      i = j + 1;
    }
    out.push(parts.join('; '));
  }
  return out;
}

export type ReadingTemplateId = 'bible365' | 'nt90' | 'gospels30' | 'psalms31' | 'custom';
export const READING_TEMPLATES: { id: ReadingTemplateId; name: string; days: number; description: string }[] = [
  { id: 'bible365', name: 'Whole Bible in a year', days: 365, description: 'Genesis to Revelation in order, three or four chapters a day.' },
  { id: 'nt90', name: 'New Testament in 90 days', days: 90, description: 'Matthew to Revelation, about three chapters a day.' },
  { id: 'gospels30', name: 'The Gospels in 30 days', days: 30, description: 'Matthew, Mark, Luke and John, three chapters a day. Good for Lent or a new-believers class.' },
  { id: 'psalms31', name: 'Psalms and Proverbs in a month', days: 31, description: 'Five psalms and the matching chapter of Proverbs each day.' },
  { id: 'custom', name: 'Your own plan', days: 0, description: 'Paste one day per line, for instance "Luke 1-2" or "Isaiah 53; Psalms 22".' },
];

const book = (en: string) => BOOKS.find((b) => b.en === en)!;
export function templateReadings(id: Exclude<ReadingTemplateId, 'custom'>): string[] {
  if (id === 'bible365') return spreadChapters(BOOKS, 365);
  if (id === 'nt90') return spreadChapters(BOOKS.slice(39), 90);
  if (id === 'gospels30') return spreadChapters(BOOKS.slice(39, 43), 30);
  const psalms = spreadChapters([book('Psalms')], 31);
  return psalms.map((p, i) => `${p}; Proverbs ${i + 1}`);
}
