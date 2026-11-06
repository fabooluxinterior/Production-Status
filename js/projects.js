// Dashboard, project list, project details (with activity history) and Create Project.
import { data } from './data.js';
import { go, shell, state } from './core.js';
import { blink, busy, combo, confirmModal, emptyState, skeletonList, tag } from './ui.js';
import {
  ST_DISPATCHED, ST_FACTORY, ST_PRODUCTION, ST_RND, STATUSES,
  el, fmtDate, fmtTime, icon, isDispatched, label, nextStatus, statusIndex, toast,
} from './util.js';

const canCreate = (role) => role === 'super_admin' || role === 'admin' || role === 'dm';
const canEditStatus = (role) => role === 'super_admin' || role === 'admin';

// Attention indicators: Super Admin watches R&D; Admin watches Factory and Production.
function alertFor(role, p) {
  if (role === 'super_admin' && p.current_status === ST_RND) return 'R&D attention required';
  if (role === 'admin' && p.current_status === ST_FACTORY) return 'Factory check pending';
  if (role === 'admin' && p.current_status === ST_PRODUCTION) return 'In production';
  return null;
}

function applyFilters(list, f) {
  const q = f.q.trim().toLowerCase();
  const pid = f.pid.trim().toLowerCase();
  const nm = f.name.trim().toLowerCase();
  return list.filter((p) =>
    (!f.status || p.current_status === f.status) &&
    (!q || [p.project_id, p.project_name, p.designer.name, p.designer.email, p.dm.name, p.dm.email]
      .some((v) => String(v).toLowerCase().includes(q))) &&
    (!pid || p.project_id.toLowerCase().includes(pid)) &&
    (!nm || p.project_name.toLowerCase().includes(nm)));
}

const metaItem = (k, v) => el('div', {}, el('dt', { text: k }), el('dd', { text: v }));

// ================================================================ status change (shared by cards and details)

// Confirm, update the screen immediately, save in the background, and roll back if the save fails.
export async function advanceFlow(project, redraw) {
  const next = project.next_status;
  if (!next) return;
  const ok = await confirmModal({
    title: 'Update project status',
    confirmText: 'Confirm update',
    body: [
      el('p', { class: 'muted', text: `${project.project_id} · ${project.project_name}` }),
      el('div', { class: 'flow' }, tag(project.current_status), el('span', { class: 'arrow', 'aria-hidden': 'true', text: '→' }), tag(next, true)),
      el('p', { class: 'muted small', text: 'Only the next stage is available. This is recorded in the project history with your name and the time.' }),
    ],
  });
  if (!ok) return;

  const before = { projects: state.projects, detail: state.detail };
  const now = new Date().toISOString();
  const optimistic = { ...project, current_status: next, next_status: nextStatus(next), updated_at: now };
  state.projects = state.projects.map((p) => (p.id === project.id ? optimistic : p));
  if (state.detail && state.detail.project.id === project.id) {
    state.detail = {
      project: optimistic,
      history: [...state.detail.history, {
        previous_status: project.current_status, new_status: next, changed_at: now,
        by: { name: state.user.name, email: state.user.email }, pending: true,
      }],
    };
  }
  state.saving++;
  redraw();
  try {
    const res = await data.advance(project.id, next);
    state.projects = state.projects.map((p) => (p.id === project.id ? res.project : p));
    if (state.detail && state.detail.project.id === project.id) state.detail = res;
    toast(`Status updated to ${label(res.project.current_status)}`);
  } catch (e) {
    state.projects = before.projects;
    state.detail = before.detail;
    toast(`Not saved: ${e.message}`, true);
    if (e.status === 409 && state.refresh) setTimeout(() => state.refresh(), 600);
  } finally {
    state.saving--;
    redraw();
  }
}

// ================================================================ dashboard & project list

function statTiles(role, all) {
  const count = (s) => all.filter((p) => p.current_status === s).length;
  const active = all.filter((p) => !isDispatched(p)).length;
  if (role === 'super_admin') {
    return [
      { label: 'Total Active Projects', n: active },
      { label: 'Checking at R&D', n: count(ST_RND), filter: ST_RND },
      { label: 'R&D Attention Required', n: count(ST_RND), filter: ST_RND, alert: 'R&D ATTENTION REQUIRED' },
      { label: 'Dispatched Projects', n: count(ST_DISPATCHED), completed: true },
    ];
  }
  if (role === 'admin') {
    return [
      { label: 'Total Active Projects', n: active },
      { label: 'Checking at Factory', n: count(ST_FACTORY), filter: ST_FACTORY, alert: 'FACTORY CHECKING' },
      { label: 'Under Production', n: count(ST_PRODUCTION), filter: ST_PRODUCTION, alert: 'IN PRODUCTION' },
    ];
  }
  return [
    { label: 'My Active Projects', n: active },
    { label: 'My Assigned Projects', n: all.length },
  ];
}

