// Shared application state, page shell (header/nav), theme handling, live updates, logout.
import { el, icon, initials, toast, ROLE_LABEL } from './util.js';
import { data, startRealtime, stopRealtime } from './data.js';
import { bell, loadNotifs, resetNotifs } from './notifications.js';

export const root = document.getElementById('app');

export const state = {
  user: null,
  projects: [],
  loaded: false,
  filters: { q: '', status: '', pid: '', name: '', attn: false },
  tab: 'active',
  detail: null,
  saving: 0,        // > 0 while a status change is being saved (live refreshes wait)
  refresh: null,    // set by the current page; called when something changes
  returnTo: '',
};

export function resetState() {
  Object.assign(state, {
    user: null, projects: [], loaded: false, detail: null, saving: 0, refresh: null,
    filters: { q: '', status: '', pid: '', name: '', attn: false }, tab: 'active',
  });
  resetNotifs();
}

export function go(hash) {
  if (location.hash === hash) window.dispatchEvent(new Event('hashchange'));
  else location.hash = hash;
}

// ---------------------------------------------------------------- theme
export const currentTheme = () => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

export function applyTheme(theme, animate = false) {
  const html = document.documentElement;
  if (animate) {
    html.classList.add('theme-anim');
    setTimeout(() => html.classList.remove('theme-anim'), 400);
  }
  html.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
  try { localStorage.setItem('fbx_theme', currentTheme()); } catch (e) { /* storage unavailable */ }
  document.dispatchEvent(new Event('themechange'));
}

export async function setTheme(theme) {
  applyTheme(theme, true);
  if (state.user) {
    try { await data.setTheme(theme); } catch (e) { toast('Theme changed here, but could not be saved to your account.', true); }
  }
}

export function themeButton() {
  const btn = el('button', { class: 'icon-btn', type: 'button' });
  const sync = () => {
    const dark = currentTheme() === 'dark';
    btn.replaceChildren(icon(dark ? 'sun' : 'moon'));
    btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    btn.title = dark ? 'Light theme' : 'Dark theme';
  };
  btn.addEventListener('click', () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
  document.addEventListener('themechange', sync);
  sync();
  return btn;
}

// ---------------------------------------------------------------- shell
export function shell(active, ...content) {
  const u = state.user;
  const links = [['dashboard', 'Dashboard', '#/'], ['projects', 'Projects', '#/projects']];
  if (u.role === 'super_admin') links.push(['users', 'Users', '#/users']);

  const header = el('header', { class: 'app-header' },
    el('div', { class: 'header-inner' },
      el('a', { class: 'brand', href: '#/', 'aria-label': 'Faboolux Interiors, dashboard' },
        el('img', { src: 'logo.webp', alt: 'Faboolux Interiors' })),
      el('nav', { class: 'nav', 'aria-label': 'Main' },
        links.map(([key, text, href]) => el('a', { href, class: key === active ? 'active' : '', 'aria-current': key === active ? 'page' : false, text }))),
      el('div', { class: 'header-right' },
        bell(u.role),
        themeButton(),
        el('a', { class: 'profile-chip', href: '#/profile', title: 'Your profile' },
          el('span', { class: 'avatar', 'aria-hidden': 'true', text: initials(u.name) }),
          el('span', { class: 'pc-text' },
            el('span', { class: 'pc-name', text: u.name }),
            el('span', { class: 'pc-role', text: ROLE_LABEL[u.role] }))),
        el('button', { class: 'btn ghost small', type: 'button', text: 'Logout', onclick: () => logout() }))));

  const page = el('div', { class: 'page' }, ...content);
  root.replaceChildren(header, el('main', { class: 'page-wrap' }, page));
  window.scrollTo(0, 0);
  return page;
}

// ---------------------------------------------------------------- live updates
let liveStarted = false;
let pingTimer;
let pollTimer;
let visibilityBound = false;
async function selfCheck() {
  try {
    const p = await data.profile();
    if (!p || !p.is_active || !p.session_valid) return logout('Your access has ended. Please sign in again.');
    if (p.must_change_password !== state.user.must_change_password) {
      state.user = p;
      window.dispatchEvent(new Event('hashchange'));
    }
  } catch (e) { /* network hiccup: try again at the next check */ }
}

export function startLive() {
  if (state.user && !liveStarted) { liveStarted = true; loadNotifs(state.user.role); }
  startRealtime((kind, payload) => {
    if (state.user && (kind === 'notifications' || kind === 'projects')) loadNotifs(state.user.role);
    if (kind === 'profiles' && payload && payload.new && state.user && payload.new.id === state.user.id) selfCheck();
    clearTimeout(pingTimer);
    pingTimer = setTimeout(() => { if (state.refresh) state.refresh(); }, 250);
  });
  if (!pollTimer) {
    // Safety net in case a live message is missed; also notices a revoked session.
    pollTimer = setInterval(() => {
      if (document.hidden) return;
      selfCheck();
      if (state.user) loadNotifs(state.user.role);
      if (state.refresh) state.refresh();
    }, 60000);
  }
  if (!visibilityBound) {
    visibilityBound = true;
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.user) { selfCheck(); loadNotifs(state.user.role); if (state.refresh) state.refresh(); }
    });
  }
}

export function stopLive() {
  liveStarted = false;
  stopRealtime();
  clearInterval(pollTimer);
  pollTimer = null;
  clearTimeout(pingTimer);
}

export async function logout(message) {
  stopLive();
  await data.signOut();
  resetState();
  if (message) toast(message, true);
  go('#/login');
}
