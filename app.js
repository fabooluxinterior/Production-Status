(() => {
  'use strict';

  // ------------------------------------------------------------------ constants
  const LABELS = {
    'CHECKING AT R&D': 'Checking at R&D',
    'SENT BACK TO DESIGNER': 'Sent Back to Designer',
    'CHECKING AT FACTORY': 'Checking at Factory',
    'SENT BACK TO R&D': 'Sent Back to R&D',
    'FINAL SOD PENDING': 'Final SOD Pending',
    'UNDER PRODUCTION': 'Under Production',
    'DISPATCHED': 'Dispatched',
  };
  let STATUSES = Object.keys(LABELS); // replaced by the server's list after sign-in
  const ROLE_LABEL = { super_admin: 'Super Admin', admin: 'Admin', designer: 'Designer', dm: 'DM' };
  const POLL_MS = 60000; // fallback only; live updates arrive instantly

  const state = { user: null, projects: [], q: '', status: '', view: null };
  const root = document.getElementById('app');
  const toastEl = document.getElementById('toast');

  // ------------------------------------------------------------------ helpers
  function el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  const isAdmin = () => state.user && (state.user.role === 'super_admin' || state.user.role === 'admin');
  const isSuper = () => state.user && state.user.role === 'super_admin';
  const statusIndex = (s) => STATUSES.indexOf(s);
  const label = (s) => LABELS[s] || s;

  function fmtDate(iso, withTime) {
    if (!iso) return '–';
    const opts = { day: '2-digit', month: 'short', year: 'numeric' };
    if (withTime) Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
    return new Intl.DateTimeFormat(undefined, opts).format(new Date(iso));
  }

  let toastTimer;
  function toast(msg, isError) {
    toastEl.textContent = msg;
    toastEl.className = 'toast' + (isError ? ' err' : '');
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, isError ? 5000 : 3000);
  }

  // ------------------------------------------------------------------ Supabase data layer
  // The screens below call api('GET', '/api/...') exactly as before; this layer answers those
  // calls from Supabase (database + login + live updates) so no server of your own is needed.
  const CFG = window.FABOOLUX_CONFIG || {};
  const NETWORK_MSG = 'Network problem. Check your connection and try again.';
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });

  function fail(message, status) {
    const err = new Error(message);
    err.status = status;
    throw err;
  }
  function raise(error, fallbackStatus) {
    const msg = (error && error.message) || '';
    if (/failed to fetch|networkerror|load failed/i.test(msg)) fail(NETWORK_MSG, 0);
    const conflict = /refresh and try again|already DISPATCHED|already exists/i.test(msg);
    fail(msg || 'Something went wrong. Please try again.', conflict ? 409 : (fallbackStatus || 400));
  }
  const nextOf = (s) => { const i = STATUSES.indexOf(s); return i >= 0 && i < STATUSES.length - 1 ? STATUSES[i + 1] : null; };
  const decorate = (p) => Object.assign({}, p, { next_status: nextOf(p.current_status) });

  async function currentUser() {
    const { data } = await sb.auth.getSession();
    if (!data.session) fail('Please sign in.', 401);
    const { data: prof, error } = await sb.from('profiles')
      .select('id, email, role, is_active, created_at').eq('id', data.session.user.id).maybeSingle();
    if (error) raise(error, 401);
    if (!prof || !prof.is_active) {
      await sb.auth.signOut();
      fail('This account is not active. Please contact an admin.', 401);
    }
    return prof;
  }

  async function callAdmin(payload) {
    const { data, error } = await sb.functions.invoke('admin-users', { body: payload });
    if (error) {
      let message = 'Something went wrong. Please try again.';
      let status = 400;
      try { const body = await error.context.json(); message = body.error || message; status = error.context.status; } catch (e) { /* keep default */ }
      fail(message, status);
    }
    return data;
  }

  // Live updates: any change to projects/history pushes a refresh of the current screen.
  let liveChannel = null;
  let liveTimer;
  function ensureRealtime() {
    if (liveChannel) return;
    const ping = () => { clearTimeout(liveTimer); liveTimer = setTimeout(() => { if (typeof state.refresh === 'function') state.refresh(); }, 300); };
    liveChannel = sb.channel('production-status-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, ping)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'project_status_history' }, ping)
      .subscribe();
  }
  function stopRealtime() {
    if (liveChannel) { sb.removeChannel(liveChannel); liveChannel = null; }
  }

  async function dispatch(method, path, body) {
    let m;
    if (path === '/api/auth/login') {
      const { error } = await sb.auth.signInWithPassword({
        email: String(body.email || '').trim().toLowerCase(), password: String(body.password || ''),
      });
      if (error) {
        if (/failed to fetch|network/i.test(error.message)) fail(NETWORK_MSG, 0);
        fail('Invalid email or password.', 401);
      }
      return { user: await currentUser(), statuses: STATUSES };
    }
    if (path === '/api/auth/me') return { user: await currentUser(), statuses: STATUSES };
    if (path === '/api/auth/logout') { stopRealtime(); await sb.auth.signOut(); return { ok: true }; }
    if (path === '/api/auth/change-password') {
      const next = String(body.new_password || '');
      if (next.length < 8) fail('Password must be at least 8 characters.', 422);
      const check = await sb.auth.signInWithPassword({ email: state.user.email, password: String(body.current_password || '') });
      if (check.error) fail('Current password is incorrect.', 403);
      const { error } = await sb.auth.updateUser({ password: next });
      if (error) raise(error);
      return { ok: true };
    }

    if (path === '/api/projects' && method === 'GET') {
      const { data, error } = await sb.from('projects').select('*')
        .order('created_at', { ascending: false }).order('id', { ascending: false });
      if (error) raise(error);
      return { projects: data.map(decorate) };
    }
    if (path === '/api/projects' && method === 'POST') {
      const { data, error } = await sb.rpc('create_project', {
        p_name: body.project_name, p_project_id: body.project_id,
        p_designer: body.designer_email, p_dm: body.dm_email,
      });
      if (error) raise(error, 422);
      return { project: decorate(data) };
    }
    if ((m = path.match(/^\/api\/projects\/(\d+)$/))) {
      const id = Number(m[1]);
      const { data: project, error } = await sb.from('projects').select('*').eq('id', id).maybeSingle();
      if (error) raise(error);
      if (!project) fail('Project not found.', 404);
      const { data: history, error: hErr } = await sb.from('project_status_history')
        .select('previous_status, new_status, updated_at').eq('project_id', id).order('id');
      if (hErr) raise(hErr);
      return { project: decorate(project), history };
    }
    if ((m = path.match(/^\/api\/projects\/(\d+)\/advance$/))) {
      const id = Number(m[1]);
      const { data, error } = await sb.rpc('advance_project', { p_id: id, p_new_status: body.new_status });
      if (error) raise(error, 409);
      const { data: history } = await sb.from('project_status_history')
        .select('previous_status, new_status, updated_at').eq('project_id', id).order('id');
      return { project: decorate(data), history: history || [] };
    }

    if (path === '/api/assignees') {
      const { data, error } = await sb.from('profiles').select('email, role')
        .in('role', ['designer', 'dm']).eq('is_active', true).order('email');
      if (error) raise(error);
      return { designers: data.filter((r) => r.role === 'designer').map((r) => r.email), dms: data.filter((r) => r.role === 'dm').map((r) => r.email) };
    }
    if (path === '/api/users' && method === 'GET') {
      const { data, error } = await sb.from('profiles').select('id, email, role, is_active, created_at').order('role').order('email');
      if (error) raise(error);
      return { users: data, creatable_roles: state.user.role === 'super_admin' ? ['admin', 'designer', 'dm'] : ['designer', 'dm'] };
    }
    if (path === '/api/users' && method === 'POST') {
      return callAdmin({ action: 'create', email: body.email, role: body.role, password: body.password || undefined });
    }
    if ((m = path.match(/^\/api\/users\/([0-9a-f-]{36})$/)) && method === 'PATCH') {
      return callAdmin({ action: 'set_active', user_id: m[1], is_active: body.is_active });
    }
    if ((m = path.match(/^\/api\/users\/([0-9a-f-]{36})\/reset-password$/))) {
      return callAdmin({ action: 'reset_password', user_id: m[1] });
    }
    return fail('Not found.', 404);
  }

  async function api(method, path, body) {
    try {
      return await dispatch(method, path, body || {});
    } catch (err) {
      if (err.status === 401 && path !== '/api/auth/login' && state.user) {
        state.user = null;
        stopRealtime();
        toast('Your session ended. Please sign in again.', true);
        go('#/login');
      }
      throw err;
    }
  }

  // Disable a button and show a spinner while an async action runs.
  async function busy(btn, fn) {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '';
    btn.append(el('span', { class: 'spinner' }), original);
    try { return await fn(); }
    finally { btn.disabled = false; btn.textContent = original; }
  }

  function tag(status, big) {
    return el('span', { class: `tag s${statusIndex(status) + 1}${big ? ' big' : ''}`, text: label(status) });
  }

  function go(hash) {
    if (location.hash === hash) route(); else location.hash = hash;
  }

  // ------------------------------------------------------------------ layout
  function shell(active, ...content) {
    stopPolling();
    const u = state.user;
    const nav = el('nav', { class: 'nav', 'aria-label': 'Main' },
      el('a', { href: '#/', class: active === 'dashboard' ? 'active' : '', text: 'Dashboard' }),
      isAdmin() && el('a', { href: '#/new', class: active === 'new' ? 'active' : '', text: 'Create Project' }),
      isAdmin() && el('a', { href: '#/users', class: active === 'users' ? 'active' : '', text: isSuper() ? 'Manage Admins' : 'Team' }),
    );
    const header = el('header', { class: 'topbar' },
      el('div', { class: 'topbar-inner' },
        el('a', { class: 'brand', href: '#/', 'aria-label': 'Faboolux dashboard' },
          el('img', { src: 'logo.webp', alt: 'Faboolux Interiors' }),
          el('span', { text: 'Projects' })),
        nav,
        el('div', { class: 'spacer' }),
        el('div', { class: 'who' },
          el('span', { class: 'email', text: u.email }),
          el('span', { class: 'chip', text: ROLE_LABEL[u.role] }),
          el('a', { class: 'linkbtn', href: '#/password', text: 'Password' }),
          el('button', { class: 'linkbtn', type: 'button', text: 'Log out', onclick: logout }),
        )));
    root.replaceChildren(header, el('main', {}, ...content));
    window.scrollTo(0, 0);
  }

  let pollTimer;
  function startPolling(fn) {
    stopPolling();
    pollTimer = setInterval(() => { if (!document.hidden) fn(); }, POLL_MS);
  }
  function stopPolling() { clearInterval(pollTimer); pollTimer = null; }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && typeof state.refresh === 'function') state.refresh();
  });

  async function logout() {
    try { await api('POST', '/api/auth/logout'); } catch (e) { /* ignore */ }
    state.user = null;
    state.projects = [];
    state.refresh = null;
    go('#/login');
  }

  // ------------------------------------------------------------------ login
  function viewLogin() {
    stopPolling();
    state.refresh = null;
    const err = el('div', { class: 'error', role: 'alert', hidden: true });
    const email = el('input', { id: 'email', type: 'email', autocomplete: 'username', required: true, autofocus: true });
    const pw = el('input', { id: 'password', type: 'password', autocomplete: 'current-password', required: true });
    const btn = el('button', { class: 'btn', type: 'submit', text: 'Sign in' });
    const form = el('form', { class: 'form', novalidate: true },
      el('div', { class: 'field' }, el('label', { for: 'email', text: 'Email' }), email),
      el('div', { class: 'field' }, el('label', { for: 'password', text: 'Password' }), pw),
      err, btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      if (!email.value.trim() || !pw.value) { err.textContent = 'Enter your email and password.'; err.hidden = false; return; }
      try {
        const data = await busy(btn, () => api('POST', '/api/auth/login', { email: email.value, password: pw.value }));
        state.user = data.user;
        STATUSES = data.statuses;
        go('#/');
      } catch (ex) { err.textContent = ex.message; err.hidden = false; pw.value = ''; pw.focus(); }
    });
    root.replaceChildren(el('div', { class: 'login-wrap' },
      el('div', { class: 'panel login-card' },
        el('img', { src: 'logo.webp', alt: 'Faboolux Interiors' }),
        el('h1', { text: 'Sign in' }),
        form)));
  }

  // ------------------------------------------------------------------ dashboard
  async function loadProjects() {
    const data = await api('GET', '/api/projects');
    state.projects = data.projects;
  }

  function viewDashboard() {
    const statsEl = el('div', { class: 'stats' });
    const listEl = el('div', { class: 'list' });
    const search = el('input', { type: 'search', class: 'search', placeholder: 'Search by project name or ID', 'aria-label': 'Search projects', value: state.q });
    const select = el('select', { 'aria-label': 'Filter by status' },
      el('option', { value: '', text: 'All statuses' }),
      STATUSES.map((s) => el('option', { value: s, text: label(s) })));
    select.value = state.status;

    function draw() {
      const all = state.projects;
      const count = (s) => all.filter((p) => p.current_status === s).length;
      const tiles = [
        ['Total Projects', all.length, ''],
        ['Checking at R&D', count('CHECKING AT R&D'), 'CHECKING AT R&D'],
        ['Checking at Factory', count('CHECKING AT FACTORY'), 'CHECKING AT FACTORY'],
        ['Under Production', count('UNDER PRODUCTION'), 'UNDER PRODUCTION'],
        ['Dispatched', count('DISPATCHED'), 'DISPATCHED'],
      ];
      statsEl.replaceChildren(...tiles.map(([name, n, s]) =>
        el('button', {
          type: 'button', class: 'stat' + (state.status === s ? ' on' : ''), 'aria-pressed': String(state.status === s),
          onclick: () => { state.status = s; select.value = s; draw(); },
        }, el('b', { text: n }), el('span', { text: name }))));

      const q = state.q.trim().toLowerCase();
      const shown = all.filter((p) =>
        (!state.status || p.current_status === state.status) &&
        (!q || p.project_name.toLowerCase().includes(q) || p.project_id.toLowerCase().includes(q)));

      if (!all.length) {
        listEl.replaceChildren(el('div', { class: 'panel empty' },
          el('h2', { text: 'No projects yet' }),
          el('p', { text: isAdmin() ? 'Create the first project to get started.' : 'Projects assigned to you will appear here.' }),
          isAdmin() && el('a', { class: 'btn', href: '#/new', text: 'Create Project' })));
      } else if (!shown.length) {
        listEl.replaceChildren(el('div', { class: 'panel empty' },
          el('h2', { text: 'No matching projects' }),
          el('p', { text: 'Try a different search or status filter.' })));
      } else {
        listEl.replaceChildren(...shown.map(projectRow));
      }
    }

    search.addEventListener('input', () => { state.q = search.value; draw(); });
    select.addEventListener('change', () => { state.status = select.value; draw(); });

    shell('dashboard',
      el('div', { class: 'page-head' },
        el('div', { class: 'grow' }, el('h1', { text: 'Dashboard' })),
        isAdmin() && el('a', { class: 'btn', href: '#/new', text: 'Create Project' })),
      statsEl,
      el('div', { class: 'toolbar' }, search, select),
      listEl);
    listEl.replaceChildren(el('div', { class: 'boot' }, el('span', { class: 'spinner' })));

    const refresh = async (quiet) => {
      try { await loadProjects(); draw(); }
      catch (e) { if (!quiet) { listEl.replaceChildren(el('div', { class: 'panel empty' }, el('h2', { text: 'Could not load projects' }), el('p', { text: e.message }))); } }
    };
    state.refresh = () => refresh(true);
    refresh(false);
    startPolling(() => refresh(true));
  }

  function projectRow(p) {
    return el('a', { class: 'row-link', href: `#/project/${p.id}` },
      el('div', { class: 'row-title' }, el('strong', { text: p.project_name }), tag(p.current_status)),
      el('dl', { class: 'meta' },
        metaItem('Project ID', p.project_id),
        metaItem('Designer', p.designer_email),
        metaItem('DM', p.dm_email),
        metaItem('Created', fmtDate(p.created_at))));
  }
  function metaItem(k, v) { return el('div', {}, el('dt', { text: k }), el('dd', { text: v })); }

  // ------------------------------------------------------------------ project details
  function viewProject(id) {
    shell('dashboard', el('div', { class: 'boot' }, el('span', { class: 'spinner' })));
    let current = null; // { project, history }
    let confirming = false;
    const slot = () => root.querySelector('main');

    function draw() {
      const { project: p, history } = current;
      const idx = statusIndex(p.current_status);
      const reachedAt = {};
      history.forEach((h) => { reachedAt[h.new_status] = h.updated_at; });

      const steps = el('ol', { class: 'steps', 'aria-label': 'Workflow progress' },
        STATUSES.map((s, i) => {
          const cls = i < idx ? 'done' : i === idx ? `current s${i + 1}` : 'upcoming';
          return el('li', { class: `step ${cls}`, 'aria-current': i === idx ? 'step' : false },
            el('span', { class: 'dot', 'aria-hidden': 'true', text: i < idx ? '✓' : String(i + 1) }),
            el('span', { class: 'step-text' },
              el('span', { class: 'step-name', text: label(s) }),
              reachedAt[s] && i <= idx ? el('span', { class: 'step-date', text: fmtDate(reachedAt[s], true) }) : null));
        }));

      let editArea = null;
      if (isAdmin()) {
        if (!p.next_status) {
          editArea = el('p', { class: 'final-note', text: 'This project has been dispatched. The workflow is complete.' });
        } else if (!confirming) {
          editArea = el('div', { class: 'actions', style: false },
            el('button', { class: 'btn', type: 'button', text: 'Edit Status', onclick: () => { confirming = true; draw(); } }));
        } else {
          const err = el('div', { class: 'error', role: 'alert', hidden: true });
          const ok = el('button', { class: 'btn accent', type: 'button', text: 'Confirm update' });
          ok.addEventListener('click', async () => {
            err.hidden = true;
            try {
              const data = await busy(ok, () => api('POST', `/api/projects/${p.id}/advance`, { new_status: p.next_status }));
              current = data; confirming = false;
              state.projects = state.projects.map((x) => (x.id === data.project.id ? data.project : x));
              toast(`Status updated to ${label(data.project.current_status)}`);
              draw();
            } catch (ex) {
              err.textContent = ex.message; err.hidden = false;
              if (ex.status === 409) { confirming = false; setTimeout(load, 1200); }
            }
          });
          editArea = el('div', { class: 'confirm' },
            el('strong', { text: 'Move this project to the next stage?' }),
            el('div', { class: 'flow' }, tag(p.current_status), el('span', { class: 'arrow', 'aria-hidden': 'true', text: '→' }), tag(p.next_status, true)),
            err,
            el('div', { class: 'actions' }, ok,
              el('button', { class: 'btn ghost', type: 'button', text: 'Cancel', onclick: () => { confirming = false; draw(); } })));
        }
      }

      slot().replaceChildren(
        el('a', { class: 'back', href: '#/', text: '← All projects' }),
        el('div', { class: 'panel' },
          el('div', { class: 'page-head' },
            el('div', { class: 'grow' },
              el('div', { class: 'row-title' }, el('h1', { text: p.project_name }), tag(p.current_status, true))),
            ),
          el('dl', { class: 'detail-grid' },
            detailItem('Project ID', p.project_id),
            detailItem('Designer', p.designer_email),
            detailItem('DM', p.dm_email),
            detailItem('Current Status', label(p.current_status)),
            detailItem('Created', fmtDate(p.created_at, true)),
            detailItem('Last Status Update', fmtDate(p.updated_at, true))),
          el('h2', { class: 'section-title', text: 'Workflow progress' }),
          steps,
          editArea));
    }

    async function load() {
      try {
        current = await api('GET', `/api/projects/${id}`);
        draw();
      } catch (e) {
        slot().replaceChildren(el('a', { class: 'back', href: '#/', text: '← All projects' }),
          el('div', { class: 'panel empty' }, el('h2', { text: e.status === 404 ? 'Project not found' : 'Could not load project' }), el('p', { text: e.message })));
      }
    }
    state.refresh = () => { if (!confirming) return load(); };
    load();
    startPolling(() => state.refresh && state.refresh());
  }
  function detailItem(k, v) { return el('div', {}, el('dt', { text: k }), el('dd', { text: v })); }

  // ------------------------------------------------------------------ create project
  async function viewNew() {
    if (!isAdmin()) return go('#/');
    state.refresh = null;
    const err = el('div', { class: 'error', role: 'alert', hidden: true });
    const name = el('input', { id: 'pname', maxlength: '120', required: true, autocomplete: 'off', autofocus: true });
    const pid = el('input', { id: 'pid', maxlength: '40', required: true, autocomplete: 'off' });
    const designer = el('input', { id: 'des', type: 'email', list: 'designers', required: true, autocomplete: 'off' });
    const dm = el('input', { id: 'dm', type: 'email', list: 'dms', required: true, autocomplete: 'off' });
    const dl1 = el('datalist', { id: 'designers' });
    const dl2 = el('datalist', { id: 'dms' });
    const btn = el('button', { class: 'btn', type: 'submit', text: 'Create project' });
    const form = el('form', { class: 'form', novalidate: true },
      field('Project Name', 'pname', name),
      field('Project ID', 'pid', pid),
      field('Designer Email', 'des', designer, 'Must be a registered Designer.'),
      field('DM Email', 'dm', dm, 'Must be a registered DM.'),
      el('p', { class: 'hint sub', text: 'The project starts automatically at Checking at R&D.' }),
      err,
      el('div', { class: 'actions' }, btn, el('a', { class: 'btn ghost', href: '#/', text: 'Cancel' })),
      dl1, dl2);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      if (![name, pid, designer, dm].every((i) => i.value.trim())) { err.textContent = 'Please fill in all four fields.'; err.hidden = false; return; }
      try {
        const data = await busy(btn, () => api('POST', '/api/projects', {
          project_name: name.value, project_id: pid.value, designer_email: designer.value, dm_email: dm.value,
        }));
        state.projects = [data.project, ...state.projects];
        toast('Project created');
        go('#/');
      } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    });
    shell('new', el('div', { class: 'page-head' }, el('h1', { text: 'Create Project' })), el('div', { class: 'panel' }, form));
    try {
      const a = await api('GET', '/api/assignees');
      dl1.replaceChildren(...a.designers.map((v) => el('option', { value: v })));
      dl2.replaceChildren(...a.dms.map((v) => el('option', { value: v })));
      if (!a.designers.length || !a.dms.length) {
        err.textContent = 'There are no registered ' + (!a.designers.length ? 'Designers' : 'DMs') + ' yet. Add them under Team first.';
        err.hidden = false;
      }
    } catch (e) { /* suggestions are optional */ }
  }

  function field(labelText, id, input, hint) {
    return el('div', { class: 'field' }, el('label', { for: id, text: labelText }), input, hint ? el('span', { class: 'hint', text: hint }) : null);
  }

  // ------------------------------------------------------------------ users / admins
  async function viewUsers() {
    if (!isAdmin()) return go('#/');
    state.refresh = null;
    const title = isSuper() ? 'Manage Admins' : 'Team';
    shell('users', el('div', { class: 'page-head' }, el('div', { class: 'grow' }, el('h1', { text: title }),
      el('p', { class: 'sub', text: isSuper() ? 'Admins, Designers and DMs who can sign in.' : 'Designers and DMs who can be assigned to projects.' }))),
      el('div', { class: 'boot' }, el('span', { class: 'spinner' })));

    const main = () => root.querySelector('main');
    let data;
    let credential = null;

    async function load() {
      try { data = await api('GET', '/api/users'); draw(); }
      catch (e) { main().replaceChildren(el('div', { class: 'panel empty' }, el('h2', { text: 'Could not load users' }), el('p', { text: e.message }))); }
    }

    function draw() {
      const roleNames = { admin: 'Admin', designer: 'Designer', dm: 'DM' };
      const err = el('div', { class: 'error', role: 'alert', hidden: true });
      const email = el('input', { id: 'ue', type: 'email', required: true, autocomplete: 'off' });
      const role = el('select', { id: 'ur' }, data.creatable_roles.map((r) => el('option', { value: r, text: roleNames[r] })));
      const pw = el('input', { id: 'up', type: 'text', autocomplete: 'off', placeholder: 'Leave blank to generate' });
      const btn = el('button', { class: 'btn', type: 'submit', text: 'Add user' });
      const form = el('form', { class: 'inline-form', novalidate: true },
        field('Email', 'ue', email), field('Role', 'ur', role), field('Initial password', 'up', pw), btn);
      form.addEventListener('submit', async (e) => {
        e.preventDefault(); err.hidden = true;
        try {
          const res = await busy(btn, () => api('POST', '/api/users', { email: email.value, role: role.value, password: pw.value || null }));
          credential = { email: res.user.email, password: res.temp_password || pw.value, generated: !!res.temp_password, what: 'Account created' };
          toast('User added');
          await load();
        } catch (ex) { err.textContent = ex.message; err.hidden = false; }
      });

      const groups = [['admin', 'Admins'], ['designer', 'Designers'], ['dm', 'DMs']].filter(([r]) => isSuper() || r !== 'admin');
      const sections = groups.map(([r, name]) => {
        const rows = data.users.filter((u) => u.role === r);
        return el('div', {}, el('h2', { class: 'group-title', text: name }),
          rows.length ? rows.map(userRow) : el('p', { class: 'sub', text: `No ${name.toLowerCase()} yet.` }));
      });
      const owner = isSuper() ? data.users.filter((u) => u.role === 'super_admin').map((u) =>
        el('div', {}, el('h2', { class: 'group-title', text: 'Super Admin' }),
          el('div', { class: 'user-row' }, el('span', { class: 'who-email', text: u.email }), el('span', { class: 'chip', text: 'Super Admin' })))) : [];

      main().replaceChildren(
        el('div', { class: 'page-head' }, el('div', { class: 'grow' }, el('h1', { text: title }),
          el('p', { class: 'sub', text: isSuper() ? 'Admins, Designers and DMs who can sign in.' : 'Designers and DMs who can be assigned to projects.' }))),
        credential && credentialPanel(),
        el('div', { class: 'panel' }, el('h2', { text: 'Add a user' }), form, err),
        owner, sections);
    }

    function credentialPanel() {
      const c = credential;
      return el('div', { class: 'panel cred', role: 'status' },
        el('strong', { text: `${c.what}. Share these sign-in details securely.` }),
        el('code', { text: c.email }),
        el('code', { text: c.password }),
        el('p', { class: 'sub', text: 'This password is shown only now. The user can change it after signing in.' }),
        el('div', { class: 'actions' },
          el('button', { class: 'btn small', type: 'button', text: 'Copy details', onclick: async () => {
            try { await navigator.clipboard.writeText(`Email: ${c.email}\nPassword: ${c.password}`); toast('Copied'); }
            catch (e) { toast('Copy failed. Select the text manually.', true); }
          } }),
          el('button', { class: 'btn small ghost', type: 'button', text: 'Dismiss', onclick: () => { credential = null; draw(); } })));
    }

    function userRow(u) {
      const toggle = el('button', { class: 'btn small ghost', type: 'button', text: u.is_active ? 'Deactivate' : 'Activate' });
      toggle.addEventListener('click', async () => {
        if (u.is_active && !confirm(`Deactivate ${u.email}? They will be signed out and unable to sign in.`)) return;
        try {
          await busy(toggle, () => api('PATCH', `/api/users/${u.id}`, { is_active: !u.is_active }));
          toast(u.is_active ? 'User deactivated' : 'User activated');
          await load();
        } catch (ex) { toast(ex.message, true); }
      });
      const reset = el('button', { class: 'btn small ghost', type: 'button', text: 'Reset password' });
      reset.addEventListener('click', async () => {
        if (!confirm(`Generate a new password for ${u.email}? They will be signed out everywhere.`)) return;
        try {
          const res = await busy(reset, () => api('POST', `/api/users/${u.id}/reset-password`));
          credential = { email: u.email, password: res.temp_password, generated: true, what: 'Password reset' };
          draw(); window.scrollTo(0, 0);
        } catch (ex) { toast(ex.message, true); }
      });
      return el('div', { class: 'user-row' + (u.is_active ? '' : ' off') },
        el('span', { class: 'who-email', text: u.email }),
        u.is_active ? null : el('span', { class: 'badge-off', text: 'Inactive' }),
        el('span', { class: 'sub', text: `Added ${fmtDate(u.created_at)}` }),
        toggle, reset);
    }

    load();
  }

  // ------------------------------------------------------------------ change password
  function viewPassword() {
    state.refresh = null;
    const err = el('div', { class: 'error', role: 'alert', hidden: true });
    const cur = el('input', { id: 'cp', type: 'password', autocomplete: 'current-password', required: true });
    const n1 = el('input', { id: 'np', type: 'password', autocomplete: 'new-password', required: true });
    const n2 = el('input', { id: 'np2', type: 'password', autocomplete: 'new-password', required: true });
    const btn = el('button', { class: 'btn', type: 'submit', text: 'Update password' });
    const form = el('form', { class: 'form', novalidate: true },
      field('Current password', 'cp', cur), field('New password', 'np', n1, 'At least 8 characters.'), field('Confirm new password', 'np2', n2), err,
      el('div', { class: 'actions' }, btn, el('a', { class: 'btn ghost', href: '#/', text: 'Cancel' })));
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.hidden = true;
      if (n1.value !== n2.value) { err.textContent = 'The new passwords do not match.'; err.hidden = false; return; }
      try {
        await busy(btn, () => api('POST', '/api/auth/change-password', { current_password: cur.value, new_password: n1.value }));
        toast('Password updated');
        go('#/');
      } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    });
    shell('', el('div', { class: 'page-head' }, el('h1', { text: 'Change password' })), el('div', { class: 'panel' }, form));
  }

  // ------------------------------------------------------------------ router & boot
  function route() {
    const hash = location.hash || '#/';
    if (!state.user) { if (hash !== '#/login') { history.replaceState(null, '', '#/login'); } return viewLogin(); }
    ensureRealtime();
    if (hash === '#/login') return go('#/');
    const m = hash.match(/^#\/project\/(\d+)$/);
    if (m) return viewProject(Number(m[1]));
    if (hash === '#/new') return viewNew();
    if (hash === '#/users') return viewUsers();
    if (hash === '#/password') return viewPassword();
    return viewDashboard();
  }

  window.addEventListener('hashchange', route);

  (async function boot() {
    try {
      const data = await api('GET', '/api/auth/me'); // restores the persistent session after a refresh
      state.user = data.user;
      STATUSES = data.statuses;
    } catch (e) { state.user = null; }
    route();
  })();
})();
