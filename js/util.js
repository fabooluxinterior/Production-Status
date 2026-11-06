// Shared constants and small helpers.

export const STATUSES = [
  'CHECKING AT R&D',
  'SENT BACK TO DESIGNER',
  'CHECKING AT FACTORY',
  'SENT BACK TO R&D',
  'FINAL SOD PENDING',
  'UNDER PRODUCTION',
  'DISPATCHED',
];
export const LABELS = {
  'CHECKING AT R&D': 'Checking at R&D',
  'SENT BACK TO DESIGNER': 'Sent Back to Designer',
  'CHECKING AT FACTORY': 'Checking at Factory',
  'SENT BACK TO R&D': 'Sent Back to R&D',
  'FINAL SOD PENDING': 'Final SOD Pending',
  'UNDER PRODUCTION': 'Under Production',
  'DISPATCHED': 'Dispatched',
};
export const ROLE_LABEL = { super_admin: 'Super Admin', admin: 'Admin', designer: 'Designer', dm: 'DM' };

export const ST_RND = 'CHECKING AT R&D';
export const ST_FACTORY = 'CHECKING AT FACTORY';
export const ST_PRODUCTION = 'UNDER PRODUCTION';
export const ST_DISPATCHED = 'DISPATCHED';

export const label = (s) => LABELS[s] || s;
export const statusIndex = (s) => STATUSES.indexOf(s);
export const nextStatus = (s) => {
  const i = STATUSES.indexOf(s);
  return i >= 0 && i < STATUSES.length - 1 ? STATUSES[i + 1] : null;
};
export const isDispatched = (p) => p.current_status === ST_DISPATCHED;

// ---------------------------------------------------------------- DOM
export function el(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'value') node.value = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

const ICONS = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
};
export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

// ---------------------------------------------------------------- dates (shown in the viewer's own timezone)
export function fmtDate(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
}
export function fmtTime(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

// ---------------------------------------------------------------- toast
let toastTimer;
export function toast(message, isError) {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = message;
  node.className = 'toast' + (isError ? ' err' : '');
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, isError ? 5500 : 3200);
}
