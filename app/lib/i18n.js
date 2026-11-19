// Minimal i18n: flat dictionaries per locale, {placeholders}, English fallback.
import en from '../locales/en.js';
import de from '../locales/de.js';

export const LOCALES = { en, de };
export const LOCALE_NAMES = { en: 'English', de: 'Deutsch' };
export const DEFAULT_LOCALE = LOCALES[process.env.DEFAULT_LOCALE] ? process.env.DEFAULT_LOCALE : 'en';

export const isLocale = (l) => Object.hasOwn(LOCALES, l);

export function translate(locale, key, vars) {
  let s = LOCALES[locale]?.[key] ?? LOCALES.en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
  return s;
}

export const translator = (locale) => {
  const t = (key, vars) => translate(locale, key, vars);
  t.locale = locale;
  return t;
};

// Pick the best supported locale from an Accept-Language header
export function fromAcceptLanguage(header = '') {
  for (const part of String(header).split(',')) {
    const tag = part.split(';')[0].trim().toLowerCase().slice(0, 2);
    if (isLocale(tag)) return tag;
  }
  return DEFAULT_LOCALE;
}

// Subset of keys sent to browser scripts (prefix match)
export function clientStrings(locale, prefix) {
  const out = {};
  for (const k of Object.keys(LOCALES.en)) if (k.startsWith(prefix)) out[k] = translate(locale, k);
  return out;
}

// Locale-aware date helpers
const TZ = process.env.TIMEZONE || 'Europe/Berlin';
const BCP47 = { en: 'en-GB', de: 'de-DE' };

export function relTime(locale, sqlDate, now = new Date()) {
  if (!sqlDate) return '';
  const t = translator(locale);
  const d = new Date(sqlDate.includes('T') ? sqlDate : sqlDate.replace(' ', 'T') + 'Z');
  const diff = (now - d) / 1000;
  const loc = BCP47[locale] || 'en-GB';
  const hm = d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit', timeZone: TZ });
  const day = (x) => x.toLocaleDateString(loc, { timeZone: TZ });
  if (diff < 60) return t('time.justNow');
  if (diff < 3600) return t('time.minutesAgo', { n: Math.floor(diff / 60) });
  if (day(d) === day(now)) return t('time.today', { time: hm });
  if (day(d) === day(new Date(now - 864e5))) return t('time.yesterday', { time: hm });
  return `${day(d)} ${hm}`;
}
