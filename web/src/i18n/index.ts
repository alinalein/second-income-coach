import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import commonEn from '../locales/en/common.json';
import commonDe from '../locales/de/common.json';
import chatEn from '../locales/en/chat.json';
import chatDe from '../locales/de/chat.json';
import intakeEn from '../locales/en/intake.json';
import intakeDe from '../locales/de/intake.json';
import ideasEn from '../locales/en/ideas.json';
import ideasDe from '../locales/de/ideas.json';
import settingsEn from '../locales/en/settings.json';
import settingsDe from '../locales/de/settings.json';
import planEn from '../locales/en/plan.json';
import planDe from '../locales/de/plan.json';
import sidebarEn from '../locales/en/sidebar.json';
import sidebarDe from '../locales/de/sidebar.json';
import qualityEn from '../locales/en/quality.json';
import qualityDe from '../locales/de/quality.json';

/**
 * AD-24: `react-i18next`, resources bundled statically (no HTTP backend —
 * Vite inlines the 4 JSON files at build time via `resolveJsonModule`), one
 * namespace per feature area (`common`, `chat`). `lng`/`fallbackLng` both
 * default to `'en'` — Story 5.4's settings screen is the only place this
 * changes later; until then every signed-in user sees English regardless of
 * browser locale, matching `user_settings.uiLanguage`'s own English default
 * (Story 1.2).
 *
 * Side-effect import only (`import './i18n'` in `main.tsx`) — `useTranslation()`
 * reads this module-level singleton instance, no `I18nextProvider` needed.
 */
void i18n.use(initReactI18next).init({
  resources: {
    en: { common: commonEn, chat: chatEn, intake: intakeEn, ideas: ideasEn, settings: settingsEn, plan: planEn, sidebar: sidebarEn, quality: qualityEn },
    de: { common: commonDe, chat: chatDe, intake: intakeDe, ideas: ideasDe, settings: settingsDe, plan: planDe, sidebar: sidebarDe, quality: qualityDe },
  },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
