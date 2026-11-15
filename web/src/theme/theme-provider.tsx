import * as React from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'second-income-coach:theme';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

function readStoredTheme(): Theme | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    // localStorage can throw (privacy mode, disabled storage, etc.) — treat as "no stored theme".
    return null;
  }
}

function applyThemeClass(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

/**
 * Light mode is the default theme (UX-DR1); the user's dark-mode choice
 * persists across reloads via `localStorage` (UX-DR2). No stored theme on
 * first load always renders light — the OS/browser color-scheme preference
 * is never consulted, per the I/O matrix ("First load, no stored theme" ->
 * "Renders light mode by default").
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<Theme>(() => readStoredTheme() ?? 'light');

  // The inline script in web/index.html already applies the persisted class
  // synchronously before first paint (avoiding a flash of light theme on
  // reload); this effect keeps the `dark` class in sync with in-app toggles.
  React.useEffect(() => {
    applyThemeClass(theme);
  }, [theme]);

  // No manual useCallback/useMemo here — React Compiler (reactCompilerPreset,
  // wired in vite.config.ts) memoizes this component tree automatically.
  function setTheme(next: Theme) {
    setThemeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Best-effort persistence only; an unavailable localStorage must never crash the app.
    }
  }

  function toggleTheme() {
    setThemeState((current) => {
      const next: Theme = current === 'dark' ? 'light' : 'dark';
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Best-effort persistence only.
      }
      return next;
    });
  }

  const value: ThemeContextValue = { theme, setTheme, toggleTheme };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = React.useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
