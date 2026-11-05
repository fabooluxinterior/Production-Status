-- Run AFTER you have created the first user in Supabase:
-- Authentication -> Users -> Add user -> Create new user
--   Email: designer8fab@gmail.com   Password: (your choice)   Tick "Auto Confirm User"
-- Then run this in the SQL Editor to make that user the Super Admin.

insert into public.profiles (id, email, role)
select id, lower(email), 'super_admin'
from auth.users
where lower(email) = 'designer8fab@gmail.com'
on conflict (id) do nothing;

select email, role, is_active from public.profiles;  -- should show one row: super_admin
