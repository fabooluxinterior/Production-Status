-- Faboolux Production Status: database setup (version 2).
-- Run in Supabase: SQL Editor -> New query -> paste -> Run.
-- Safe on a brand-new project AND on one that already ran version 1:
--   users and logins are kept; old test projects are set aside in *_v1_backup tables (not deleted).

-- ================================================================ 0. upgrade from version 1
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'projects' and column_name = 'designer_email') then
    drop policy if exists projects_read on public.projects;
    drop policy if exists history_read on public.project_status_history;
    drop function if exists public.create_project(text, text, text, text);
    drop function if exists public.advance_project(bigint, text);
    drop function if exists public.my_email();
    drop index if exists public.projects_project_id_ci, public.projects_designer_idx,
                         public.projects_dm_idx, public.history_project_idx;
    alter table public.project_status_history rename to project_status_history_v1_backup;
    alter table public.projects rename to projects_v1_backup;
    alter index if exists public.projects_pkey rename to projects_v1_backup_pkey;
    alter index if exists public.project_status_history_pkey rename to project_status_history_v1_backup_pkey;
    revoke all on public.projects_v1_backup, public.project_status_history_v1_backup from anon, authenticated;
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
      begin alter publication supabase_realtime drop table public.projects_v1_backup; exception when others then null; end;
      begin alter publication supabase_realtime drop table public.project_status_history_v1_backup; exception when others then null; end;
    end if;
  end if;
end $$;

-- ================================================================ 1. tables

create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text not null unique check (email = lower(email)),
  role       text not null check (role in ('super_admin', 'admin', 'designer', 'dm')),
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.profiles add column if not exists name text not null default '' check (char_length(name) <= 100);
alter table public.profiles add column if not exists must_change_password boolean not null default false;
alter table public.profiles add column if not exists theme text not null default 'dark' check (theme in ('dark', 'light'));
alter table public.profiles add column if not exists updated_at timestamptz not null default now();

update public.profiles
   set name = case when role = 'super_admin' then 'Super Admin' else initcap(split_part(email, '@', 1)) end
 where name = '';

