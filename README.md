# Faboolux – Production Status

Project management for interior design and production, with a fixed 7-stage workflow.
Runs entirely online: the site is served by **GitHub Pages**, data and sign-in live in **Supabase**.
No computer of yours needs to be switched on.

**Workflow (enforced on the server, no going back):**
CHECKING AT R&D → SENT BACK TO DESIGNER → CHECKING AT FACTORY → (**Send Back to R&D** → back to Factory, or **Final SOD Pending**) → FINAL SOD PENDING → UNDER PRODUCTION → DISPATCHED

After Factory checking there are two choices: Send Back to R&D (alerts the Super Admin) or Final SOD Pending.
Once R&D has made its changes, the project is sent to the Factory again (the Admin is alerted again) and the same two choices follow. Final SOD, Under Production and Dispatched stay one step each.
Dispatched projects move automatically to **Completed Projects** (nothing is deleted or copied).

**Roles:** Super Admin · R&D Department · Admin · Designer · DM

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
- Only Super Admin and Admin can change a project's status, one step at a time.
- **Designer sign-in link:** give Designers the address `<your site>/#/designer`. That page dims the screen, highlights the email box and shows "Login using your FabSketch email" every time it opens, until the first click or key press. The normal sign-in page (`<your site>/`) shows no announcement. Nothing is stored in the browser.
- Designers and DMs only see projects assigned to them.

## R&D Department role

Has everything the Super Admin has on projects: sees all projects, creates projects, changes status, gets the R&D alerts (same as the Super Admin, acknowledged separately).
It cannot open the Users page or add, edit, deactivate or reset users. Only the Super Admin creates this account (Users → Add user → role R&D Department).

## Attention notifications

- Super Admin is alerted when a project is received by R&D or sent back to R&D.
- Admin is alerted when a project is received by Factory (and when it goes into production).
- The assigned Designer and the assigned DM are alerted when their project is Sent Back to Designer or reaches Final SOD Pending.
- Alerts blink on the project card and in the bell menu until you acknowledge them or the project moves on.
  Each person acknowledges for themselves. History (with PJ numbers and times) stays in the bell menu.

## Security notes

Browsers can only read data through row-level security; every change goes through server-side
functions that check role, workflow order and assignments. Sessions can be revoked immediately.
