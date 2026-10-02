/* -------------------------------------------------------------------------
   toc.js - Mark the section the reader is in

   Author: Alex Freidah

   Highlights the rail entry for whichever section is currently on screen.
   Driven by IntersectionObserver rather than a scroll handler, so nothing
   runs between scroll events.

   The observer's rootMargin pins attention to a band near the top of the
   viewport: a heading becomes current once it reaches that band, and stays
   current until the next one does. Without the negative bottom margin every
   heading on a tall screen is intersecting at once and the last one wins,
   which reads as the rail jumping ahead of the reader.
   ------------------------------------------------------------------------- */
(() => {
  'use strict';

  const rail = document.querySelector('.rail-toc');
  if (!rail || !('IntersectionObserver' in window)) return;

  // Rail entries, by the id they point at.
  const links = new Map();
  rail.querySelectorAll('a[href^="#"]').forEach((a) => {
    const id = decodeURIComponent(a.getAttribute('href').slice(1));
    if (id) links.set(id, a);
  });
  if (!links.size) return;

  const headings = [...links.keys()]
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  if (!headings.length) return;

  // A rail entry may point at a collapsed card, where scrolling to it shows
  // only the title it was clicked from. Opening it first also means the browser
  // scrolls to the card at its full height rather than jumping again as it
  // expands. Harmless where the target is an ordinary heading.
  rail.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    const target = document.getElementById(decodeURIComponent(a.getAttribute('href').slice(1)));
    const card = target?.closest('details');
    if (card) card.open = true;
  });

  let current = null;

  const mark = (id) => {
    if (id === current) return;
    if (current) links.get(current)?.classList.remove('is-current');
    current = id;
    const a = links.get(id);
    if (!a) return;
    a.classList.add('is-current');
    // Keep the marked entry visible when the rail is taller than its column.
    if (rail.scrollHeight > rail.clientHeight) {
      const top = a.offsetTop - rail.clientHeight / 2;
      rail.scrollTo({ top, behavior: 'smooth' });
    }
  };

  // Headings currently inside the attention band, in document order.
  const visible = new Set();

  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target.id);
        else visible.delete(e.target.id);
      }

      if (visible.size) {
        for (const h of headings) {
          if (visible.has(h.id)) { mark(h.id); break; }
        }
        return;
      }

      // Nothing in the band: between two headings, so the current section is
      // the last one scrolled past. At the very top, none of them.
      let last = null;
      for (const h of headings) {
        if (h.getBoundingClientRect().top < 0) last = h.id;
        else break;
      }
      if (last) mark(last);
    },
    { rootMargin: '0px 0px -70% 0px', threshold: 0 },
  );

  headings.forEach((h) => observer.observe(h));
})();
