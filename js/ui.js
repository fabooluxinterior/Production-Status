// Reusable interface pieces: status tags, alert dots, modals, searchable dropdown, skeletons.
import { el, label, statusIndex } from './util.js';

// ---------------------------------------------------------------- tags & indicators
export function tag(status, big = false) {
  return el('span', { class: `tag s${statusIndex(status) + 1}${big ? ' big' : ''}`, text: label(status) });
}

// Small blinking dot. The label stays readable to screen readers, and becomes visible text
// when the person prefers reduced motion (the dot then simply stays on, not blinking).
export function blink(text) {
  return el('span', { class: 'blink', title: text },
    el('span', { class: 'blink-dot', 'aria-hidden': 'true' }),
    el('span', { class: 'blink-label', text }));
}

export function emptyState(title, text, action) {
  return el('div', { class: 'panel empty' }, el('h2', { text: title }), text ? el('p', { text }) : null, action || null);
}

export function skeletonList(n = 4) {
  return el('div', { class: 'list', 'aria-busy': 'true', 'aria-label': 'Loading' },
    Array.from({ length: n }, () => el('div', { class: 'card sk' },
      el('div', { class: 'skeleton line w40' }),
      el('div', { class: 'skeleton line w70' }))));
}

// Disable a button and show a spinner while an async action runs.
export async function busy(btn, fn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '';
  btn.append(el('span', { class: 'spinner small' }), original);
  try { return await fn(); }
  finally { btn.disabled = false; btn.textContent = original; }
}

// ---------------------------------------------------------------- modal
let openCount = 0;
export function openModal({ title, body, actions, wide = false }) {
  const opener = document.activeElement;
  let closed = false;
  let resolveClosed;
  const closedPromise = new Promise((r) => { resolveClosed = r; });

  const dialog = el('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    el('h2', { class: 'modal-title', text: title }),
    el('div', { class: 'modal-body' }, body),
    actions ? el('div', { class: 'modal-actions' }, actions) : null);
  const backdrop = el('div', { class: 'modal-backdrop' }, dialog);

  function close(result = false) {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    backdrop.classList.add('closing');
    setTimeout(() => backdrop.remove(), 170);
    if (--openCount <= 0) document.body.classList.remove('modal-open');
    if (opener && opener.focus && document.contains(opener)) opener.focus();
    resolveClosed(result);
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(false); return; }
    if (e.key !== 'Tab') return;
    const items = [...dialog.querySelectorAll('button, input, select, textarea, a[href]')].filter((n) => !n.disabled && n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(false); });
  document.addEventListener('keydown', onKey, true);
  openCount++;
  document.body.classList.add('modal-open');
  document.body.append(backdrop);
  requestAnimationFrame(() => {
    const first = dialog.querySelector('[data-autofocus]') || dialog.querySelector('input:not([disabled]), select:not([disabled]), button');
    if (first) first.focus();
  });
  return { close, dialog, closed: closedPromise };
}

export function confirmModal({ title, body, confirmText = 'Confirm', cancelText = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const ok = el('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), type: 'button', 'data-autofocus': true, text: confirmText, onclick: () => m.close(true) });
    const cancel = el('button', { class: 'btn ghost', type: 'button', text: cancelText, onclick: () => m.close(false) });
    const m = openModal({ title, body, actions: [cancel, ok] });
    m.closed.then(resolve);
  });
}

// Pick one of several options (used when a stage has more than one way forward).
export function chooseModal({ title, body, options, confirmText = 'Confirm update' }) {
  return new Promise((resolve) => {
    let chosen = null;
    const ok = el('button', { class: 'btn primary', type: 'button', text: confirmText, disabled: true, onclick: () => m.close(true) });
    const cancel = el('button', { class: 'btn ghost', type: 'button', text: 'Cancel', onclick: () => m.close(false) });
    const group = el('div', { class: 'choices', role: 'radiogroup', 'aria-label': title },
      options.map((o, i) => el('button', {
        type: 'button', role: 'radio', 'aria-checked': 'false', class: 'choice', 'data-autofocus': i === 0 ? true : false,
        onclick: (e) => {
          chosen = o.value;
          group.querySelectorAll('.choice').forEach((b) => { const on = b === e.currentTarget; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
          ok.disabled = false;
        },
      }, el('span', { class: 'choice-title', text: o.title }), el('span', { class: 'choice-desc', text: o.desc }))));
    const m = openModal({ title, body: [body, group], actions: [cancel, ok] });
    m.closed.then((done) => resolve(done ? chosen : null));
  });
}

// ---------------------------------------------------------------- searchable dropdown
// items: [{ id, name, email }]. Search by name or email. `value` is the chosen id (or null).
export function combo({ id, placeholder, emptyText, onChange }) {
  let items = [];
  let selected = null;
  let shown = [];
  let active = -1;

  const input = el('input', {
    id, class: 'input', type: 'text', role: 'combobox', autocomplete: 'off', placeholder,
    'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': `${id}-list`,
  });
  const list = el('ul', { class: 'combo-list', id: `${id}-list`, role: 'listbox', hidden: true });
  const wrap = el('div', { class: 'combo' }, input, el('span', { class: 'combo-caret', 'aria-hidden': 'true' }), list);

  const display = (it) => `${it.name} (${it.email})`;

  function open() { list.hidden = false; input.setAttribute('aria-expanded', 'true'); render(); }
  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
    if (selected) input.value = display(selected);
  }
  function choose(it) {
    selected = it;
    input.value = display(it);
    close();
    if (onChange) onChange(it);
  }
  function render() {
    const q = input.value.trim().toLowerCase();
    const filterText = selected && input.value === display(selected) ? '' : q;
    shown = items.filter((i) => !filterText || i.name.toLowerCase().includes(filterText) || i.email.toLowerCase().includes(filterText));
    if (!shown.length) {
      list.replaceChildren(el('li', { class: 'combo-empty', text: items.length ? 'No matches.' : emptyText }));
      return;
    }
    active = Math.min(Math.max(active, 0), shown.length - 1);
    list.replaceChildren(...shown.map((it, i) => el('li', {
      class: 'combo-item' + (i === active ? ' active' : '') + (selected && selected.id === it.id ? ' chosen' : ''),
      role: 'option', 'aria-selected': String(!!selected && selected.id === it.id),
      onmousedown: (e) => { e.preventDefault(); choose(it); },
      onmousemove: () => { if (active !== i) { active = i; markActive(); } },
    }, el('span', { class: 'ci-name', text: it.name }), el('span', { class: 'ci-email', text: it.email }))));
  }
  function markActive() {
    [...list.children].forEach((n, i) => n.classList && n.classList.toggle('active', i === active));
    const node = list.children[active];
    if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
  }

  input.addEventListener('focus', open);
  input.addEventListener('click', () => { if (list.hidden) open(); });
  input.addEventListener('input', () => {
    if (selected) { selected = null; if (onChange) onChange(null); }
    active = 0;
    if (list.hidden) open(); else render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) open(); else { active = Math.min(active + 1, shown.length - 1); markActive(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); markActive(); }
    else if (e.key === 'Enter' && !list.hidden && shown[active]) { e.preventDefault(); choose(shown[active]); }
    else if (e.key === 'Escape' && !list.hidden) { e.stopPropagation(); close(); }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));

  return {
    el: wrap,
    input,
    setItems(next) { items = next || []; if (!list.hidden) render(); },
    get value() { return selected ? selected.id : null; },
    get selected() { return selected; },
  };
}
