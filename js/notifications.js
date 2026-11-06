// Attention notifications for Super Admin, Admin and Designers: store, bell + panel, acknowledge.
// The server decides who gets what; this file only shows and acknowledges.
import { data } from './data.js';
import { NOTE_TEXT, el, fmtDate, fmtTime, icon, toast } from './util.js';

const WATCHERS = ['super_admin', 'admin', 'designer'];
let items = [];
let known = new Set();     // ids already seen, so a new arrival can be announced once
let first = true;
const subs = new Set();

const emit = () => subs.forEach((f) => f());
export const onNotifs = (fn) => { subs.add(fn); return () => subs.delete(fn); };

export function resetNotifs() { items = []; known = new Set(); first = true; emit(); }

export const noteText = (n) => NOTE_TEXT[n.event] || n.event;
export const allNotifs = () => items;
// Still needs attention: not acknowledged by me, and the project is still at that stage.
export const isOpen = (n) => !n.acknowledged_at && !n.addressed;
export const openNotifs = () => items.filter(isOpen);
export const attentionFor = (projectPk) => items.find((n) => n.project === projectPk && isOpen(n)) || null;

export async function loadNotifs(role) {
  if (!WATCHERS.includes(role)) return;
  try {
    const next = await data.notifications();
    const fresh = next.filter((n) => !known.has(n.id) && isOpen(n));
    next.forEach((n) => known.add(n.id));
    items = next;
    if (!first && fresh.length) {
      toast(fresh.length === 1 ? `${fresh[0].project_id} · ${noteText(fresh[0])}` : `${fresh.length} new notifications`);
    }
    first = false;
    emit();
  } catch (e) { /* keep what is shown; the next live update retries */ }
}

export async function acknowledge(id) {
  const before = items;
  const now = new Date().toISOString();
  items = items.map((n) => (n.id === id ? { ...n, acknowledged_at: now } : n));
  emit();
  try { await data.ackNotification(id); }
  catch (e) { items = before; emit(); toast(`Could not acknowledge: ${e.message}`, true); }
}

export async function acknowledgeAll() {
  const before = items;
  const now = new Date().toISOString();
  items = items.map((n) => (n.acknowledged_at ? n : { ...n, acknowledged_at: now }));
  emit();
  try { await data.ackAll(); }
  catch (e) { items = before; emit(); toast(`Could not acknowledge: ${e.message}`, true); }
}

// ---------------------------------------------------------------- bell + panel
export function bell(role) {
  if (!WATCHERS.includes(role)) return null;
  const badge = el('span', { class: 'bell-badge', hidden: true });
  const btn = el('button', { class: 'icon-btn bell', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-label': 'Notifications' }, icon('bell'), badge);
  const wrap = el('div', { class: 'bell-wrap' }, btn);
  let panel = null;

  function sync() {
    const n = openNotifs().length;
    badge.hidden = n === 0;
    badge.textContent = n > 99 ? '99+' : String(n);
    btn.setAttribute('aria-label', n ? `Notifications, ${n} need attention` : 'Notifications');
    btn.classList.toggle('has', n > 0);
    if (panel) fill();
  }

  function row(n) {
    const open = isOpen(n);
    const state = n.acknowledged_at ? 'Acknowledged' : n.addressed ? 'Handled' : 'Needs attention';
    return el('li', { class: 'note-row' + (open ? ' open' : '') },
      el('span', { class: open ? 'blink-dot' : 'quiet-dot', 'aria-hidden': 'true' }),
      el('div', { class: 'note-main' },
        el('a', { class: 'note-pj', href: `#/project/${n.project}`, text: n.project_id, onclick: () => close() }),
        el('span', { class: 'note-name', text: n.project_name }),
        el('div', { class: 'note-what', text: noteText(n) }),
        el('div', { class: 'note-when', text: `${fmtDate(n.created_at)}, ${fmtTime(n.created_at)} · ${state}` })),
      open ? el('button', { class: 'btn small ghost', type: 'button', text: 'Acknowledge', onclick: () => acknowledge(n.id) }) : null);
  }

  function fill() {
    const list = allNotifs();
    const open = openNotifs().length;
    panel.replaceChildren(
      el('div', { class: 'note-head' },
        el('strong', { text: 'Notifications' }),
        open ? el('button', { class: 'linkbtn', type: 'button', text: 'Acknowledge all', onclick: acknowledgeAll }) : null),
      list.length
        ? el('ul', { class: 'note-list' }, list.map(row))
        : el('p', { class: 'note-empty', text: 'Nothing yet. You will be notified here when a project needs you.' }));
  }

  function onDoc(e) { if (!wrap.contains(e.target)) close(); }
  function onKey(e) { if (e.key === 'Escape') { close(); btn.focus(); } }
  function close() {
    if (!panel) return;
    const p = panel;
    panel = null;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onDoc);
    document.removeEventListener('keydown', onKey);
    p.classList.add('closing');
    setTimeout(() => p.remove(), 140);
  }
  function openPanel() {
    panel = el('div', { class: 'note-panel', role: 'dialog', 'aria-label': 'Notifications' });
    fill();
    wrap.append(panel);
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
  }
  btn.addEventListener('click', () => (panel ? close() : openPanel()));

  const off = onNotifs(() => { if (!wrap.isConnected) { off(); document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); return; } sync(); });
  sync();
  return wrap;
}
