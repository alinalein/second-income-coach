import { describe, expect, it } from 'vitest';
import commonEn from '../locales/en/common.json';
import commonDe from '../locales/de/common.json';
import chatEn from '../locales/en/chat.json';
import chatDe from '../locales/de/chat.json';
import intakeEn from '../locales/en/intake.json';
import intakeDe from '../locales/de/intake.json';
import settingsEn from '../locales/en/settings.json';
import settingsDe from '../locales/de/settings.json';
import sidebarEn from '../locales/en/sidebar.json';
import sidebarDe from '../locales/de/sidebar.json';

/** Recursively collects every leaf key path (e.g. `auth.signInTitle`) out of
 * a nested translation resource, so two resources can be compared by shape
 * alone, independent of their (necessarily different) translated values. */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];

  return Object.entries(value).flatMap(([key, nested]) =>
    keyPaths(nested, prefix ? `${prefix}.${key}` : key),
  );
}

// AC1/AC2: every user-facing string ships in both languages. Nothing else
// catches a key added to only one language's JSON file — this does,
// deterministically, without needing a running i18next instance.
describe('locale resources (AC1/AC2: EN/DE key parity)', () => {
  it.each([
    ['common', commonEn, commonDe],
    ['chat', chatEn, chatDe],
    ['intake', intakeEn, intakeDe],
    ['settings', settingsEn, settingsDe],
    ['sidebar', sidebarEn, sidebarDe],
  ] as const)('%s namespace: en and de define the same key set', (_namespace, en, de) => {
    expect(keyPaths(de).sort()).toEqual(keyPaths(en).sort());
  });
});
