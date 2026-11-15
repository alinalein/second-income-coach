/**
 * Boundary: "No new npm dependency for language detection — DE/EN is a small
 * closed set, a hand-rolled heuristic suffices." Used to pick between the
 * DE/EN form of Story 1.3's three fixed texts (AC2); deliberately NOT used to
 * steer the model's own normal replies (AC3/AD-25 does that in
 * `src/agent/index.ts`'s `prompt` construction, where the model matches the
 * user's language itself).
 *
 * I/O matrix: "Ambiguous/very short message" (e.g. a single emoji or number)
 * -> "Detector defaults to English" — satisfied here by the fallback return
 * value when no German signal is found, with no special-casing needed.
 */

// Presence of an umlaut or ß is an unambiguous German signal on its own.
const GERMAN_CHARACTER_PATTERN = /[äöüÄÖÜß]/;

// A small closed set of common German function words/pronouns — enough to
// catch everyday German sentences that happen to use no umlaut/ß.
const GERMAN_STOPWORDS = new Set([
  'ich',
  'du',
  'er',
  'sie',
  'es',
  'wir',
  'ihr',
  'und',
  'oder',
  'aber',
  'nicht',
  'kein',
  'keine',
  'ist',
  'sind',
  'war',
  'bin',
  'bist',
  'habe',
  'hast',
  'hat',
  'haben',
  'wird',
  'werden',
  'der',
  'die',
  'das',
  'den',
  'dem',
  'des',
  'ein',
  'eine',
  'einen',
  'einem',
  'einer',
  'mit',
  'fuer',
  'auf',
  'von',
  'bei',
  'nach',
  'ueber',
  'unter',
  'durch',
  'wie',
  'was',
  'wer',
  'wo',
  'wann',
  'warum',
  'bitte',
  'danke',
  'hallo',
  'mich',
  'mir',
  'dich',
  'dir',
  'mein',
  'meine',
  'dein',
  'deine',
  'kann',
  'koennen',
  'will',
  'soll',
  'muss',
]);

/**
 * Deterministic DE/EN detector: umlaut/ß check first (unambiguous on its
 * own), then a German-stopword match against the message's lowercased
 * words; defaults to `'en'` when neither signal is present (including
 * empty/very short/non-alphabetic input — I/O matrix: "Ambiguous/very short
 * message"). The stopword path requires at least 2 *distinct* matches, not
 * just 1 — several of these words are common EN/DE homographs ("was",
 * "will", "war", "hat", "die", "den" are all ordinary English words too), so
 * a single hit is not a reliable German signal on its own.
 */
export function detectReplyLanguage(text: string): 'de' | 'en' {
  const trimmed = text.trim();
  if (!trimmed) return 'en';
  if (GERMAN_CHARACTER_PATTERN.test(trimmed)) return 'de';

  const words = trimmed.toLowerCase().match(/[a-zäöüß]+/g) ?? [];
  const matchedStopwords = new Set(words.filter((word) => GERMAN_STOPWORDS.has(word)));

  return matchedStopwords.size >= 2 ? 'de' : 'en';
}
