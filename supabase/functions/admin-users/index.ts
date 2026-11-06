// Supabase Edge Function: admin-users  (version 2)
// User management. It needs the service-role key (injected automatically by Supabase, never in the website).
//
// Super Admin only:
//   { action: "create", name, email, role, password? }            role = admin | designer | dm
//   { action: "update", user_id, name?, email?, role? }
//   { action: "set_active", user_id, is_active }
//   { action: "reset_password", user_id, password? }              blank = generate; user must change it at next login
//   { action: "revoke_sessions", user_id }
// Any signed-in user:
//   { action: "change_password", current_password, new_password }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ROLES = ["admin", "designer", "dm"];
const PROFILE_COLS = "id, name, email, role, is_active, must_change_password, created_at";

function generatePassword(length = 14): string {
  const lower = "abcdefghjkmnpqrstuvwxyz", upper = "ABCDEFGHJKLMNPQRSTUVWXYZ", digits = "23456789", symbols = "@#$%&*";
  const pool = lower + upper + digits + symbols;
  while (true) {
    const bytes = crypto.getRandomValues(new Uint32Array(length));
    const pw = Array.from(bytes, (b) => pool[b % pool.length]).join("");
    if ([lower, upper, digits, symbols].every((set) => [...pw].some((c) => set.includes(c)))) return pw;
  }
}

const cleanName = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();

function sessionIdOf(token: string): string | null {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, "="))).session_id ?? null;
  } catch {
    return null;
  }
}

