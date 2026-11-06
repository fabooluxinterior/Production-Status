// Dashboard, project list, project details (with activity history) and Create Project.
import { data } from './data.js';
import { go, shell, state } from './core.js';
import { blink, busy, chooseModal, combo, confirmModal, emptyState, skeletonList, tag } from './ui.js';
import { acknowledge, attentionFor, loadNotifs, noteText, openNotifs, onNotifs } from './notifications.js';
import {
  ACTION, NEXT, ST_DISPATCHED, ST_FACTORY, ST_PRODUCTION, ST_RND, STATUSES,
  el, fmtDate, fmtTime, icon, isDispatched, label, nextStatus, statusIndex, toast,
} from './util.js';

const canCreate = (role) => role === 'super_admin' || role === 'admin' || role === 'dm';
const canEditStatus = (role) => role === 'super_admin' || role === 'admin';

// Attention comes from notifications (Super Admin: R&D; Admin: Factory and Production) and stays
// until the person acknowledges it or the project moves on.
const prefersReduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function applyFilters(list, f) {
  const q = f.q.trim().toLowerCase();
  const pid = f.pid.trim().toLowerCase();
  const nm = f.name.trim().toLowerCase();
  return list.filter((p) =>
    (!f.status || p.current_status === f.status) &&
    (!f.attn || attentionFor(p.id)) &&
    (!q || [p.project_id, p.project_name, p.designer.name, p.designer.email, p.dm.name, p.dm.email]
      .some((v) => String(v).toLowerCase().includes(q))) &&
    (!pid || p.project_id.toLowerCase().includes(pid)) &&
    (!nm || p.project_name.toLowerCase().includes(nm)));
}

const metaItem = (k, v) => el('div', {}, el('dt', { text: k }), el('dd', { text: v }));

// ================================================================ status change (shared by cards and details)