function renderList(mode) {
  const u = state.user;
  if (mode === 'dashboard') state.tab = 'active';

  const statsEl = mode === 'dashboard' ? el('div', { class: 'stats' }) : null;
  const tabsEl = mode === 'projects' ? el('div', { class: 'tabs', role: 'tablist' }) : null;
  const listEl = el('div', { class: 'list-wrap' }, skeletonList(4));

  const search = el('input', { class: 'input', type: 'search', placeholder: 'Search projects', 'aria-label': 'Search projects', value: state.filters.q });
  const pidIn = el('input', { class: 'input', type: 'search', placeholder: 'Project ID', 'aria-label': 'Filter by Project ID', value: state.filters.pid });
  const nameIn = el('input', { class: 'input', type: 'search', placeholder: 'Project name', 'aria-label': 'Filter by project name', value: state.filters.name });
  const statusSel = el('select', { class: 'input', 'aria-label': 'Filter by status' },
    el('option', { value: '', text: 'All statuses' }),
    STATUSES.filter((s) => s !== ST_DISPATCHED).map((s) => el('option', { value: s, text: label(s) })));
  statusSel.value = state.filters.status;
  const toolbar = el('div', { class: 'toolbar' },
    el('div', { class: 'search-wrap' }, icon('search'), search), pidIn, nameIn, statusSel);

  function draw() {
    if (!state.loaded) return;
    const all = state.projects;
    const completed = state.tab === 'completed';
    if (statsEl) {
      statsEl.replaceChildren(...statTiles(u.role, all).map((t) => {
        const alerting = t.alert && t.n > 0;
        const clickable = t.filter || t.completed;
        const tile = el('button', {
          type: 'button',
          class: 'stat' + (t.alert ? ' watch' : '') + (alerting ? ' alerting' : '') + (state.filters.status === t.filter && t.filter ? ' on' : ''),
          disabled: !clickable,
          onclick: () => {
            if (t.completed) { state.tab = 'completed'; go('#/projects'); return; }
            state.filters.status = state.filters.status === t.filter ? '' : t.filter;
            statusSel.value = state.filters.status;
            draw();
          },
        },
        el('span', { class: 'lbl', text: t.label }),
        el('span', { class: 'num-row' }, el('span', { class: 'num', text: String(t.n) }), alerting ? el('span', { class: 'blink-dot', 'aria-hidden': 'true' }) : null),
        t.alert ? el('span', { class: 'note', text: alerting ? t.alert : 'All clear' }) : null);
        return tile;
      }));
    }
    const base = all.filter((p) => (completed ? isDispatched(p) : !isDispatched(p)));
    if (tabsEl) {
      const nCompleted = all.filter(isDispatched).length;
      tabsEl.replaceChildren(
        el('button', { type: 'button', role: 'tab', 'aria-selected': String(!completed), class: 'tab' + (!completed ? ' on' : ''), text: `Active (${all.length - nCompleted})`, onclick: () => { state.tab = 'active'; draw(); } }),
        el('button', { type: 'button', role: 'tab', 'aria-selected': String(completed), class: 'tab' + (completed ? ' on' : ''), text: `Completed / Dispatched (${nCompleted})`, onclick: () => { state.tab = 'completed'; state.filters.status = ''; statusSel.value = ''; draw(); } }));
    }
    statusSel.hidden = completed;

    const shown = applyFilters(base, state.filters);
    if (!base.length) {
      listEl.replaceChildren(completed
        ? emptyState('No dispatched projects yet', 'Projects appear here once they reach Dispatched. Their full history is kept.')
        : emptyState('No active projects', u.role === 'designer' || u.role === 'dm'
          ? 'Projects assigned to you will appear here.'
          : 'Create a project to get started.',
        canCreate(u.role) ? el('a', { class: 'btn primary', href: '#/new', text: 'Create Project' }) : null));
    } else if (!shown.length) {
      listEl.replaceChildren(emptyState('No matching projects', 'Try a different search or clear the filters.'));
    } else {
      listEl.replaceChildren(el('div', { class: 'list' }, shown.map((p, i) => projectCard(p, i, u))));
    }
  }

  function projectCard(p, i, user) {
    const attention = alertFor(user.role, p);
    const card = el('article', { class: 'card project' },
      el('div', { class: 'p-top' },
        el('div', { class: 'p-title' },
          el('span', { class: 'pid', text: p.project_id }),
          el('h3', { class: 'pname' }, el('a', { class: 'stretch', href: `#/project/${p.id}`, text: p.project_name })),
          tag(p.current_status),
          attention ? blink(attention) : null),
        canEditStatus(user.role) && p.next_status
          ? el('button', { class: 'btn small ghost edit', type: 'button', text: 'Edit Status', onclick: () => advanceFlow(p, draw) })
          : null),
      el('dl', { class: 'meta' },
        metaItem('Designer', p.designer.name),
        metaItem('DM', p.dm.name),
        metaItem('Last Updated', fmtDate(p.updated_at))));
    card.style.setProperty('--i', String(Math.min(i, 10)));
    return card;
  }

  search.addEventListener('input', () => { state.filters.q = search.value; draw(); });
  pidIn.addEventListener('input', () => { state.filters.pid = pidIn.value; draw(); });
  nameIn.addEventListener('input', () => { state.filters.name = nameIn.value; draw(); });
  statusSel.addEventListener('change', () => { state.filters.status = statusSel.value; draw(); });

  const head = el('div', { class: 'page-head' },
    el('div', { class: 'grow' },
      el('h1', { text: mode === 'dashboard' ? 'Dashboard' : 'Projects' }),
      mode === 'dashboard' ? el('p', { class: 'sub', text: `Welcome back, ${u.name}.` }) : null),
    canCreate(u.role) ? el('a', { class: 'btn primary', href: '#/new' }, icon('plus'), 'Create Project') : null);

  const page = shell(mode, head, statsEl, tabsEl, toolbar, listEl);

  const load = async () => {
    if (state.saving) return;
    try {
      state.projects = await data.projects();
      state.loaded = true;
      draw();
    } catch (e) {
      if (!state.loaded) listEl.replaceChildren(emptyState('Could not load projects', e.message));
    }
  };
  state.refresh = load;
  if (state.loaded) draw();
  load();
  return page;
}

