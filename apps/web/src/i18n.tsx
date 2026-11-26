import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/*
 * UI language (English / Tiếng Việt) and theme (system / light / dark), kept in this browser (localStorage).
 *
 * Messages live next to the component that uses them:
 *   const M = defineMessages({ title: ['Projects', 'Dự án'], count: ['{n} projects', '{n} dự án'] });
 *   const t = useT(M);  t('title');  t('count', { n: 3 })
 * Keys are type-checked; every message has both languages. Server error messages stay in English.
 */

export type Lang = 'en' | 'vi';
export type Theme = 'system' | 'light' | 'dark';
export type Messages<K extends string = string> = Record<K, readonly [en: string, vi: string]>;

export function defineMessages<K extends string>(m: Messages<K>): Messages<K> {
  return m;
}

const LANG_KEY = 'sss-lang';
const THEME_KEY = 'sss-theme';

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* storage unavailable */
  }
}

/** Initial language: saved choice, else Vietnamese when the browser prefers it. */
function initialLang(): Lang {
  const fallback: Lang = typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('vi') ? 'vi' : 'en';
  return read<Lang>(LANG_KEY, ['en', 'vi'], fallback);
}

let currentLang: Lang = initialLang();
/** Locale for dates and numbers in plain helpers (fmtTime, fmtNum). */
export function currentLocale(): string {
  return currentLang === 'vi' ? 'vi-VN' : 'en-US';
}
export function getLang(): Lang {
  return currentLang;
}

/** Apply the theme to <html> (call before the first render to avoid a flash). */
export function applyTheme(t: Theme): void {
  const root = document.documentElement;
  if (t === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
}
export function initialTheme(): Theme {
  return read<Theme>(THEME_KEY, ['system', 'light', 'dark'], 'system');
}

interface Prefs {
  lang: Lang;
  setLang: (l: Lang) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
}
const PrefsContext = createContext<Prefs>({ lang: 'en', setLang: () => {}, theme: 'system', setTheme: () => {} });

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(currentLang);
  const [theme, setThemeState] = useState<Theme>(initialTheme);
  useEffect(() => {
    currentLang = lang;
    document.documentElement.lang = lang;
  }, [lang]);
  useEffect(() => applyTheme(theme), [theme]);
  const setLang = useCallback((l: Lang) => {
    currentLang = l;
    write(LANG_KEY, l);
    setLangState(l);
  }, []);
  const setTheme = useCallback((t: Theme) => {
    write(THEME_KEY, t);
    setThemeState(t);
  }, []);
  const value = useMemo(() => ({ lang, setLang, theme, setTheme }), [lang, setLang, theme, setTheme]);
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs(): Prefs {
  return useContext(PrefsContext);
}

export type TFn<K extends string> = (key: K, vars?: Record<string, string | number>) => string;

/** Translate with the current language; `{name}` placeholders are filled from `vars`. */
export function useT<K extends string>(m: Messages<K>): TFn<K> {
  const { lang } = usePrefs();
  return useCallback(
    (key: K, vars?: Record<string, string | number>) => {
      const pair = m[key];
      let s = pair ? pair[lang === 'vi' ? 1 : 0] : key;
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
      return s;
    },
    [m, lang],
  );
}
