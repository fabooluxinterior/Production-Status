# Faboolux – Production Status

Project management for interior design and production, with a fixed 7-stage workflow.
Runs entirely online: the site is served by **GitHub Pages**, data and sign-in live in **Supabase**.
No computer of yours needs to be switched on.

**Workflow (enforced on the server, no skipping, no going back):**
CHECKING AT R&D → SENT BACK TO DESIGNER → CHECKING AT FACTORY → SENT BACK TO R&D → FINAL SOD PENDING → UNDER PRODUCTION → DISPATCHED

**Roles:** Super Admin · Admin · Designer · DM

## Setup (in this order)

1. **Database** – Supabase → SQL Editor → paste all of `supabase/schema.sql` → Run.
   Safe to run again. If you ran the earlier (v1) version, its projects are kept in
   `projects_v1_backup` and `project_status_history_v1_backup`; they do not appear in the new app.
2. **Super Admin** – In Supabase → Authentication → Users, make sure `designer8fab@gmail.com` exists
   (Add user → set password, tick auto-confirm). Then run `supabase/seed_super_admin.sql` in the SQL Editor.
   The password is never stored in this repository.
3. **User management function** – Supabase → Edge Functions → function named `admin-users`
   → paste `supabase/functions/admin-users/index.ts` (the file must be called `index.ts`) → Deploy.
4. **Site settings** – `config.js` holds the project URL and the public (publishable) key only.
5. **Publish** – GitHub → Settings → Pages → Source: `main`, folder `/ (root)`.

## Using it

- Only the Super Admin manages users (Users page): add, edit, activate/deactivate, reset password
  (temporary password is shown once and must be changed at next sign-in), revoke sessions.
- Create Designer and DM accounts first; Super Admin, Admin and DM can then create projects
  and pick the Designer and DM from the dropdowns. Project IDs are typed by hand (`PJ-` + digits).
- Only Super Admin and Admin can advance a project's status, one step at a time.
- Designers and DMs only see projects assigned to them.

## Security notes

Browsers can only read data through row-level security; every change goes through server-side
functions that check role, workflow order and assignments. Sessions can be revoked immediately.
