-- Faboolux Production Status: database setup.
-- Run this ONCE in Supabase: SQL Editor -> New query -> paste -> Run.

-- ---------------------------------------------------------------- tables

create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text not null unique check (email = lower(email)),
  role       text not null check (role in ('super_admin', 'admin', 'designer', 'dm')),
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.projects (
  id             bigint generated always as identity primary key,
  project_name   text not null check (char_length(project_name) between 1 and 120),
  project_id     text not null check (project_id ~ '^[A-Za-z0-9][A-Za-z0-9._/ -]{0,39}$'),
  designer_email text not null references public.profiles (email),
  dm_email       text not null references public.profiles (email),
  current_status text not null default 'CHECKING AT R&D' check (current_status in (
    'CHECKING AT R&D', 'SENT BACK TO DESIGNER', 'CHECKING AT FACTORY', 'SENT BACK TO R&D',
    'FINAL SOD PENDING', 'UNDER PRODUCTION', 'DISPATCHED')),
  created_by     uuid not null references public.profiles (id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index if not exists projects_project_id_ci on public.projects (lower(project_id));
create index if not exists projects_designer_idx on public.projects (designer_email);
create index if not exists projects_dm_idx on public.projects (dm_email);

create table if not exists public.project_status_history (
  id              bigint generated always as identity primary key,
  project_id      bigint not null references public.projects (id),
  previous_status text,
  new_status      text not null check (new_status in (
    'CHECKING AT R&D', 'SENT BACK TO DESIGNER', 'CHECKING AT FACTORY', 'SENT BACK TO R&D',
    'FINAL SOD PENDING', 'UNDER PRODUCTION', 'DISPATCHED')),
  updated_by      uuid not null references public.profiles (id),
  updated_at      timestamptz not null default now()
);
create index if not exists history_project_idx on public.project_status_history (project_id);

-- ---------------------------------------------------------------- who is calling?

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and is_active
$$;

create or replace function public.my_email() returns text
language sql stable security definer set search_path = public as $$
  select email from public.profiles where id = auth.uid() and is_active
$$;

-- ---------------------------------------------------------------- row level security
-- Browsers can only READ. Every change goes through the functions below or the admin-users function.

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.project_status_history enable row level security;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (
  id = auth.uid()
  or public.my_role() = 'super_admin'
  or (public.my_role() = 'admin' and role in ('designer', 'dm'))
);

drop policy if exists projects_read on public.projects;
create policy projects_read on public.projects for select to authenticated using (
  public.my_role() in ('super_admin', 'admin')
  or (public.my_role() = 'designer' and designer_email = public.my_email())
  or (public.my_role() = 'dm' and dm_email = public.my_email())
);

drop policy if exists history_read on public.project_status_history;
create policy history_read on public.project_status_history for select to authenticated using (
  exists (select 1 from public.projects p where p.id = project_status_history.project_id)
);

revoke all on all tables in schema public from anon, authenticated;
grant select on public.profiles, public.projects, public.project_status_history to authenticated;

-- ---------------------------------------------------------------- workflow functions

create or replace function public.create_project(
  p_name text, p_project_id text, p_designer text, p_dm text
) returns public.projects
language plpgsql security definer set search_path = public as $$
declare
  uid  uuid := auth.uid();
  nm   text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
  pid  text := trim(coalesce(p_project_id, ''));
  d    text := lower(trim(coalesce(p_designer, '')));
  m    text := lower(trim(coalesce(p_dm, '')));
  proj public.projects;
begin
  if public.my_role() is null or public.my_role() not in ('super_admin', 'admin') then
    raise exception 'You don''t have permission to do that.';
  end if;
  if nm = '' or char_length(nm) > 120 then
    raise exception 'Enter a project name (up to 120 characters).';
  end if;
  if pid !~ '^[A-Za-z0-9][A-Za-z0-9._/ -]{0,39}$' then
    raise exception 'Project ID may use letters, numbers, spaces and . _ - / (up to 40 characters).';
  end if;
  if not exists (select 1 from public.profiles where email = d and role = 'designer' and is_active) then
    raise exception '% is not a registered, active Designer. Add them under Team first.', d;
  end if;
  if not exists (select 1 from public.profiles where email = m and role = 'dm' and is_active) then
    raise exception '% is not a registered, active DM. Add them under Team first.', m;
  end if;
  if exists (select 1 from public.projects where lower(project_id) = lower(pid)) then
    raise exception 'A project with this Project ID already exists.';
  end if;

  insert into public.projects (project_name, project_id, designer_email, dm_email, created_by)
  values (nm, pid, d, m, uid)
  returning * into proj;

  insert into public.project_status_history (project_id, previous_status, new_status, updated_by)
  values (proj.id, null, proj.current_status, uid);

  return proj;
end $$;

create or replace function public.advance_project(p_id bigint, p_new_status text)
returns public.projects
language plpgsql security definer set search_path = public as $$
declare
  uid      uuid := auth.uid();
  statuses text[] := array['CHECKING AT R&D', 'SENT BACK TO DESIGNER', 'CHECKING AT FACTORY',
                           'SENT BACK TO R&D', 'FINAL SOD PENDING', 'UNDER PRODUCTION', 'DISPATCHED'];
  cur      public.projects;
  i        int;
begin
  if public.my_role() is null or public.my_role() not in ('super_admin', 'admin') then
    raise exception 'You don''t have permission to do that.';
  end if;

  select * into cur from public.projects where id = p_id for update;  -- row lock: no double-advance
  if not found then
    raise exception 'Project not found.';
  end if;

  i := array_position(statuses, cur.current_status);
  if i = array_length(statuses, 1) then
    raise exception 'This project is already DISPATCHED. No further changes are possible.';
  end if;
  if p_new_status is distinct from statuses[i + 1] then
    raise exception 'The project''s status has changed or that stage can''t be skipped to. Refresh and try again.';
  end if;

  update public.projects set current_status = p_new_status, updated_at = now()
  where id = p_id returning * into cur;

  insert into public.project_status_history (project_id, previous_status, new_status, updated_by)
  values (p_id, statuses[i], p_new_status, uid);

  return cur;
end $$;

revoke execute on function public.create_project(text, text, text, text) from public, anon;
revoke execute on function public.advance_project(bigint, text) from public, anon;
grant execute on function public.create_project(text, text, text, text) to authenticated;
grant execute on function public.advance_project(bigint, text) to authenticated;

-- ---------------------------------------------------------------- realtime
-- Lets signed-in browsers receive live changes (still filtered by the read policies above).

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.projects;
    exception when duplicate_object then null; end;
    begin
      alter publication supabase_realtime add table public.project_status_history;
    exception when duplicate_object then null; end;
  end if;
end $$;
