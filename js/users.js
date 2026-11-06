// Users management (Super Admin only), profile page, and the change-password form.
import { data } from './data.js';
import { currentTheme, setTheme, shell, state } from './core.js';
import { busy, confirmModal, emptyState, openModal } from './ui.js';
import { ROLE_LABEL, el, fmtDate, toast } from './util.js';

const field = (lbl, forId, control, hint) => el('div', { class: 'field' },
  el('label', { for: forId, text: lbl }), control, hint ? el('span', { class: 'hint', text: hint }) : null);

// ================================================================ change password (also used for the forced change)
export function passwordForm({ forced = false, onDone }) {
  const error = el('div', { class: 'error-box', role: 'alert', hidden: true });
  const cur = el('input', { id: 'pw-cur', class: 'input', type: 'password', autocomplete: 'current-password', required: true, 'data-autofocus': true });
  const n1 = el('input', { id: 'pw-new', class: 'input', type: 'password', autocomplete: 'new-password', required: true });
  const n2 = el('input', { id: 'pw-new2', class: 'input', type: 'password', autocomplete: 'new-password', required: true });
  const btn = el('button', { class: 'btn primary', type: 'submit', text: forced ? 'Set new password' : 'Update password' });
  const form = el('form', { class: 'form', novalidate: true },
    field(forced ? 'Temporary password' : 'Current password', 'pw-cur', cur),
    field('New password', 'pw-new', n1, 'At least 8 characters.'),
    field('Confirm new password', 'pw-new2', n2),
    error,
    el('div', { class: 'actions' }, btn));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.hidden = true;
    const fail = (m) => { error.textContent = m; error.hidden = false; };
    if (!cur.value) return fail(forced ? 'Enter the temporary password you were given.' : 'Enter your current password.');
    if (n1.value.length < 8) return fail('The new password must be at least 8 characters.');
    if (n1.value !== n2.value) return fail('The new passwords do not match.');
    try {
      await busy(btn, () => data.changePassword(cur.value, n1.value));
      state.user = await data.profile();
      toast('Password updated');
      onDone();
    } catch (ex) { fail(ex.message); }
  });
  return form;
}

// ================================================================ profile
export function viewProfile() {
  const u = state.user;
  const themeBtn = (value, text) => el('button', {
    type: 'button', role: 'radio', 'aria-checked': String(currentTheme() === value),
    class: 'seg' + (currentTheme() === value ? ' on' : ''), text,
    onclick: async () => { await setTheme(value); viewProfile(); },
  });
  shell('profile',
    el('div', { class: 'page-head' }, el('h1', { text: 'Profile' })),
    el('section', { class: 'panel narrow' },
      el('dl', { class: 'detail-grid one' },
        el('div', {}, el('dt', { text: 'Name' }), el('dd', { text: u.name })),
        el('div', {}, el('dt', { text: 'Email' }), el('dd', { text: u.email })),
        el('div', {}, el('dt', { text: 'Role' }), el('dd', { text: ROLE_LABEL[u.role] })))),
    el('section', { class: 'panel narrow' },
      el('h2', { class: 'section-title', text: 'Theme' }),
      el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Theme' }, themeBtn('dark', 'Premium Dark'), themeBtn('light', 'Premium Light')),
      el('p', { class: 'hint', text: 'Your choice is saved to your account and restored when you sign in.' })),
    el('section', { class: 'panel narrow' },
      el('h2', { class: 'section-title', text: 'Change password' }),
      passwordForm({ onDone: () => { window.location.hash = '#/'; } })));
}

// ================================================================ users management
function showCredentials({ title, email, password, note }) {
  const copy = el('button', {
    class: 'btn small', type: 'button', text: 'Copy details',
    onclick: async () => {
      try { await navigator.clipboard.writeText(`Email: ${email}\nTemporary password: ${password}`); toast('Copied'); }
      catch (e) { toast('Copy failed. Select the text and copy it manually.', true); }
    },
  });
  const done = el('button', { class: 'btn primary', type: 'button', text: 'Done', 'data-autofocus': true });
  const m = openModal({
    title,
    body: [
      el('p', { class: 'muted', text: note }),
      el('div', { class: 'cred-box' },
        el('div', {}, el('span', { class: 'cred-k', text: 'Email' }), el('code', { text: email })),
        el('div', {}, el('span', { class: 'cred-k', text: 'Temporary password' }), el('code', { text: password }))),
      el('p', { class: 'hint', text: 'This password is shown only once. The user must choose a new one the first time they sign in.' }),
    ],
    actions: [copy, done],
  });
  done.addEventListener('click', () => m.close(true));
}

