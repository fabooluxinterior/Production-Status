// Entry point: sign-in, forced password change, routing.
import { configured, data, onAuthLost, sb } from './data.js';
import { applyTheme, go, logout, resetState, root, startLive, state, themeButton } from './core.js';
import { viewCreate, viewDashboard, viewProject, viewProjects } from './projects.js';
import { passwordForm, viewProfile, viewUsers } from './users.js';
import { busy } from './ui.js';
import { el } from './util.js';

const brandImg = () => el('img', { class: 'login-logo', src: 'logo.webp', alt: 'Faboolux Interiors' });

function authPage(...content) {
  root.replaceChildren(el('div', { class: 'login-wrap page' },
    el('div', { class: 'login-top' }, themeButton()),
    el('div', { class: 'panel login-card' }, brandImg(), ...content)));
}

function viewLogin() {
  state.refresh = null;
  const error = el('div', { class: 'error-box', role: 'alert', hidden: true });
  const email = el('input', { id: 'email', class: 'input', type: 'email', autocomplete: 'username', required: true, 'data-autofocus': true });
  const pw = el('input', { id: 'password', class: 'input', type: 'password', autocomplete: 'current-password', required: true });
  const btn = el('button', { class: 'btn primary block', type: 'submit', text: 'Sign in' });
  const form = el('form', { class: 'form', novalidate: true },
    el('div', { class: 'field' }, el('label', { for: 'email', text: 'Email' }), email),
    el('div', { class: 'field' }, el('label', { for: 'password', text: 'Password' }), pw),
    error, btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.hidden = true;
    if (!email.value.trim() || !pw.value) { error.textContent = 'Enter your email and password.'; error.hidden = false; return; }
    try {
      const profile = await busy(btn, () => data.signIn(email.value, pw.value));
      if (!profile || !profile.is_active) {
        await data.signOut();
        throw new Error('This account is not active. Please contact the Super Admin.');
      }
      state.user = profile;
      applyTheme(profile.theme);
      const back = state.returnTo;
      state.returnTo = '';
      go(back && back !== '#/login' ? back : '#/');
    } catch (ex) {
      error.textContent = ex.message;
      error.hidden = false;
      pw.value = '';
      pw.focus();
    }
  });
  authPage(el('h1', { class: 'login-title', text: 'Production Status' }), el('p', { class: 'sub center', text: 'Sign in to continue' }), form);
  email.focus();
}

function viewForcePassword() {
  state.refresh = null;
  const form = passwordForm({ forced: true, onDone: () => { go('#/'); } });
  const out = el('button', { class: 'linkbtn', type: 'button', text: 'Sign out', onclick: () => logout() });
  authPage(
    el('h1', { class: 'login-title', text: 'Choose a new password' }),
    el('p', { class: 'sub center', text: 'You signed in with a temporary password. Set your own to continue.' }),
    form,
    el('div', { class: 'center' }, out));
}

function viewSetup(message) {
  root.replaceChildren(el('div', { class: 'login-wrap' },
    el('div', { class: 'panel login-card' }, brandImg(),
      el('h1', { class: 'login-title', text: 'Almost ready' }),
      el('p', { class: 'sub center', text: message }))));
}

function route() {
  state.refresh = null;
  const hash = location.hash || '#/';
  if (!state.user) {
    if (hash !== '#/login') { state.returnTo = hash; history.replaceState(null, '', '#/login'); }
    return viewLogin();
  }
  if (state.user.must_change_password) return viewForcePassword();
  startLive();
  if (hash === '#/login') return go('#/');
  const project = hash.match(/^#\/project\/(\d+)$/);
  if (project) return viewProject(Number(project[1]));
  switch (hash) {
    case '#/new': return viewCreate();
    case '#/projects': return viewProjects();
    case '#/users': return state.user.role === 'super_admin' ? viewUsers() : go('#/');
    case '#/profile': return viewProfile();
    default: return viewDashboard();
  }
}

(async function boot() {
  if (!configured) {
    return viewSetup('This site is not connected to its database yet. The administrator needs to add the Supabase URL and key to config.js.');
  }
  if (!sb) {
    return viewSetup('Could not load the sign-in service. Check your internet connection and refresh the page.');
  }
  onAuthLost(() => { if (state.user) logout('Your session ended. Please sign in again.'); });
  resetState();
  try {
    if (await data.session()) {
      const profile = await data.profile();   // restores the persistent session after a refresh
      if (profile && profile.is_active && profile.session_valid) {
        state.user = profile;
        applyTheme(profile.theme);
      } else {
        await data.signOut();
      }
    }
  } catch (e) { /* offline or expired: show the sign-in page */ }
  window.addEventListener('hashchange', route);
  route();
})();