function checkPassword(value: unknown): string | null {
  const pw = String(value ?? "");
  return pw.length >= 8 && pw.length <= 72 ? pw : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Not allowed." }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // ---- who is calling? (valid token, live session, active profile)
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: who, error: whoErr } = await admin.auth.getUser(token);
    if (whoErr || !who.user) return json({ error: "Please sign in." }, 401);
    const sessionId = sessionIdOf(token);
    if (sessionId) {
      const { data: alive } = await admin.rpc("session_alive", { p_session: sessionId });
      if (alive === false) return json({ error: "Your session has ended. Please sign in again." }, 401);
    }
    const { data: me } = await admin
      .from("profiles").select("id, email, name, role, is_active").eq("id", who.user.id).maybeSingle();
    if (!me || !me.is_active) return json({ error: "This account is not active." }, 403);

    const body = await req.json();
    const action = String(body.action ?? "");

    const audit = (act: string, targetId: string, details: Record<string, unknown> = {}) =>
      admin.from("audit_log").insert({
        actor_id: me.id, actor_email: me.email, action: act, target_type: "user", target_id: targetId, details,
      });

    // ---- anyone: change my own password (current password verified here, on the server)
    if (action === "change_password") {
      const current = String(body.current_password ?? "");
      const next = checkPassword(body.new_password);
      if (!next) return json({ error: "Password must be 8 to 72 characters." }, 422);
      if (next === current) return json({ error: "Choose a password different from the current one." }, 422);

      const probe = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error: badPw } = await probe.auth.signInWithPassword({ email: me.email, password: current });
      if (badPw) return json({ error: "Current password is incorrect." }, 403);
      await probe.auth.signOut();

      const { error: upErr } = await admin.auth.admin.updateUserById(me.id, { password: next });
      if (upErr) return json({ error: "Could not change the password." }, 500);
      await admin.from("profiles").update({ must_change_password: false }).eq("id", me.id);
      await admin.rpc("revoke_user_sessions", { p_user: me.id, p_keep: sessionId }); // sign out other devices
      await audit("user.change_password", me.id);
      return json({ ok: true });
    }

    // ---- everything below: Super Admin only
    if (me.role !== "super_admin") return json({ error: "You don't have permission to do that." }, 403);

    if (action === "create") {
      const name = cleanName(body.name);
      if (!name || name.length > 100) return json({ error: "Enter the user's name (up to 100 characters)." }, 422);
      const email = String(body.email ?? "").trim().toLowerCase();
      if (email.length > 254 || !EMAIL_RE.test(email)) return json({ error: "Enter a valid email address." }, 422);
      if (!ROLES.includes(body.role)) return json({ error: "Choose Admin, Designer or DM." }, 403);
      const supplied = body.password ? checkPassword(body.password) : "";
      if (supplied === null) return json({ error: "Password must be 8 to 72 characters." }, 422);
      const password = supplied || generatePassword();

      const { data: existing } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
      if (existing) return json({ error: "An account with this email already exists." }, 409);

      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
      });
      if (createErr || !created.user) return json({ error: createErr?.message ?? "Could not create the account." }, 409);

      const { data: profile, error: profErr } = await admin
        .from("profiles")
        .insert({ id: created.user.id, name, email, role: body.role, must_change_password: true })
        .select(PROFILE_COLS).single();
      if (profErr) {
        await admin.auth.admin.deleteUser(created.user.id); // never leave a login without a profile
        return json({ error: "Could not create the account." }, 500);
      }
      await audit("user.create", profile.id, { email, role: body.role });
      return json({ user: profile, ...(supplied ? {} : { temp_password: password }) }, 201);
    }

    // ---- actions on an existing user
    const { data: target } = await admin
      .from("profiles").select("id, name, email, role, is_active").eq("id", String(body.user_id ?? "")).maybeSingle();
    if (!target) return json({ error: "User not found." }, 404);
    const isSelf = target.id === me.id;

    if (action === "update") {
      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) {
        const name = cleanName(body.name);
        if (!name || name.length > 100) return json({ error: "Enter the user's name (up to 100 characters)." }, 422);
        if (name !== target.name) patch.name = name;
      }
      if (body.email !== undefined) {
        const email = String(body.email).trim().toLowerCase();
        if (email.length > 254 || !EMAIL_RE.test(email)) return json({ error: "Enter a valid email address." }, 422);
        if (email !== target.email) {
          if (isSelf) return json({ error: "You can't change your own sign-in email here." }, 403);
          const { data: taken } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
          if (taken) return json({ error: "An account with this email already exists." }, 409);
          patch.email = email;
        }
      }
      if (body.role !== undefined && body.role !== target.role) {
        if (isSelf || target.role === "super_admin") return json({ error: "The Super Admin role can't be changed." }, 403);
        if (!ROLES.includes(body.role)) return json({ error: "Choose Admin, Designer or DM." }, 403);
        patch.role = body.role;
      }
      if (Object.keys(patch).length === 0) {
        const { data: same } = await admin.from("profiles").select(PROFILE_COLS).eq("id", target.id).single();
        return json({ user: same });
      }

      if (patch.email) {
        const { error: authErr } = await admin.auth.admin.updateUserById(target.id, {
          email: patch.email as string, email_confirm: true,
        });
        if (authErr) return json({ error: authErr.message || "Could not change the email." }, 409);
      }
      const { data: profile, error: profErr } = await admin
        .from("profiles").update(patch).eq("id", target.id).select(PROFILE_COLS).single();
      if (profErr) {
        if (patch.email) await admin.auth.admin.updateUserById(target.id, { email: target.email, email_confirm: true });
        // Messages raised by our own rules (e.g. "assigned to projects") are safe to show.
        return json({ error: profErr.code === "P0001" ? profErr.message : "Could not update the user." }, 409);
      }
      if (patch.email) await admin.rpc("revoke_user_sessions", { p_user: target.id, p_keep: null });
      await audit("user.update", target.id, { changed: Object.keys(patch), from_email: target.email });
      return json({ user: profile });
    }

    // The remaining actions never apply to your own account or to the Super Admin.
    if (isSelf || target.role === "super_admin") return json({ error: "User not found." }, 404);

    if (action === "set_active") {
      if (typeof body.is_active !== "boolean") return json({ error: "Invalid request." }, 422);
      const { data: profile, error } = await admin
        .from("profiles").update({ is_active: body.is_active }).eq("id", target.id).select(PROFILE_COLS).single();
      if (error) return json({ error: "Could not update the user." }, 500);
      await admin.auth.admin.updateUserById(target.id, { ban_duration: body.is_active ? "none" : "876000h" });
      if (!body.is_active) await admin.rpc("revoke_user_sessions", { p_user: target.id, p_keep: null });
      await audit(body.is_active ? "user.activate" : "user.deactivate", target.id);
      return json({ user: profile });
    }

    if (action === "reset_password") {
      const supplied = body.password ? checkPassword(body.password) : "";
      if (supplied === null) return json({ error: "Password must be 8 to 72 characters." }, 422);
      const password = supplied || generatePassword();
      const { error } = await admin.auth.admin.updateUserById(target.id, { password });
      if (error) return json({ error: "Could not reset the password." }, 500);
      await admin.from("profiles").update({ must_change_password: true }).eq("id", target.id);
      await admin.rpc("revoke_user_sessions", { p_user: target.id, p_keep: null });
      await audit("user.reset_password", target.id);
      return json({ ok: true, ...(supplied ? {} : { temp_password: password }) });
    }

    if (action === "revoke_sessions") {
      await admin.rpc("revoke_user_sessions", { p_user: target.id, p_keep: null });
      await audit("user.revoke_sessions", target.id);
      return json({ ok: true });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (_err) {
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
