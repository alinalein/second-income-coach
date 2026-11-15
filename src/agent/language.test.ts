import { describe, expect, it } from 'vitest';
import { detectReplyLanguage } from './language.js';

// AC3 / I/O matrix: "German message" -> detector picks 'de'; "English
// message" -> 'en'; "Ambiguous/very short message" (emoji/number) -> defaults
// to 'en'. Table-driven per CLAUDE.md — one test, every branch of the
// heuristic (umlaut/ß, German stopword without umlaut, plain English,
// empty/non-alphabetic input).
describe('detectReplyLanguage (AC3: deterministic DE/EN detector)', () => {
  it.each([
    ['German text with an umlaut', 'Können Sie mir helfen, ein Nebeneinkommen aufzubauen?', 'de'],
    ['German text with no umlaut/ß, matched via stopwords', 'Ich bin bereit und will heute anfangen', 'de'],
    ['plain English text', 'I would like to start a side business this month', 'en'],
    ['English sentence with a single EN/DE homograph stopword ("was")', 'What was the issue?', 'en'],
    ['English sentence with a single EN/DE homograph stopword ("will")', 'I will try that', 'en'],
    ['English sentence with a single EN/DE homograph stopword ("hat")', 'I like this hat', 'en'],
    ['a single emoji (ambiguous/very short)', '😀', 'en'],
    ['a bare number (ambiguous/very short)', '42', 'en'],
    ['an empty string', '', 'en'],
  ] as const)('%s -> %j', (_label, text, expected) => {
    expect(detectReplyLanguage(text)).toBe(expected);
  });
});
