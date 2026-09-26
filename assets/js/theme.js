/* =============================================================================
   theme.js — Dark/Light Theme Boot + Toggle
   -----------------------------------------------------------------------------
   - Persists theme to localStorage ("dark" | "light"), default = "dark"
   - Applies theme by toggling <html>.classList and [data-theme]
   - Keeps <meta name="color-scheme"> in sync
   - Keeps an accessible toggle button in sync (aria-pressed and label)
============================================================================= */
(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------
  const STORAGE_KEY = 'theme';              // localStorage key
  const DEFAULT_THEME = 'dark';             // required: start in dark
  const HTML_DARK_CLASS = 'dark';           // class used for dark styling
  const docEl = document.documentElement;

  // ---------------------------------------------------------------------------
  // Storage helpers
  // ---------------------------------------------------------------------------
  const getStoredTheme = () => {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
  };
  const storeTheme = (theme) => {
    try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* no-op */ }
  };

  // ---------------------------------------------------------------------------
  // UI sync
  // ---------------------------------------------------------------------------
  function updateToggleUI(theme) {
    const btn = document.getElementById('theme-toggle') ||
                document.querySelector('[data-theme-toggle]');
    if (!btn) return;
    const isDark = theme === 'dark';
    btn.setAttribute('aria-pressed', String(isDark));
    const labelDark  = btn.getAttribute('data-label-dark')  || 'Dark Theme';
    const labelLight = btn.getAttribute('data-label-light') || 'Light Theme';
    btn.textContent = isDark ? labelLight : labelDark; // show the *next* mode
  }

  function applyTheme(theme) {
    const isDark = theme === 'dark';
    docEl.classList.toggle(HTML_DARK_CLASS, isDark);
    docEl.setAttribute('data-theme', theme);
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute('content', isDark ? 'dark light' : 'light dark');
    updateToggleUI(theme);
  }

  const nextTheme = (current) => current === 'dark' ? 'light' : 'dark';

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  const initial = getStoredTheme() || DEFAULT_THEME;
  applyTheme(initial);

  // ---------------------------------------------------------------------------
  // Wire up toggle
  // ---------------------------------------------------------------------------
  const bind = () => {
    const btn = document.getElementById('theme-toggle') ||
                document.querySelector('[data-theme-toggle]');
    if (btn && !btn.__themeBound) {
      btn.addEventListener('click', () => {
        const current = docEl.classList.contains(HTML_DARK_CLASS) ? 'dark' : 'light';
        const t = nextTheme(current);
        applyTheme(t);
        storeTheme(t);
      });
      btn.__themeBound = true;
      updateToggleUI(initial);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();


