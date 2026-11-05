# Faboolux Production Status

Runs entirely online, with nothing on your own computer:

- **Website** → GitHub Pages (free), served from the top level of this repo
- **Database, logins, live updates** → Supabase (free)

When an Admin changes a project's status, every open dashboard (Designers, DMs, other Admins) updates within about a second, with no refresh.

## One-time setup (about 20 minutes)

### 1. Files
Already in this repo (`main` branch). Nothing to upload.

### 2. Create the database (Supabase)
1. Sign up at supabase.com and click **New project**. Choose a region near you (e.g. Mumbai) and set a database password.
2. Open **SQL Editor → New query**, paste all of `supabase/schema.sql`, click **Run**. It should say "Success".

### 3. Create the Super Admin
1. **Authentication → Users → Add user → Create new user**
   Email `designer8fab@gmail.com`, a password of your choice, tick **Auto Confirm User**.
2. **SQL Editor →** paste `supabase/seed_super_admin.sql` → **Run**. The result should list one row with role `super_admin`.

### 4. Stop strangers signing up
**Authentication → Sign In / Providers (or Settings) → Email** → turn **off** "Allow new users to sign up".
(Even if left on, new people could see no data. This just keeps things tidy.)

### 5. Add the user-management function
**Edge Functions → Deploy a new function → Via Editor**, name it exactly `admin-users`, paste all of `supabase/functions/admin-users/index.ts`, click **Deploy**. Leave "Verify JWT" on.
This is what lets Admins add Designers/DMs and reset passwords. It is the only place the secret service key is used, and Supabase keeps it private.

### 6. Connect the website to your database
**Project Settings → API**: copy the **Project URL** and the **anon / public** key (or "publishable" key).
In GitHub open `config.js` → pencil icon → replace the two `PASTE_...` values → *Commit changes*.
These two values are meant to be public. **Never** paste the `service_role` / secret key anywhere in the repo.

### 7. Turn on the website
Repo **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)` → Save.**
After a minute your app is at **https://fabooluxinterior.github.io/Production-Status/**

(Free GitHub Pages needs a public repo. That is fine here: the repo contains no passwords, and all data is protected by the database rules in `schema.sql`.)

### 8. Sign in
Open the link, sign in as `designer8fab@gmail.com`, then add Admins (**Manage Admins**) and Designers/DMs (**Team** for Admins).

## Day-to-day
- **Super Admin** adds Admins, Designers, DMs. **Admins** add Designers and DMs.
- Leave the password blank to generate one; it's shown once so you can share it. Anyone can change their own password under **Password**.
- Deactivating a person blocks their login and hides all data from them immediately.
- Admins create projects (start at *Checking at R&D*) and press **Edit Status** → confirm to move to the next stage. Stages can't be skipped, repeated or reversed, and nothing moves after *Dispatched*. Every change is recorded with its time.

## How it stays secure
- Browsers can only **read** data they're allowed to see (Designers/DMs: only their own projects). All writes go through database functions that re-check role and workflow order, or the `admin-users` function.
- Passwords are handled and hashed by Supabase Auth. Sessions persist across refreshes and last until the person logs out or is deactivated.
- The site has a strict content-security policy limiting where it can connect.

## Good to know
- Supabase's free plan **pauses a project after about a week with no activity**. If the app stops loading after a quiet spell, open the Supabase dashboard and click *Restore*. Upgrading removes this.
- The website loads Supabase's small client library from the jsDelivr CDN.
- Lists show up to 1,000 projects at a time (Supabase's default page size).

## Files
```
index.html, app.js, app.css, config.js, logo.webp   the website
supabase/schema.sql   tables, access rules, workflow functions, live-update setup
supabase/seed_super_admin.sql   makes your first user the Super Admin
supabase/functions/admin-users/index.ts   add users / reset passwords / deactivate
```
