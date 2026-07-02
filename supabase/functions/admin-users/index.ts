// Supabase Edge Function: admin-users
//
// Handles admin-only user management actions that require the Supabase
// service role (inviting a new auth user by email). The service role key
// never reaches the browser — it lives only in this function's environment.
//
// POST body: { action: 'invite', email: string, role: 'admin' | 'regular' }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

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

    const { action, email, role } = await req.json();

    if (action === 'invite') {
      if (!email || typeof email !== 'string') return json({ error: 'Missing email' }, 400);
      const desiredRole = role === 'admin' ? 'admin' : 'regular';

      const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email);
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
