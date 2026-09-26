/* =============================================================================
   copy.js — click-to-copy for [data-copy] buttons (e.g. the Discord username)
============================================================================= */
(() => {
  'use strict';

  const FLASH_MS = 1400;

  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-copy]');
    if (!btn) return;
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
    } catch {
      return;
    }
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), FLASH_MS);
  });
})();