export const viewDashboard = () => renderList('dashboard');
export const viewProjects = () => renderList('projects');

// ================================================================ project details

function personBlock(title, person) {
  return el('div', { class: 'person' },
    el('dt', { text: title }),
    el('dd', {}, el('span', { class: 'person-name', text: person.name }), el('span', { class: 'person-email', text: person.email })));
}

function activityItem(h, i) {
  const created = h.previous_status == null;
  const row = (k, v) => el('div', { class: 'a-row' }, el('dt', { text: k }), el('dd', {}, v));
  return el('li', { class: 'activity' + (h.pending ? ' pending' : '') },
    el('span', { class: 'a-dot', 'aria-hidden': 'true' }),
    el('div', { class: 'a-card' },
      el('div', { class: 'a-title' },
        el('span', { text: `Activity ${i + 1} – ${created ? 'Project Created' : 'Status Updated'}` }),
        h.pending ? el('span', { class: 'saving', text: 'Saving…' }) : null),
      el('dl', { class: 'a-meta' },
        row(created ? 'Created By' : 'Changed By', h.by.name),
        row('Email', h.by.email),
        created ? row('Initial Status', tag(h.new_status)) : [row('Previous Status', tag(h.previous_status)), row('New Status', tag(h.new_status))],
        row('Date', fmtDate(h.changed_at)),
        row('Time', fmtTime(h.changed_at)))));
}

export function viewProject(id) {
  const u = state.user;
  state.detail = null;
  const page = shell('projects', skeletonList(2));

  function draw() {
    const d = state.detail;
    if (!d) return;
    const { project: p, history } = d;
    const idx = statusIndex(p.current_status);
    const reached = {};
    history.forEach((h) => { reached[h.new_status] = h.changed_at; });

    const steps = el('ol', { class: 'steps', 'aria-label': 'Workflow progress' },
      STATUSES.map((s, i) => el('li', { class: `step ${i < idx ? 'done' : i === idx ? `current s${i + 1}` : 'upcoming'}`, 'aria-current': i === idx ? 'step' : false },
        el('span', { class: 'dot', 'aria-hidden': 'true', text: i < idx ? '✓' : String(i + 1) }),
        el('span', { class: 'step-text' },
          el('span', { class: 'step-name', text: label(s) }),
          reached[s] && i <= idx ? el('span', { class: 'step-date', text: `${fmtDate(reached[s])}, ${fmtTime(reached[s])}` }) : null))));

    const editBtn = canEditStatus(u.role) && p.next_status
      ? el('button', { class: 'btn primary', type: 'button', text: 'Edit Status', onclick: () => advanceFlow(p, draw) })
      : null;

    page.replaceChildren(
      el('a', { class: 'back', href: isDispatched(p) ? '#/projects' : '#/' }, icon('back'), isDispatched(p) ? 'Completed projects' : 'Dashboard'),
      el('section', { class: 'panel' },
        el('div', { class: 'detail-head' },
          el('div', { class: 'grow' },
            el('span', { class: 'pid big', text: p.project_id }),
            el('div', { class: 'title-row' }, el('h1', { text: p.project_name }), tag(p.current_status, true))),
          editBtn),
        el('dl', { class: 'detail-grid' },
          personBlock('Designer', p.designer),
          personBlock('DM', p.dm),
          personBlock('Created By', p.created_by),
          metaItem('Created', `${fmtDate(p.created_at)}, ${fmtTime(p.created_at)}`),
          metaItem('Last Updated', `${fmtDate(p.updated_at)}, ${fmtTime(p.updated_at)}`)),
        !p.next_status ? el('p', { class: 'final-note', text: 'This project has been dispatched. The workflow is complete.' }) : null),
      el('section', { class: 'panel' },
        el('h2', { class: 'section-title', text: 'Workflow progress' }),
        steps),
      el('section', { class: 'panel' },
        el('h2', { class: 'section-title', text: 'Activity history' }),
        el('ol', { class: 'timeline', 'aria-label': 'Activity history' }, history.map(activityItem))));
  }

  async function load() {
    if (state.saving) return;
    try {
      state.detail = await data.project(id);
      draw();
    } catch (e) {
      if (!state.detail) {
        page.replaceChildren(
          el('a', { class: 'back', href: '#/' }, icon('back'), 'Dashboard'),
          emptyState(e.status === 404 ? 'Project not found' : 'Could not load project', e.message));
      }
    }
  }
  state.refresh = load;
  load();
}

