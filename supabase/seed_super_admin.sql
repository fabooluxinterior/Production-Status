-- Run AFTER schema.sql, once you have created the first user in Supabase:
-- Authentication -> Users -> Add user -> Create new user
--   Email: designer8fab@gmail.com   Password: (your choice)   Tick "Auto Confirm User"
-- Then run this to make that user the Super Admin. Safe to run again.

insert into public.profiles (id, email, name, role)
select id, lower(email), 'Super Admin', 'super_admin'
from auth.users
where lower(email) = 'designer8fab@gmail.com'
on conflict (id) do update
  set role = 'super_admin',
      is_active = true,
      must_change_password = false,
      name = case when public.profiles.name = '' then 'Super Admin' else public.profiles.name end;

select email, name, role, is_active from public.profiles;  -- should list your Super Admin
