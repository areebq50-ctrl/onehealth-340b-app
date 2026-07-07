// Supabase Edge Function: admin-users
//
// Handles admin-only user management actions that require the Supabase
// service role (inviting a new auth user by email, permanently deleting an
// account). The service role key never reaches the browser — it lives only
// in this function's environment.
//
// POST body: { action: 'invite', email: string, role: 'admin' | 'regular' }
//         or { action: 'delete', userId: string }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Where the invite email's link sends the new user. Supabase falls back to
// the dashboard's Authentication -> URL Configuration -> Site URL when this
// isn't passed explicitly, which is still the default localhost:3000 on a
// lot of projects — set via `supabase secrets set SITE_URL=...` to override
// without touching dashboard settings. The redirect_to it produces also
// carries `type=invite` in the hash, which the frontend uses to force a
// "set your password" screen instead of dropping the new user straight
// into the app with no password set.
const SITE_URL = Deno.env.get('SITE_URL') ?? 'https://onehealth-340b-app.vercel.app';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Missing Authorization header' }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const jwt = authHeader.replace('Bearer ', '');
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: 'Invalid or expired session' }, 401);

    const { data: callerProfile } = await admin
      .from('users')
      .select('role, active')
      .eq('id', userData.user.id)
      .single();

    if (!callerProfile?.active || callerProfile.role !== 'admin') {
      return json({ error: 'Only active admins may manage users' }, 403);
    }

    const { action, email, role, userId } = await req.json();

    if (action === 'delete') {
      if (!userId || typeof userId !== 'string') return json({ error: 'Missing userId' }, 400);
      if (userId === userData.user.id) return json({ error: "You can't delete your own account." }, 400);

      const { error: deleteErr } = await admin.auth.admin.deleteUser(userId);
      if (deleteErr) {
        // public.users cascades from auth.users, but claims/audit/order
        // tables reference users.id WITHOUT cascade on purpose — the audit
        // trail must stay attributable and immutable. A foreign-key
        // violation here means this account has real history and should be
        // deactivated instead of deleted, not silently worked around.
        const isFkViolation = /foreign key|violates|database error deleting user/i.test(deleteErr.message);
        return json(
          {
            error: isFkViolation
              ? 'This account has claims, uploads, or audit history and can\'t be deleted — deactivate it instead to preserve the audit trail.'
              : `Delete failed: ${deleteErr.message}`,
          },
          isFkViolation ? 409 : 400
        );
      }

      return json({ success: true });
    }

    if (action === 'invite') {
      if (!email || typeof email !== 'string') return json({ error: 'Missing email' }, 400);
      const desiredRole = role === 'admin' ? 'admin' : 'regular';

      const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
        redirectTo: SITE_URL,
      });
      if (inviteErr) return json({ error: `Invite failed: ${inviteErr.message}` }, 400);

      const { error: upsertErr } = await admin
        .from('users')
        .upsert({ id: invited.user.id, email, role: desiredRole, active: true }, { onConflict: 'id' });
      if (upsertErr) return json({ error: `Profile upsert failed: ${upsertErr.message}` }, 500);

      return json({ success: true, userId: invited.user.id });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (err) {
    return json({ error: `Unexpected error: ${(err as Error).message}` }, 500);
  }
});
