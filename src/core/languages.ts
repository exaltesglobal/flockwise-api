// Languages a member can use the app in, and the office can be shown in. English is the source;
// every other language falls back to English for any string it does not have yet.

export type LanguageRegion = 'india' | 'asia' | 'world';

export type LanguageInfo = {
  code: string;
  /** The name in its own script, as shown in pickers. */
  label: string;
  /** The English name, for the office and for search. */
  english: string;
  locale: string;
  region: LanguageRegion;
  /** Right-to-left scripts (Urdu). */
  rtl?: boolean;
};

export const LANGUAGES = [
  { code: 'en', label: 'English', english: 'English', locale: 'en-IN', region: 'world' },
  // India: the most spoken, plus the North-East languages many churches use.
  { code: 'hi', label: 'हिन्दी', english: 'Hindi', locale: 'hi-IN', region: 'india' },
  { code: 'bn', label: 'বাংলা', english: 'Bengali', locale: 'bn-IN', region: 'india' },
  { code: 'mr', label: 'मराठी', english: 'Marathi', locale: 'mr-IN', region: 'india' },
  { code: 'te', label: 'తెలుగు', english: 'Telugu', locale: 'te-IN', region: 'india' },
  { code: 'ta', label: 'தமிழ்', english: 'Tamil', locale: 'ta-IN', region: 'india' },
  { code: 'gu', label: 'ગુજરાતી', english: 'Gujarati', locale: 'gu-IN', region: 'india' },
  { code: 'ur', label: 'اردو', english: 'Urdu', locale: 'ur-IN', region: 'india', rtl: true },
  { code: 'kn', label: 'ಕನ್ನಡ', english: 'Kannada', locale: 'kn-IN', region: 'india' },
  { code: 'or', label: 'ଓଡ଼ିଆ', english: 'Odia', locale: 'or-IN', region: 'india' },
  { code: 'ml', label: 'മലയാളം', english: 'Malayalam', locale: 'ml-IN', region: 'india' },
  { code: 'pa', label: 'ਪੰਜਾਬੀ', english: 'Punjabi', locale: 'pa-IN', region: 'india' },
  { code: 'as', label: 'অসমীয়া', english: 'Assamese', locale: 'as-IN', region: 'india' },
  { code: 'ne', label: 'नेपाली', english: 'Nepali', locale: 'ne-IN', region: 'india' },
  { code: 'kok', label: 'कोंकणी', english: 'Konkani', locale: 'kok-IN', region: 'india' },
  { code: 'lus', label: 'Mizo ṭawng', english: 'Mizo', locale: 'en-IN', region: 'india' },
  { code: 'kha', label: 'Ka ktien Khasi', english: 'Khasi', locale: 'en-IN', region: 'india' },
  // Asia
  { code: 'zh', label: '简体中文', english: 'Chinese (Simplified)', locale: 'zh-CN', region: 'asia' },
  { code: 'zh-Hant', label: '繁體中文', english: 'Chinese (Traditional)', locale: 'zh-TW', region: 'asia' },
  { code: 'ja', label: '日本語', english: 'Japanese', locale: 'ja-JP', region: 'asia' },
  { code: 'ko', label: '한국어', english: 'Korean', locale: 'ko-KR', region: 'asia' },
  { code: 'th', label: 'ไทย', english: 'Thai', locale: 'th-TH', region: 'asia' },
  { code: 'vi', label: 'Tiếng Việt', english: 'Vietnamese', locale: 'vi-VN', region: 'asia' },
  { code: 'id', label: 'Bahasa Indonesia', english: 'Indonesian', locale: 'id-ID', region: 'asia' },
  { code: 'ms', label: 'Bahasa Melayu', english: 'Malay', locale: 'ms-MY', region: 'asia' },
  { code: 'fil', label: 'Filipino', english: 'Filipino', locale: 'fil-PH', region: 'asia' },
  { code: 'my', label: 'မြန်မာ', english: 'Burmese', locale: 'my-MM', region: 'asia' },
  { code: 'km', label: 'ខ្មែរ', english: 'Khmer', locale: 'km-KH', region: 'asia' },
  { code: 'si', label: 'සිංහල', english: 'Sinhala', locale: 'si-LK', region: 'asia' },
  { code: 'lo', label: 'ລາວ', english: 'Lao', locale: 'lo-LA', region: 'asia' },
] as const satisfies readonly LanguageInfo[];

export type LanguageCode = (typeof LANGUAGES)[number]['code'];

const BY_CODE = new Map<string, LanguageInfo>(LANGUAGES.map((l) => [l.code, l]));

export const isLanguage = (v: unknown): v is LanguageCode => typeof v === 'string' && BY_CODE.has(v);
export const languageInfo = (code: string | null | undefined): LanguageInfo => BY_CODE.get(code ?? 'en') ?? LANGUAGES[0];
export const LANGUAGE_CODES = LANGUAGES.map((l) => l.code) as LanguageCode[];

/** Matches "telugu", "Telugu", "te" or "తెలుగు" to a code (for imports). */
export function languageFromText(text: string): LanguageCode | undefined {
  const t = text.trim().toLowerCase();
  return LANGUAGES.find((l) => l.code.toLowerCase() === t || l.english.toLowerCase() === t || l.label.toLowerCase() === t)?.code;
}