// ================================================================ create project

export async function viewCreate() {
  const u = state.user;
  if (!canCreate(u.role)) return go('#/');

  const error = el('div', { class: 'error-box', role: 'alert', hidden: true });
  const idInput = el('input', { id: 'f-id', class: 'input', type: 'text', inputmode: 'numeric', maxlength: '6', autocomplete: 'off', placeholder: '025', 'aria-describedby': 'f-id-hint', 'data-autofocus': true });
  idInput.addEventListener('input', () => { idInput.value = idInput.value.replace(/\D/g, '').slice(0, 6); });
  const nameInput = el('input', { id: 'f-name', class: 'input', type: 'text', maxlength: '120', autocomplete: 'off' });
  const designer = combo({ id: 'f-designer', placeholder: 'Search designers by name or email', emptyText: 'No active Designers registered yet. Ask the Super Admin to add one.' });
  const dm = combo({ id: 'f-dm', placeholder: 'Search DMs by name or email', emptyText: 'No active DMs registered yet. Ask the Super Admin to add one.' });
  const submit = el('button', { class: 'btn primary', type: 'submit', text: 'Create project' });

  const field = (lbl, forId, control, hint, hintId) => el('div', { class: 'field' },
    el('label', { for: forId, text: lbl }), control, hint ? el('span', { class: 'hint', id: hintId, text: hint }) : null);

  const form = el('form', { class: 'form', novalidate: true },
    field('Project ID', 'f-id', el('div', { class: 'idfield' }, el('span', { class: 'prefix', text: 'PJ-' }), idInput),
      'Enter the number yourself, for example 025. IDs are never generated automatically.', 'f-id-hint'),
    field('Project Name', 'f-name', nameInput),
    field('Designer', 'f-designer', designer.el),
    field('DM', 'f-dm', dm.el),
    el('p', { class: 'hint' }, 'The project starts automatically at ', tag(STATUSES[0]), '.'),
    error,
    el('div', { class: 'actions' }, submit, el('a', { class: 'btn ghost', href: '#/', text: 'Cancel' })));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.hidden = true;
    const digits = idInput.value;
    const fail = (m) => { error.textContent = m; error.hidden = false; };
    if (!/^[0-9]{1,6}$/.test(digits)) return fail('Enter the Project ID number (1 to 6 digits), for example 025.');
    if (!nameInput.value.trim()) return fail('Enter the project name.');
    if (!designer.value) return fail('Choose a Designer from the list.');
    if (!dm.value) return fail('Choose a DM from the list.');
    try {
      const created = await busy(submit, () => data.createProject({
        projectId: `PJ-${digits}`, name: nameInput.value, designerId: designer.value, dmId: dm.value,
      }));
      state.loaded = false;
      if (u.role === 'dm' && created.dm.id !== u.id) {
        toast(`${created.project_id} created and assigned to ${created.dm.name}. It appears on their dashboard.`);
      } else {
        toast(`${created.project_id} created`);
      }
      go('#/');
    } catch (ex) { fail(ex.message); }
  });

  shell('projects',
    el('a', { class: 'back', href: '#/' }, icon('back'), 'Dashboard'),
    el('div', { class: 'page-head' }, el('h1', { text: 'Create Project' })),
    el('div', { class: 'panel narrow' }, form));
  idInput.focus();

  try {
    const a = await data.assignable();
    designer.setItems(a.designers);
    dm.setItems(a.dms);
  } catch (e) { error.textContent = e.message; error.hidden = false; }
}