export function viewUsers() {
  const me = state.user;
  let users = [];
  const tableHost = el('div', { class: 'panel flush' }, el('div', { class: 'skeleton block' }));

  function userFormModal(user) {
    const editing = !!user;
    const isSuper = editing && user.role === 'super_admin';
    const isSelf = editing && user.id === me.id;
    const error = el('div', { class: 'error-box', role: 'alert', hidden: true });
    const name = el('input', { id: 'u-name', class: 'input', type: 'text', maxlength: '100', autocomplete: 'off', required: true, value: editing ? user.name : '', 'data-autofocus': true });
    const email = el('input', { id: 'u-email', class: 'input', type: 'email', autocomplete: 'off', required: true, value: editing ? user.email : '', disabled: isSelf });
    const role = el('select', { id: 'u-role', class: 'input', disabled: isSuper },
      isSuper ? el('option', { value: 'super_admin', text: 'Super Admin' }) : [
        el('option', { value: 'admin', text: 'Admin' }),
        el('option', { value: 'rnd', text: 'R&D Department' }),
        el('option', { value: 'designer', text: 'Designer' }),
        el('option', { value: 'dm', text: 'DM' }),
      ]);
    role.value = editing ? user.role : 'designer';
    const pw = editing ? null : el('input', { id: 'u-pw', class: 'input', type: 'text', autocomplete: 'off', placeholder: 'Leave blank to generate one' });
    const save = el('button', { class: 'btn primary', type: 'submit', text: editing ? 'Save changes' : 'Add user' });
    const cancel = el('button', { class: 'btn ghost', type: 'button', text: 'Cancel' });

    const form = el('form', { class: 'form flat', novalidate: true },
      field('User name', 'u-name', name),
      field('Email', 'u-email', email, isSelf ? 'You can\'t change your own sign-in email.' : null),
      field('Role', 'u-role', role, editing && !isSuper ? 'Not possible while the user is assigned to projects. Deactivate them instead.' : null),
      pw ? field('Temporary password', 'u-pw', pw, 'The user must change it at first sign-in.') : null,
      error,
      el('div', { class: 'modal-actions inline' }, cancel, save));
    const m = openModal({ title: editing ? 'Edit user' : 'Add user', body: form });
    cancel.addEventListener('click', () => m.close(false));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.hidden = true;
      const fail = (t) => { error.textContent = t; error.hidden = false; };
      if (!name.value.trim()) return fail('Enter the user\'s name.');
      if (!email.value.trim()) return fail('Enter an email address.');
      try {
        if (editing) {
          const payload = { action: 'update', user_id: user.id, name: name.value };
          if (!isSelf) payload.email = email.value;
          if (!isSuper) payload.role = role.value;
          await busy(save, () => data.admin(payload));
          m.close(true);
          toast('User updated');
        } else {
          const res = await busy(save, () => data.admin({
            action: 'create', name: name.value, email: email.value, role: role.value, password: pw.value || undefined,
          }));
          m.close(true);
          toast('User added');
          if (res.temp_password) {
            showCredentials({ title: 'Account created', email: res.user.email, password: res.temp_password, note: 'Share these sign-in details securely.' });
          }
        }
        load();
      } catch (ex) { fail(ex.message); }
    });
  }

  function resetModal(user) {
    const error = el('div', { class: 'error-box', role: 'alert', hidden: true });
    const pw = el('input', { id: 'r-pw', class: 'input', type: 'text', autocomplete: 'off', placeholder: 'Leave blank to generate one', 'data-autofocus': true });
    const go = el('button', { class: 'btn primary', type: 'submit', text: 'Reset password' });
    const cancel = el('button', { class: 'btn ghost', type: 'button', text: 'Cancel' });
    const form = el('form', { class: 'form flat', novalidate: true },
      el('p', { class: 'muted', text: `Set a new temporary password for ${user.name}. They will be signed out everywhere and must choose a new password at their next sign-in.` }),
      field('Temporary password', 'r-pw', pw, 'Leave blank to generate a strong one.'),
      error,
      el('div', { class: 'modal-actions inline' }, cancel, go));
    const m = openModal({ title: 'Reset password', body: form });
    cancel.addEventListener('click', () => m.close(false));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.hidden = true;
      try {
        const res = await busy(go, () => data.admin({ action: 'reset_password', user_id: user.id, password: pw.value || undefined }));
        m.close(true);
        toast('Password reset');
        const shown = res.temp_password || pw.value;
        showCredentials({ title: 'Password reset', email: user.email, password: shown, note: 'Share the new temporary password securely.' });
        load();
      } catch (ex) { error.textContent = ex.message; error.hidden = false; }
    });
  }

  async function toggleActive(user, btn) {
    if (user.is_active) {
      const ok = await confirmModal({
        title: 'Deactivate account', danger: true, confirmText: 'Deactivate',
        body: el('p', { text: `${user.name} will be signed out immediately and will not be able to sign in. Their projects and history are kept.` }),
      });
      if (!ok) return;
    }
    try {
      await busy(btn, () => data.admin({ action: 'set_active', user_id: user.id, is_active: !user.is_active }));
      toast(user.is_active ? 'Account deactivated' : 'Account activated');
      load();
    } catch (ex) { toast(ex.message, true); }
  }

  async function revoke(user, btn) {
    const ok = await confirmModal({
      title: 'Revoke sessions', danger: true, confirmText: 'Revoke sessions',
      body: el('p', { text: `${user.name} will be signed out on every device. They can sign in again with their password.` }),
    });
    if (!ok) return;
    try {
      await busy(btn, () => data.admin({ action: 'revoke_sessions', user_id: user.id }));
      toast('Sessions revoked');
    } catch (ex) { toast(ex.message, true); }
  }

  function draw() {
    if (!users.length) { tableHost.replaceChildren(emptyState('No users yet', 'Add the first account.')); return; }
    const rows = users.map((u) => {
      const self = u.id === me.id;
      const locked = u.role === 'super_admin';
      const tog = el('button', { class: 'btn small ghost', type: 'button', text: u.is_active ? 'Deactivate' : 'Activate' });
      tog.addEventListener('click', () => toggleActive(u, tog));
      const rev = el('button', { class: 'btn small ghost', type: 'button', text: 'Revoke sessions' });
      rev.addEventListener('click', () => revoke(u, rev));
      return el('tr', { class: u.is_active ? '' : 'off' },
        el('td', { 'data-label': 'User Name' }, el('strong', { text: u.name }), self ? el('span', { class: 'you', text: ' (you)' }) : null),
        el('td', { 'data-label': 'Email', class: 'wrap', text: u.email }),
        el('td', { 'data-label': 'Role' }, el('span', { class: 'chip', text: ROLE_LABEL[u.role] })),
        el('td', { 'data-label': 'Account Status' }, el('span', { class: 'badge ' + (u.is_active ? 'ok' : 'off'), text: u.is_active ? 'Active' : 'Inactive' })),
        el('td', { 'data-label': 'Password Management' },
          locked ? el('span', { class: 'muted', text: 'Managed by owner' }) : [
            el('span', { class: 'badge ' + (u.must_change_password ? 'warn' : 'plain'), text: u.must_change_password ? 'Change required' : 'Set by user' }),
            el('button', { class: 'btn small ghost', type: 'button', text: 'Reset password', onclick: () => resetModal(u) }),
          ]),
        el('td', { 'data-label': 'Actions' }, el('div', { class: 'row-actions' },
          el('button', { class: 'btn small ghost', type: 'button', text: 'Edit', onclick: () => userFormModal(u) }),
          locked || self ? null : [tog, rev])));
    });
    tableHost.replaceChildren(el('div', { class: 'table-wrap' },
      el('table', { class: 'users' },
        el('thead', {}, el('tr', {}, ['User Name', 'Email', 'Role', 'Account Status', 'Password Management', 'Actions'].map((h) => el('th', { scope: 'col', text: h })))),
        el('tbody', {}, rows))));
  }

  async function load() {
    try { users = await data.users(); draw(); }
    catch (e) { if (!users.length) tableHost.replaceChildren(emptyState('Could not load users', e.message)); }
  }

  shell('users',
    el('div', { class: 'page-head' },
      el('div', { class: 'grow' }, el('h1', { text: 'Users' }), el('p', { class: 'sub', text: 'Everyone who can sign in. Only you can manage accounts.' })),
      el('button', { class: 'btn primary', type: 'button', text: 'Add user', onclick: () => userFormModal(null) })),
    tableHost);
  state.refresh = load;
  load();
}
