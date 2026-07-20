// ─────────────────────────────────────────────
// i18n setup — Magpie (extensible to any language)
// ─────────────────────────────────────────────
// Architecture:
//   - react-i18next for the React sidepanel (TSX components)
//   - Shared message keys also usable from the service worker via i18n.t()
//   - Locale files lazy-loaded per language (en shipped, fi ready)
//   - chrome.i18n.getUILanguage() as the default; Settings override via
//     'magpie-ui-language' storage key
//
// Adding a language: drop a JSON file in ./locales/{lng}.json with the same
// keys as en.json — react-i18next picks it up automatically.

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';

// Detect preferred language: settings override > browser UI language > 'en'
function detectLanguage(): string {
  try {
    const stored = localStorage.getItem('magpie-ui-language');
    if (stored) return stored;
  } catch { /* private mode */ }
  try { return chrome.i18n?.getUILanguage?.()?.split('-')[0] || 'en'; }
  catch { return 'en'; }
}

i18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: detectLanguage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  // No suspense: sidepanel mounts synchronously (en is bundled).
  react: { useSuspense: false },
});

export default i18n;
