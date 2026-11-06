// All talking to Supabase lives here: sign-in, database functions, user management, live updates.
import { NEXT } from './util.js';

const CFG = window.FABOOLUX_CONFIG || {};
export const configured = !!(CFG.supabaseUrl && CFG.supabaseAnonKey && !String(CFG.supabaseUrl).startsWith('PASTE'));
export const sb = configured && window.supabase
  ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    })
  : null;

const NETWORK_MSG = 'Network problem. Check your connection and try again.';
let authLostHandler = () => {};
export function onAuthLost(fn) { authLostHandler = fn; }

function toError(error) {
  const raw = (error && error.message) || '';
  let status = 400;
  let message = raw || 'Something went wrong. Please try again.';
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(raw)) {
    status = 0; message = NETWORK_MSG;
  } else if (/AUTH_REQUIRED|jwt (expired|invalid)|invalid jwt|not authenticated/i.test(raw)) {
    status = 401; message = 'Your session has ended. Please sign in again.';
  } else if (/permission denied/i.test(raw)) {
    status = 403; message = "You don't have permission to do that.";
  } else if (/refresh and try again|already DISPATCHED|already in use/i.test(raw)) {
    status = 409;
  } else if (/not found/i.test(raw)) {
    status = 404;
  }
  const err = new Error(message);
  err.status = status;
  return err;
}

async function call(fn) {
  let res;
  try { res = await fn(); } catch (e) { throw toError(e); }
  if (res.error) {
    const err = toError(res.error);
    if (err.status === 401) authLostHandler();
    throw err;
  }
  return res.data;
}

const decorate = (p) => {
  const options = Array.isArray(p.next_options) ? p.next_options : (NEXT[p.current_status] || []);
  return Object.assign({}, p, { next_options: options, next_status: options[0] || null });
};
const decoratePayload = (d) => ({ project: decorate(d.project), history: d.history || [] });
const ROLE_ORDER = { super_admin: 0, admin: 1, dm: 2, designer: 3 };

export const data = {
  async session() {
    const { data: d } = await sb.auth.getSession();
    return d.session;
  },

  async signIn(email, password) {
    let res;
    try {
      res = await sb.auth.signInWithPassword({ email: String(email).trim().toLowerCase(), password: String(password) });
    } catch (e) { throw toError(e); }
    if (res.error) {
      const raw = res.error.message || '';
      const err = new Error(
        /failed to fetch|network/i.test(raw) ? NETWORK_MSG
          : /banned/i.test(raw) ? 'This account has been deactivated. Please contact the Super Admin.'
          : 'Invalid email or password.');
      err.status = /failed to fetch|network/i.test(raw) ? 0 : 401;
      throw err;
    }
    return data.profile();
  },

  async signOut() { try { await sb.auth.signOut(); } catch (e) { /* already signed out */ } },

  profile: () => call(() => sb.rpc('my_profile')),
  setTheme: (theme) => call(() => sb.rpc('set_my_theme', { p_theme: theme })),

  async projects() {
    const rows = await call(() => sb.rpc('list_projects'));
    return (rows || []).map(decorate);
  },
  async project(id) {
    return decoratePayload(await call(() => sb.rpc('get_project', { p_id: id })));
  },
  async createProject({ projectId, name, designerId, dmId }) {
    const p = await call(() => sb.rpc('create_project', {
      p_project_id: projectId, p_name: name, p_designer: designerId, p_dm: dmId,
    }));
    return decorate(p);
  },
  async advance(id, newStatus) {
    return decoratePayload(await call(() => sb.rpc('advance_project', { p_id: id, p_new_status: newStatus })));
  },
  notifications: () => call(() => sb.rpc('list_notifications')),
  ackNotification: (id) => call(() => sb.rpc('acknowledge_notification', { p_id: id })),
  ackAll: () => call(() => sb.rpc('acknowledge_all_notifications')),
  assignable: () => call(() => sb.rpc('assignable_users')),

  async users() {
    const rows = await call(() => sb.from('profiles')
      .select('id, name, email, role, is_active, must_change_password, created_at'));
    return rows.sort((a, b) => (ROLE_ORDER[a.role] - ROLE_ORDER[b.role]) || a.name.localeCompare(b.name));
  },

  async admin(payload) {
    let res;
    try { res = await sb.functions.invoke('admin-users', { body: payload }); } catch (e) { throw toError(e); }
    if (res.error) {
      let message = 'Something went wrong. Please try again.';
      let status = 400;
      try {
        const body = await res.error.context.json();
        message = body.error || message;
        status = res.error.context.status;
      } catch (e) { /* keep defaults */ }
      if (status === 401) authLostHandler();
      const err = new Error(message);
      err.status = status;
      throw err;
    }
    return res.data;
  },
  changePassword: (current, next) => data.admin({ action: 'change_password', current_password: current, new_password: next }),
};

// ---------------------------------------------------------------- live updates
let channel = null;
export function startRealtime(onChange) {
  if (channel || !sb) return;
  channel = sb.channel('fbx-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, () => onChange('projects'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'project_status_history' }, () => onChange('history'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications' }, () => onChange('notifications'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'notification_acks' }, () => onChange('notifications'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, (payload) => onChange('profiles', payload))
    .subscribe();
}
export function stopRealtime() {
  if (channel && sb) { sb.removeChannel(channel); }
  channel = null;
}