// Confirm, update the screen immediately, save in the background, and roll back if the save fails.
export async function advanceFlow(project, redraw) {
  const options = project.next_options || [];
  if (!options.length) return;
  const header = [
    el('p', { class: 'muted', text: `${project.project_id} · ${project.project_name}` }),
    el('div', { class: 'flow' }, tag(project.current_status), el('span', { class: 'arrow', 'aria-hidden': 'true', text: '→' }),
      options.length === 1 ? tag(options[0], true) : el('span', { class: 'muted', text: 'Choose the next step' })),
  ];
  const note = el('p', { class: 'muted small', text: 'This is recorded in the project history with your name and the time.' });
  let next;
  if (options.length === 1) {
    next = options[0];
    const fromRnd = project.current_status === 'SENT BACK TO R&D';
    const ok = await confirmModal({
      title: fromRnd ? 'R&D changes done' : 'Update project status',
      confirmText: fromRnd ? 'Send to Factory' : 'Confirm update',
      body: [...header, fromRnd ? el('p', { class: 'muted small', text: 'R&D has made the changes. The project goes back to Factory checking and the Admin is alerted. This is recorded in the history.' }) : note],
    });
    if (!ok) return;
  } else {
    next = await chooseModal({
      title: 'Update project status', body: [...header, note],
      options: options.map((o) => ({ value: o, title: (ACTION[o] || [label(o)])[0], desc: (ACTION[o] || ['', ''])[1] })),
    });
    if (!next) return;
  }
  // A project that is being completed slides out of the active list before it moves.
  if (next === ST_DISPATCHED && !prefersReduced()) {
    const card = document.querySelector(`[data-pk="${project.id}"]`);
    if (card && card.classList.contains('project')) {
      card.classList.add('leaving');
      await new Promise((r) => setTimeout(r, 280));
    }
  }

  const before = { projects: state.projects, detail: state.detail };
  const now = new Date().toISOString();
  const nextOptions = NEXT[next] || [];
  const optimistic = { ...project, current_status: next, next_options: nextOptions, next_status: nextOptions[0] || null, updated_at: now };
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
    loadNotifs(state.user.role);   // new alerts for others, and this one is now handled
    toast(res.project.current_status === ST_DISPATCHED
      ? `${res.project.project_id} moved to Completed Projects`
      : `Status updated to ${label(res.project.current_status)}`);
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
  const count = (st) => all.filter((p) => p.current_status === st).length;
  const active = all.filter((p) => !isDispatched(p)).length;
  const waiting = (...events) => openNotifs().filter((n) => events.includes(n.event)).length;
  const completed = { label: 'Completed Projects', n: count(ST_DISPATCHED), completed: true };
  if (role === 'super_admin') {
    const attn = waiting('rnd_received', 'rnd_sent_back');
    return [
      { label: 'Total Active Projects', n: active },
      { label: 'Checking at R&D', n: count(ST_RND), filter: ST_RND },
      { label: 'R&D Attention Required', n: attn, attn: true, alertText: 'NEEDS ATTENTION' },
      completed,
    ];
  }
  if (role === 'admin') {
    return [
      { label: 'Total Active Projects', n: active },
      { label: 'Checking at Factory', n: count(ST_FACTORY), filter: ST_FACTORY, waiting: waiting('factory_received'), alertText: 'FACTORY CHECKING' },
      { label: 'Under Production', n: count(ST_PRODUCTION), filter: ST_PRODUCTION, waiting: waiting('production_started'), alertText: 'IN PRODUCTION' },
      completed,
    ];
  }
  if (role === 'designer') {
    return [
      { label: 'My Active Projects', n: active },
      { label: 'My Assigned Projects', n: all.length },
      { label: 'Needs My Attention', n: waiting('designer_sent_back', 'designer_final_sod'), attn: true, alertText: 'NEEDS ATTENTION' },
      completed,
    ];
  }
  return [
    { label: 'My Active Projects', n: active },
    { label: 'My Assigned Projects', n: all.length },
    completed,
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

  let rendered = new Map();   // what is on screen: lets only new or changed cards animate
  let statsShown = false;

  function draw() {
    if (!state.loaded) return;
    const all = state.projects;
    const completed = state.tab === 'completed';
    if (statsEl) {
      statsEl.replaceChildren(...statTiles(u.role, all).map((t, i) => {
        const alerting = t.attn ? t.n > 0 : (t.waiting || 0) > 0;
        const watched = t.attn || t.alertText;
        const clickable = t.filter || t.attn || t.completed;
        const isOn = (t.filter && state.filters.status === t.filter) || (t.attn && state.filters.attn);
        const tile = el('button', {
          type: 'button',
          class: 'stat' + (watched ? ' watch' : '') + (alerting ? ' alerting' : '') + (isOn ? ' on' : ''),
          disabled: !clickable,
          onclick: () => {
            if (t.completed) { state.tab = 'completed'; go('#/projects'); return; }
            if (t.attn) { state.filters.attn = !state.filters.attn; draw(); return; }
            state.filters.status = state.filters.status === t.filter ? '' : t.filter;
            statusSel.value = state.filters.status;
            draw();
          },
        },
        el('span', { class: 'lbl', text: t.label }),
        el('span', { class: 'num-row' }, el('span', { class: 'num', text: String(t.n) }), alerting ? el('span', { class: 'blink-dot', 'aria-hidden': 'true' }) : null),
        watched ? el('span', { class: 'note', text: alerting ? (t.alertText || 'NEEDS ATTENTION') : 'All clear' }) : null);
        tile.style.setProperty('--i', String(i));
        if (!statsShown) tile.classList.add('enter');
        return tile;
      }));
      statsShown = true;
    }
    const base = all.filter((p) => (completed ? isDispatched(p) : !isDispatched(p)));
    if (tabsEl) {
      const nCompleted = all.filter(isDispatched).length;
      tabsEl.replaceChildren(
        el('button', { type: 'button', role: 'tab', 'aria-selected': String(!completed), class: 'tab' + (!completed ? ' on' : ''), text: `Active (${all.length - nCompleted})`, onclick: () => { state.tab = 'active'; draw(); } }),
        el('button', { type: 'button', role: 'tab', 'aria-selected': String(completed), class: 'tab' + (completed ? ' on' : ''), text: `Completed Projects (${nCompleted})`, onclick: () => { state.tab = 'completed'; state.filters.status = ''; statusSel.value = ''; draw(); } }));
    }
    statusSel.hidden = completed;

    const shown = applyFilters(base, state.filters);
    if (!base.length) {
      listEl.replaceChildren(completed
        ? emptyState('No completed projects yet', 'Projects move here automatically once they are dispatched. Their details, assignments and history are kept.')
        : emptyState('No active projects', u.role === 'designer' || u.role === 'dm'
          ? 'Projects assigned to you will appear here.'
          : 'Create a project to get started.',
        canCreate(u.role) ? el('a', { class: 'btn primary', href: '#/new', text: 'Create Project' }) : null));
    } else if (!shown.length) {
      listEl.replaceChildren(emptyState('No matching projects', 'Try a different search or clear the filters.'));
    } else {
      const prev = rendered;
      rendered = new Map(shown.map((p) => [p.id, p.current_status]));
      listEl.replaceChildren(el('div', { class: 'list' }, shown.map((p, i) => projectCard(p, i, u, prev))));
    }
  }

  function projectCard(p, i, user, prev) {
    const attention = attentionFor(p.id);
    const before = prev.get(p.id);
    const anim = before === undefined ? ' enter' : before !== p.current_status ? ' changed' : '';
    const done = isDispatched(p);
    const card = el('article', { class: 'card project' + anim + (attention ? ' attn' : ''), 'data-pk': p.id },
      el('div', { class: 'p-top' },
        el('span', { class: 'pid', text: p.project_id }),
        el('h3', { class: 'pname' }, el('a', { class: 'stretch', href: `#/project/${p.id}`, text: p.project_name })),
        el('div', { class: 'p-status' }, tag(p.current_status), attention ? blink(noteText(attention)) : null),
        el('div', { class: 'p-actions' },
          attention ? el('button', { class: 'btn small ghost ack', type: 'button', text: 'Acknowledge', onclick: () => acknowledge(attention.id) }) : null,
          canEditStatus(user.role) && p.next_status
            ? el('button', { class: 'btn small ghost edit', type: 'button', text: 'Edit Status', onclick: () => advanceFlow(p, draw) })
            : null)),
      el('dl', { class: 'meta' },
        metaItem('Designer', p.designer.name),
        metaItem('DM', p.dm.name),
        metaItem(done ? 'Completed' : 'Last Updated', fmtDate(p.updated_at))));
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
  const off = onNotifs(() => { if (!page.isConnected) { off(); return; } draw(); });
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

// One plain line per change: when, who, and what changed. No cards or boxes.
function activityItem(h) {
  const created = h.previous_status == null;
  const who = `${h.by.name} (${h.by.email})`;
  return el('li', { class: 'activity' + (h.pending ? ' pending' : '') },
    el('span', { class: 'h-when', text: `${fmtDate(h.changed_at)}, ${fmtTime(h.changed_at)}` }),
    el('span', { class: 'h-what', text: created
      ? `${who} created the project. Initial status: ${label(h.new_status)}.`
      : `${who} changed the status from ${label(h.previous_status)} to ${label(h.new_status)}.` }),
    h.pending ? el('span', { class: 'saving', text: 'Saving…' }) : null);
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
      STATUSES.map((s, i) => {
        const skipped = i < idx && !reached[s];   // e.g. Sent Back to R&D when Factory went straight to Final SOD
        const done = i !== idx && !!reached[s];   // reached at some point (also after a return to Factory)
        return el('li', { class: `step ${skipped ? 'skipped' : done ? 'done' : i === idx ? `current s${i + 1}` : 'upcoming'}`, 'aria-current': i === idx ? 'step' : false },
          el('span', { class: 'dot', 'aria-hidden': 'true', text: skipped ? '–' : done ? '✓' : String(i + 1) }),
          el('span', { class: 'step-text' },
            el('span', { class: 'step-name', text: label(s) }),
            skipped ? el('span', { class: 'step-date', text: 'Not needed' }) : null,
            reached[s] ? el('span', { class: 'step-date', text: `${fmtDate(reached[s])}, ${fmtTime(reached[s])}` }) : null));
      }));
    const attention = attentionFor(p.id);

    const editBtn = canEditStatus(u.role) && p.next_status
      ? el('button', { class: 'btn primary', type: 'button', text: 'Edit Status', onclick: () => advanceFlow(p, draw) })
      : null;

    page.replaceChildren(...[
      el('a', { class: 'back', href: isDispatched(p) ? '#/projects' : '#/' }, icon('back'), isDispatched(p) ? 'Completed Projects' : 'Dashboard'),
      attention ? el('div', { class: 'attn-banner', role: 'status' },
        blink(noteText(attention)),
        el('span', { class: 'grow' }),
        el('button', { class: 'btn small', type: 'button', text: 'Acknowledge', onclick: () => acknowledge(attention.id) })) : null,
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
        el('ul', { class: 'history', 'aria-label': 'Activity history' }, history.map(activityItem))),
    ].filter(Boolean));
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
  const off = onNotifs(() => { if (!page.isConnected) { off(); return; } draw(); });
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
