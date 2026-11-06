// "Login using your FabSketch email" spotlight for the Designer sign-in page.
// A dim layer covers the screen except the email box, which gets a glowing border and a pointer note.
// It disappears (with a fade) on the first click, tap or key press. Nothing is saved anywhere, so it
// shows again every time the page is opened or refreshed.
import { el } from './util.js';

let current = null;

export function hideAnnouncement(instant = false) {
  if (!current) return;
  const c = current;
  current = null;
  window.removeEventListener('pointerdown', c.dismiss, true);
  window.removeEventListener('keydown', c.dismiss, true);
  window.removeEventListener('resize', c.place);
  window.removeEventListener('scroll', c.place, true);
  cancelAnimationFrame(c.raf);
  if (instant) { c.ring.remove(); c.note.remove(); return; }
  c.ring.classList.add('out');
  c.note.classList.add('out');
  setTimeout(() => { c.ring.remove(); c.note.remove(); }, 450);
}

export function showAnnouncement(target, text) {
  hideAnnouncement(true);
  const ring = el('div', { class: 'spot-ring', 'aria-hidden': 'true' });
  const note = el('div', { class: 'spot-note', role: 'note' },
    el('span', { class: 'spot-arrow', 'aria-hidden': 'true' }),
    el('span', { class: 'spot-text', text }));
  document.body.append(ring, note);

  const place = () => {
    if (!target.isConnected) return;
    const r = target.getBoundingClientRect();
    const pad = 5;
    ring.style.left = `${r.left - pad}px`;
    ring.style.top = `${r.top - pad}px`;
    ring.style.width = `${r.width + pad * 2}px`;
    ring.style.height = `${r.height + pad * 2}px`;
    const vw = document.documentElement.clientWidth;
    const bw = note.offsetWidth;
    const left = Math.max(12, Math.min(r.left + r.width / 2 - bw / 2, vw - bw - 12));
    const below = r.bottom + 20 + note.offsetHeight < window.innerHeight;
    note.classList.toggle('above', !below);
    note.style.left = `${left}px`;
    note.style.top = `${below ? r.bottom + 20 : r.top - 20 - note.offsetHeight}px`;
    note.style.setProperty('--arrow-x', `${Math.max(16, Math.min(r.left + r.width / 2 - left, bw - 16))}px`);
  };
  const dismiss = () => hideAnnouncement();
  const c = { ring, note, place, dismiss, raf: 0 };
  current = c;

  // The page slides in when it opens, so keep following the field until it settles.
  const t0 = performance.now();
  const follow = () => { place(); if (performance.now() - t0 < 700 && current === c) c.raf = requestAnimationFrame(follow); };
  follow();

  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
  window.addEventListener('pointerdown', dismiss, true);   // any click or tap, anywhere
  window.addEventListener('keydown', dismiss, true);       // or starting to type
}
