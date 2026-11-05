// Supabase Edge Function: admin-users
// Creates users, activates/deactivates them and resets passwords.
// It needs the service-role key (injected automatically by Supabase, never put in the website).
//
// Actions (POST JSON): { action: "create", email, role, password? }
//                      { action: "set_active", user_id, is_active }
//                      { action: "reset_password", user_id }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function generatePassword(length = 14): string {
  const lower = "abcdefghjkmnpqrstuvwxyz", upper = "ABCDEFGHJKLMNPQRSTUVWXYZ", digits = "23456789", symbols = "@#$%&*";
  const pool = lower + upper + digits + symbols;
  while (true) {
    const bytes = crypto.getRandomValues(new Uint32Array(length));
    const pw = Array.from(bytes, (b) => pool[b % pool.length]).join("");
    if ([lower, upper, digits, symbols].every((set) => [...pw].some((c) => set.includes(c)))) return pw;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Not allowed." }, 405);

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    });

    // Who is calling? Verify their token, then load their profile.
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: who, error: whoErr } = await admin.auth.getUser(token);
    if (whoErr || !who.user) return json({ error: "Please sign in." }, 401);
    const { data: me } = await admin.from("profiles").select("id, role, is_active").eq("id", who.user.id).maybeSingle();
    if (!me || !me.is_active || !["super_admin", "admin"].includes(me.role)) {
      return json({ error: "You don't have permission to do that." }, 403);
    }
    // Super Admin manages Admins, Designers and DMs; an Admin manages Designers and DMs only.
    const manageable = me.role === "super_admin" ? ["admin", "designer", "dm"] : ["designer", "dm"];

    const body = await req.json();

    if (body.action === "create") {
      const email = String(body.email ?? "").trim().toLowerCase();
      if (email.length > 254 || !EMAIL_RE.test(email)) return json({ error: "Enter a valid email address." }, 422);
      if (!manageable.includes(body.role)) return json({ error: "You can't create that kind of account." }, 403);
      const supplied = body.password ? String(body.password) : "";
      if (supplied && (supplied.length < 8 || supplied.length > 72)) {
        return json({ error: "Password must be 8 to 72 characters." }, 422);
      }
      const password = supplied || generatePassword();

      const { data: existing } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
      if (existing) return json({ error: "An account with this email already exists." }, 409);

      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
      });
      if (createErr || !created.user) {
        return json({ error: createErr?.message ?? "Could not create the account." }, 409);
      }
      const { data: profile, error: profErr } = await admin
        .from("profiles")
        .insert({ id: created.user.id, email, role: body.role })
        .select("id, email, role, is_active, created_at")
        .single();
      if (profErr) {
        await admin.auth.admin.deleteUser(created.user.id); // don't leave a login without a profile
        return json({ error: "Could not create the account." }, 500);
      }
      return json({ user: profile, ...(supplied ? {} : { temp_password: password }) }, 201);
    }

    if (body.action === "set_active" || body.action === "reset_password") {
      const { data: target } = await admin.from("profiles").select("id, role").eq("id", String(body.user_id ?? "")).maybeSingle();
      if (!target || !manageable.includes(target.role) || target.id === me.id) {
        return json({ error: "User not found." }, 404);
      }

      if (body.action === "set_active") {
        if (typeof body.is_active !== "boolean") return json({ error: "Invalid request." }, 422);
        const { data: profile, error } = await admin
          .from("profiles").update({ is_active: body.is_active }).eq("id", target.id)
          .select("id, email, role, is_active, created_at").single();
        if (error) return json({ error: "Could not update the user." }, 500);
        // Also block new sign-ins / token refreshes at the auth layer.
        await admin.auth.admin.updateUserById(target.id, { ban_duration: body.is_active ? "none" : "876000h" });
        return json({ user: profile });
      }

      const password = generatePassword();
      const { error } = await admin.auth.admin.updateUserById(target.id, { password });
      if (error) return json({ error: "Could not reset the password." }, 500);
      return json({ temp_password: password });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (_err) {
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
