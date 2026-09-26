/* =============================================================================
   zoom.js — open post images full size in an overlay; Esc, click, or the
   close button dismisses it. Without JS the link opens the image directly.
============================================================================= */
(() => {
  'use strict';

  let dialog;

  const build = () => {
    dialog = document.createElement('dialog');
    dialog.className = 'zoom-dialog';
    dialog.innerHTML = '<button type="button" class="zoom-close" aria-label="Close">×</button><img alt="">';
    dialog.addEventListener('click', () => dialog.close());
    document.body.appendChild(dialog);
  };

  document.addEventListener('click', (ev) => {
    const link = ev.target.closest('a.zoom');
    if (!link || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
    ev.preventDefault();
    if (!dialog) build();
    const img = dialog.querySelector('img');
    img.src = link.href;
    img.alt = link.querySelector('img')?.alt || '';
    dialog.showModal();
  });
})();