create table if not exists public.projects (
  id               bigint generated always as identity primary key,
  project_id       text not null check (project_id ~ '^PJ-[0-9]{1,6}$'),
  project_name     text not null check (char_length(project_name) between 1 and 120),
  designer_user_id uuid not null references public.profiles (id),
  dm_user_id       uuid not null references public.profiles (id),
  current_status   text not null default 'CHECKING AT R&D' check (current_status in (
    'CHECKING AT R&D', 'SENT BACK TO DESIGNER', 'CHECKING AT FACTORY', 'SENT BACK TO R&D',
    'FINAL SOD PENDING', 'UNDER PRODUCTION', 'DISPATCHED')),
  created_by       uuid not null references public.profiles (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
-- PJ-025 and PJ-25 are the same number, so they count as duplicates.
create unique index if not exists projects_project_id_key on public.projects (project_id);
create unique index if not exists projects_project_id_num on public.projects (((substring(project_id from 4))::bigint));
create index if not exists projects_designer_idx on public.projects (designer_user_id);
create index if not exists projects_dm_idx on public.projects (dm_user_id);
create index if not exists projects_status_idx on public.projects (current_status);

create table if not exists public.project_status_history (
  id              bigint generated always as identity primary key,
  project_id      bigint not null references public.projects (id),
  previous_status text,
  new_status      text not null check (new_status in (
    'CHECKING AT R&D', 'SENT BACK TO DESIGNER', 'CHECKING AT FACTORY', 'SENT BACK TO R&D',
    'FINAL SOD PENDING', 'UNDER PRODUCTION', 'DISPATCHED')),
  changed_by      uuid not null references public.profiles (id),
  changed_at      timestamptz not null default now()
);
create index if not exists history_project_idx on public.project_status_history (project_id, id);

create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  actor_id    uuid,
  actor_email text,
  action      text not null,
  target_type text,
  target_id   text,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists audit_created_idx on public.audit_log (created_at desc);

-- Attention notifications. One row per event (a project reaches each stage only once, so the
-- unique index also prevents duplicates). Each person acknowledges for themselves.
create table if not exists public.notifications (
  id          bigint generated always as identity primary key,
  project_id  bigint not null references public.projects (id),
  event       text not null,
  target_role text not null,
  status      text not null,          -- the project status this notification is about
  created_by  uuid references public.profiles (id),
  created_at  timestamptz not null default now()
);
alter table public.notifications add column if not exists target_user uuid references public.profiles (id);   -- set for Designer and DM alerts
alter table public.notifications drop constraint if exists notifications_event_check;
alter table public.notifications drop constraint if exists notifications_target_role_check;
alter table public.notifications add constraint notifications_event_check check (event in (
  'rnd_received', 'rnd_sent_back', 'factory_received', 'production_started', 'designer_sent_back', 'designer_final_sod'));
alter table public.notifications add constraint notifications_target_role_check check (target_role in ('super_admin', 'admin', 'designer', 'dm'));

-- Each notification belongs to the status change (history row) that caused it, so a project that
-- returns to Factory or R&D later raises a fresh alert, and repeating the same change can't duplicate it.
alter table public.notifications add column if not exists history_id bigint references public.project_status_history (id);
drop trigger if exists notifications_immutable on public.notifications;   -- recreated below
update public.notifications n set history_id = (
    select max(h.id) from public.project_status_history h where h.project_id = n.project_id and h.new_status = n.status)
  where n.history_id is null;
drop index if exists public.notifications_event_key;
drop index if exists public.notifications_history_key;
create unique index if not exists notifications_history_role_key on public.notifications (history_id, target_role);
create index if not exists notifications_role_idx on public.notifications (target_role, created_at desc);

create table if not exists public.notification_acks (
  notification_id bigint not null references public.notifications (id),
  user_id         uuid not null references public.profiles (id),
  acked_at        timestamptz not null default now(),
  primary key (notification_id, user_id)
);

-- ================================================================ 2. who is calling?
-- my_role() is NULL (= no access to anything) when the person is deactivated, must still
-- change a temporary password, or their login session was revoked.

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select p.role from public.profiles p
  where p.id = auth.uid() and p.is_active and not p.must_change_password
    and ((auth.jwt() ->> 'session_id') is null
         or exists (select 1 from auth.sessions s where s.id = ((auth.jwt() ->> 'session_id')::uuid)))
$$;

create or replace function public.require_role(p_roles text[]) returns text
language plpgsql stable security definer set search_path = public as $$
declare r text := public.my_role();
begin
  if r is null then raise exception 'AUTH_REQUIRED: Please sign in again.'; end if;
  if not (r = any (p_roles)) then raise exception 'You don''t have permission to do that.'; end if;
  return r;
end $$;

create or replace function public.project_visible(p_designer uuid, p_dm uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case public.my_role()
    when 'super_admin' then true
    when 'admin' then true
    when 'designer' then p_designer = auth.uid()
    when 'dm' then p_dm = auth.uid()
    else false end
$$;

create or replace function public.session_alive(p_session uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_session is null or exists (select 1 from auth.sessions s where s.id = p_session)
$$;

create or replace function public.revoke_user_sessions(p_user uuid, p_keep uuid default null) returns void
language sql security definer set search_path = public as $$
  delete from auth.sessions where user_id = p_user and (p_keep is null or id <> p_keep)
$$;

-- ================================================================ 3. integrity triggers

create or replace function public.guard_profile_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from old.role then
    if old.role = 'super_admin' or new.role = 'super_admin' then
      raise exception 'The Super Admin role can''t be changed.';
    end if;
    if exists (select 1 from public.projects where designer_user_id = old.id or dm_user_id = old.id) then
      raise exception 'This user is assigned to projects, so their role can''t be changed. Deactivate them instead.';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before update on public.profiles
  for each row execute function public.guard_profile_change();

create or replace function public.check_project_row() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if new.project_id is distinct from old.project_id then
      raise exception 'A Project ID can''t be changed once it is created.';
    end if;
  else
    if not exists (select 1 from public.profiles where id = new.designer_user_id and role = 'designer') then
      raise exception 'The Designer must be a user with the Designer role.';
    end if;
    if not exists (select 1 from public.profiles where id = new.dm_user_id and role = 'dm') then
      raise exception 'The DM must be a user with the DM role.';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists projects_check on public.projects;
create trigger projects_check before insert or update on public.projects
  for each row execute function public.check_project_row();

-- History and audit rows can never be edited or deleted by anyone.
create or replace function public.block_modification() returns trigger
language plpgsql as $$
begin
  raise exception '% is permanent and can''t be modified.', tg_table_name;
end $$;
drop trigger if exists history_immutable on public.project_status_history;
create trigger history_immutable before update or delete on public.project_status_history
  for each row execute function public.block_modification();
drop trigger if exists history_no_truncate on public.project_status_history;
create trigger history_no_truncate before truncate on public.project_status_history
  for each statement execute function public.block_modification();
drop trigger if exists audit_immutable on public.audit_log;
create trigger audit_immutable before update or delete on public.audit_log
  for each row execute function public.block_modification();
drop trigger if exists audit_no_truncate on public.audit_log;
create trigger audit_no_truncate before truncate on public.audit_log
  for each statement execute function public.block_modification();

drop trigger if exists notifications_immutable on public.notifications;
create trigger notifications_immutable before update or delete on public.notifications
  for each row execute function public.block_modification();
drop trigger if exists notifications_no_truncate on public.notifications;
create trigger notifications_no_truncate before truncate on public.notifications
  for each statement execute function public.block_modification();
drop trigger if exists acks_immutable on public.notification_acks;
create trigger acks_immutable before update or delete on public.notification_acks
  for each row execute function public.block_modification();

-- ================================================================ 4. row level security
-- Browsers can only READ. Every change goes through the functions below or the admin-users function.

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.project_status_history enable row level security;
alter table public.audit_log enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_acks enable row level security;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (
  id = auth.uid() or public.my_role() = 'super_admin'
);

drop policy if exists projects_read on public.projects;
create policy projects_read on public.projects for select to authenticated using (
  public.project_visible(designer_user_id, dm_user_id)
);

drop policy if exists history_read on public.project_status_history;
create policy history_read on public.project_status_history for select to authenticated using (
  exists (select 1 from public.projects p where p.id = project_status_history.project_id)
);

drop policy if exists audit_read on public.audit_log;
create policy audit_read on public.audit_log for select to authenticated using (public.my_role() = 'super_admin');

drop policy if exists notifications_read on public.notifications;
create policy notifications_read on public.notifications for select to authenticated using (target_role = public.my_role() and (target_user is null or target_user = auth.uid()));
drop policy if exists acks_read on public.notification_acks;
create policy acks_read on public.notification_acks for select to authenticated using (user_id = auth.uid() and public.my_role() is not null);

revoke all on all tables in schema public from anon, authenticated;
grant select on public.profiles, public.projects, public.project_status_history, public.audit_log,
                public.notifications, public.notification_acks to authenticated;

-- ================================================================ 5. helpers

create or replace function public.audit(p_action text, p_target_type text, p_target_id text, p_details jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_log (actor_id, actor_email, action, target_type, target_id, details)
  values (auth.uid(), (select email from public.profiles where id = auth.uid()), p_action, p_target_type, p_target_id,
          coalesce(p_details, '{}'::jsonb));
end $$;

-- Allowed next stages. After CHECKING AT FACTORY there are two choices. A project sent back to R&D
-- returns to the Factory once R&D has made its changes. Everything else is one step forward.
create or replace function public.next_statuses(p_status text) returns text[]
language sql immutable as $$
  select case p_status
    when 'CHECKING AT R&D'        then array['SENT BACK TO DESIGNER']
    when 'SENT BACK TO DESIGNER'  then array['CHECKING AT FACTORY']
    when 'CHECKING AT FACTORY'    then array['SENT BACK TO R&D', 'FINAL SOD PENDING']
    when 'SENT BACK TO R&D'       then array['CHECKING AT FACTORY']   -- R&D made changes: back to the Factory
    when 'FINAL SOD PENDING'      then array['UNDER PRODUCTION']
    when 'UNDER PRODUCTION'       then array['DISPATCHED']
    else array[]::text[] end
$$;

-- Records the attention event that a status change causes (once per status change).
drop function if exists public.notify_for_status(bigint, text, uuid);
create or replace function public.notify_for_status(p_project bigint, p_status text, p_by uuid, p_history bigint) returns void
language plpgsql security definer set search_path = public as $$
declare proj public.projects;
begin
  select * into proj from public.projects where id = p_project;
  -- (event, who is alerted, which person)
  insert into public.notifications (project_id, event, target_role, target_user, status, created_by, history_id)
  select p_project, v.e, v.r,
         case v.r when 'designer' then proj.designer_user_id when 'dm' then proj.dm_user_id end,
         p_status, p_by, p_history
  from (values
    ('CHECKING AT R&D',       'rnd_received',       'super_admin'),
    ('SENT BACK TO R&D',      'rnd_sent_back',      'super_admin'),
    ('CHECKING AT FACTORY',   'factory_received',   'admin'),
    ('UNDER PRODUCTION',      'production_started', 'admin'),
    ('SENT BACK TO DESIGNER', 'designer_sent_back', 'designer'),
    ('SENT BACK TO DESIGNER', 'designer_sent_back', 'dm'),
    ('FINAL SOD PENDING',     'designer_final_sod', 'designer'),
    ('FINAL SOD PENDING',     'designer_final_sod', 'dm')) v(s, e, r)
  where v.s = p_status
  on conflict (history_id, target_role) do nothing;
end $$;

create or replace function public.user_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', u.id, 'name', coalesce(nullif(u.name, ''), u.email), 'email', u.email)
  from public.profiles u where u.id = p_id
$$;

create or replace function public.project_json(p_id bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', p.id, 'project_id', p.project_id, 'project_name', p.project_name,
    'current_status', p.current_status,
    'next_options', to_jsonb(public.next_statuses(p.current_status)),
    'designer', public.user_json(p.designer_user_id),
    'dm', public.user_json(p.dm_user_id),
    'created_by', public.user_json(p.created_by),
    'created_at', p.created_at, 'updated_at', p.updated_at)
  from public.projects p where p.id = p_id
$$;

create or replace function public.history_json(p_id bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'previous_status', h.previous_status, 'new_status', h.new_status,
      'changed_at', h.changed_at, 'by', public.user_json(h.changed_by)) order by h.id), '[]'::jsonb)
  from public.project_status_history h where h.project_id = p_id
$$;

-- ================================================================ 6. functions the website calls

create or replace function public.my_profile() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', p.id, 'name', coalesce(nullif(p.name, ''), p.email), 'email', p.email, 'role', p.role,
    'is_active', p.is_active, 'must_change_password', p.must_change_password, 'theme', p.theme,
    'created_at', p.created_at,
    'session_valid', ((auth.jwt() ->> 'session_id') is null
                      or exists (select 1 from auth.sessions s where s.id = ((auth.jwt() ->> 'session_id')::uuid))))
  from public.profiles p where p.id = auth.uid()
$$;

create or replace function public.set_my_theme(p_theme text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED: Please sign in again.'; end if;
  if p_theme not in ('dark', 'light') then raise exception 'Unknown theme.'; end if;
  update public.profiles set theme = p_theme where id = auth.uid();
end $$;

create or replace function public.list_projects() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_role(array['super_admin', 'admin', 'designer', 'dm']);
  return (select coalesce(jsonb_agg(public.project_json(p.id) order by p.updated_at desc, p.id desc), '[]'::jsonb)
          from public.projects p
          where public.project_visible(p.designer_user_id, p.dm_user_id));
end $$;

create or replace function public.get_project(p_id bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p public.projects;
begin
  perform public.require_role(array['super_admin', 'admin', 'designer', 'dm']);
  select * into p from public.projects where id = p_id;
  if not found or not public.project_visible(p.designer_user_id, p.dm_user_id) then
    raise exception 'Project not found.';
  end if;
  return jsonb_build_object('project', public.project_json(p.id), 'history', public.history_json(p.id));
end $$;

create or replace function public.assignable_users() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_role(array['super_admin', 'admin', 'dm']);
  return jsonb_build_object(
    'designers', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', coalesce(nullif(name, ''), email), 'email', email)
                                            order by lower(name), email), '[]'::jsonb)
                  from public.profiles where role = 'designer' and is_active),
    'dms',       (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', coalesce(nullif(name, ''), email), 'email', email)
                                            order by lower(name), email), '[]'::jsonb)
                  from public.profiles where role = 'dm' and is_active));
end $$;

create or replace function public.create_project(p_project_id text, p_name text, p_designer uuid, p_dm uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid  uuid := auth.uid();
  pid  text := upper(trim(coalesce(p_project_id, '')));
  nm   text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
  proj public.projects;
  clash text;
  hid  bigint;
begin
  perform public.require_role(array['super_admin', 'admin', 'dm']);
  if pid !~ '^PJ-[0-9]{1,6}$' then
    raise exception 'Project ID must be PJ- followed by 1 to 6 digits, for example PJ-025.';
  end if;
  if nm = '' or char_length(nm) > 120 then
    raise exception 'Enter a project name (up to 120 characters).';
  end if;
  if p_designer is null or not exists (select 1 from public.profiles where id = p_designer and role = 'designer' and is_active) then
    raise exception 'Choose a registered, active Designer.';
  end if;
  if p_dm is null or not exists (select 1 from public.profiles where id = p_dm and role = 'dm' and is_active) then
    raise exception 'Choose a registered, active DM.';
  end if;
  select project_id into clash from public.projects
   where substring(project_id from 4)::bigint = substring(pid from 4)::bigint;
  if found then
    raise exception 'Project ID % is already in use (%).', pid, clash;
  end if;

  begin
    insert into public.projects (project_id, project_name, designer_user_id, dm_user_id, created_by)
    values (pid, nm, p_designer, p_dm, uid)
    returning * into proj;
  exception when unique_violation then
    raise exception 'Project ID % is already in use.', pid;
  end;

  insert into public.project_status_history (project_id, previous_status, new_status, changed_by)
  values (proj.id, null, proj.current_status, uid)
  returning id into hid;
  perform public.notify_for_status(proj.id, proj.current_status, uid, hid);
  perform public.audit('project.create', 'project', proj.project_id,
                       jsonb_build_object('name', nm, 'designer', p_designer, 'dm', p_dm));
  return public.project_json(proj.id);
end $$;

create or replace function public.advance_project(p_id bigint, p_new_status text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid  uuid := auth.uid();
  cur  public.projects;
  opts text[];
  hid  bigint;
begin
  perform public.require_role(array['super_admin', 'admin']);

  select * into cur from public.projects where id = p_id for update;   -- row lock: no double-advance
  if not found then raise exception 'Project not found.'; end if;

  opts := public.next_statuses(cur.current_status);
  if cardinality(opts) = 0 then
    raise exception 'This project is already DISPATCHED. No further changes are possible.';
  end if;
  if p_new_status is null or not (p_new_status = any (opts)) then
    raise exception 'The project''s status has changed or that stage can''t be skipped to. Refresh and try again.';
  end if;

  update public.projects set current_status = p_new_status, updated_at = now() where id = p_id;
  insert into public.project_status_history (project_id, previous_status, new_status, changed_by)
  values (p_id, cur.current_status, p_new_status, uid)
  returning id into hid;
  perform public.notify_for_status(p_id, p_new_status, uid, hid);
  perform public.audit('project.status', 'project', cur.project_id,
                       jsonb_build_object('from', cur.current_status, 'to', p_new_status));

  return jsonb_build_object('project', public.project_json(p_id), 'history', public.history_json(p_id));
end $$;

-- Notifications for the signed-in Super Admin / Admin (their own role only), newest first.
create or replace function public.list_notifications() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r text := public.require_role(array['super_admin', 'admin', 'designer', 'dm']);
begin
  if r not in ('super_admin', 'admin', 'designer', 'dm') then return '[]'::jsonb; end if;
  return (select coalesce(jsonb_agg(t.x order by t.created desc, t.nid desc), '[]'::jsonb) from (
    select n.created_at as created, n.id as nid,
      jsonb_build_object(
        'id', n.id, 'event', n.event, 'status', n.status, 'created_at', n.created_at, 'target_role', n.target_role,
        'project', p.id, 'project_id', p.project_id, 'project_name', p.project_name,
        'acknowledged_at', a.acked_at,
        'addressed', exists (select 1 from public.project_status_history h where h.project_id = n.project_id and h.id > n.history_id)) as x
    from public.notifications n
    join public.projects p on p.id = n.project_id
    left join public.notification_acks a on a.notification_id = n.id and a.user_id = auth.uid()
    where n.target_role = r and (n.target_user is null or n.target_user = auth.uid())
    order by n.created_at desc, n.id desc
    limit 300) t);
end $$;

create or replace function public.acknowledge_notification(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare r text := public.require_role(array['super_admin', 'admin', 'designer', 'dm']);
begin
  if not exists (select 1 from public.notifications where id = p_id and target_role = r and (target_user is null or target_user = auth.uid())) then
    raise exception 'Notification not found.';
  end if;
  insert into public.notification_acks (notification_id, user_id) values (p_id, auth.uid())
  on conflict do nothing;
end $$;

create or replace function public.acknowledge_all_notifications() returns void
language plpgsql security definer set search_path = public as $$
declare r text := public.require_role(array['super_admin', 'admin', 'designer', 'dm']);
begin
  insert into public.notification_acks (notification_id, user_id)
  select n.id, auth.uid() from public.notifications n where n.target_role = r and (n.target_user is null or n.target_user = auth.uid())
  on conflict do nothing;
end $$;

-- ================================================================ 7. who may run what

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.my_role(), public.project_visible(uuid, uuid) to authenticated;   -- used by the access rules
grant execute on function
  public.my_profile(), public.set_my_theme(text), public.list_projects(), public.get_project(bigint),
  public.assignable_users(), public.create_project(text, text, uuid, uuid), public.advance_project(bigint, text),
  public.list_notifications(), public.acknowledge_notification(bigint), public.acknowledge_all_notifications()
  to authenticated;
grant execute on function public.session_alive(uuid), public.revoke_user_sessions(uuid, uuid) to service_role;

-- ================================================================ 8. live updates

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.projects; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.project_status_history; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.profiles; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.notifications; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.notification_acks; exception when duplicate_object then null; end;
  end if;
end $$;

-- ================================================================ 9. upgrade: attention for projects already waiting
insert into public.notifications (project_id, event, target_role, target_user, status, created_at, history_id)
select p.id, v.e, v.r, case v.r when 'designer' then p.designer_user_id when 'dm' then p.dm_user_id end, p.current_status, p.updated_at,
       (select max(h.id) from public.project_status_history h where h.project_id = p.id and h.new_status = p.current_status)
from public.projects p
join (values ('CHECKING AT R&D', 'rnd_received', 'super_admin'),
             ('SENT BACK TO R&D', 'rnd_sent_back', 'super_admin'),
             ('CHECKING AT FACTORY', 'factory_received', 'admin'),
             ('UNDER PRODUCTION', 'production_started', 'admin'),
             ('SENT BACK TO DESIGNER', 'designer_sent_back', 'designer'),
             ('SENT BACK TO DESIGNER', 'designer_sent_back', 'dm'),
             ('FINAL SOD PENDING', 'designer_final_sod', 'designer'),
             ('FINAL SOD PENDING', 'designer_final_sod', 'dm')) v(s, e, r) on v.s = p.current_status
on conflict (history_id, target_role) do nothing;
