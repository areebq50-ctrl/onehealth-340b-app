// Supabase Edge Function: claude-assistant
//
// Proxies chat messages from the AI Assistant page to the Anthropic API.
// The Anthropic API key lives ONLY in this function's environment (set via
// `supabase secrets set ANTHROPIC_API_KEY=...`) and is never sent to or
// readable from the browser.
//
// Flow: verify the caller's Supabase JWT -> look up their profile with the
// service-role client -> run a small set of heuristic Supabase queries based
// on keywords in the user's question -> assemble a structured JSON context
// payload -> send { system prompt, context, message, history } to Claude ->
// return the text response to the frontend.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;
const CLAUDE_MODEL = Deno.env.get('CLAUDE_MODEL') ?? 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `You are the AI assistant for the One.Health Partners 340B Operations Platform — an official internal tool used by the One.Health Partners operations team to manage 340B pharmacy claims processing, drug inventory, and reimbursement calculations. You are professional, precise, and concise. You only answer questions related to 340B operations, claims data, drug inventory, reimbursement, and pharmacy management. You will be provided with structured data from the One.Health Partners database as context for each question. You must only use the data provided in that context to answer — never estimate, guess, or hallucinate financial figures, quantities, or drug information. If the data needed to answer a question is not present in the provided context, say so clearly and suggest what the user should look for in the app. Always present numbers clearly and label units (qty, packs, dollars). When presenting financial totals, always display them as dollar amounts rounded to 2 decimal places.`;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function detectMonthYear(question: string, fallback: { month: number; year: number }) {
  const lower = question.toLowerCase();
  const monthIdx = MONTH_NAMES.findIndex((m) => lower.includes(m));
  const yearMatch = lower.match(/\b(20[2-3]\d)\b/);
  return {
    month: monthIdx >= 0 ? monthIdx + 1 : fallback.month,
    year: yearMatch ? parseInt(yearMatch[1], 10) : fallback.year,
  };
}

function detectExplicitDate(question: string, year: number) {
  const lower = question.toLowerCase();
  const monthIdx = MONTH_NAMES.findIndex((m) => lower.includes(m));
  if (monthIdx < 0) return null;
  const dayMatch = lower.match(/\b(\d{1,2})(st|nd|rd|th)?\b/);
  if (!dayMatch) return null;
  const day = parseInt(dayMatch[1], 10);
  if (day < 1 || day > 31) return null;
  const mm = String(monthIdx + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const jwt = authHeader.replace('Bearer ', '');
    const { data: userData, error: userErr } = await supabase.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: 'Invalid or expired session' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: profile } = await supabase
      .from('users')
      .select('role, active, email')
      .eq('id', userData.user.id)
      .single();

    if (!profile?.active) {
      return new Response(JSON.stringify({ error: 'User account is inactive' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { message, history, scope } = await req.json();
    if (!message || typeof message !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing message' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const now = new Date();
    const { month, year } = detectMonthYear(message, { month: now.getUTCMonth() + 1, year: now.getUTCFullYear() });
    const explicitDate = detectExplicitDate(message, year);

    const [{ data: facilities }, { data: pharmacies }] = await Promise.all([
      supabase.from('facilities').select('id, name, short_code'),
      supabase.from('pharmacies').select('id, name'),
    ]);

    // A pharmacy named directly in the question always wins (explicit user
    // intent); otherwise fall back to whatever the app's Facility/Pharmacy
    // selector currently has active, so the assistant answers about the
    // same scope the user is looking at on screen.
    const textMentionedPharmacy = (pharmacies ?? []).find((p: any) => message.toLowerCase().includes(p.name.toLowerCase()));
    const mentionedPharmacy = textMentionedPharmacy ?? (scope?.pharmacyId ? { id: scope.pharmacyId, name: scope.pharmacyName } : null);
    const scopedFacilityId: string | null = scope?.facilityId ?? null;

    let claimsQuery = supabase
      .from('claims')
      .select('id, claim_date, pharmacy_id, facility_id, total_reimbursement, status, pharmacies(name)')
      .gte('claim_date', `${year}-${String(month).padStart(2, '0')}-01`)
      .lt('claim_date', month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`)
      .order('claim_date', { ascending: true })
      .limit(200);
    if (mentionedPharmacy) claimsQuery = claimsQuery.eq('pharmacy_id', mentionedPharmacy.id);
    if (scopedFacilityId) claimsQuery = claimsQuery.eq('facility_id', scopedFacilityId);
    if (explicitDate) claimsQuery = claimsQuery.eq('claim_date', explicitDate);
    const { data: claims } = await claimsQuery;

    const claimIds = (claims ?? []).map((c: any) => c.id);

    let lineItems: any[] = [];
    if (claimIds.length > 0) {
      const { data } = await supabase
        .from('claim_line_items')
        .select('claim_id, ndc, product_name, qty_dispensed, packs_dispensed, ppu_340b, reimbursement_owed, matched, qty_before, qty_after')
        .in('claim_id', claimIds)
        .limit(2000);
      lineItems = data ?? [];
    }

    const drugNameMatch = message.match(/(?:for|of)\s+([A-Za-z][A-Za-z0-9\- ]{2,30})\??$/i);
    let drugAccumulator: any[] = [];
    if (drugNameMatch) {
      let drugQuery = supabase
        .from('accumulator')
        .select('ndc, product_name, qty_on_hand, pack_size, ppu_340b, month, year, facility_id, pharmacy_id, exp_day, pharmacies(name)')
        .ilike('product_name', `%${drugNameMatch[1].trim()}%`)
        .order('year', { ascending: false })
        .order('month', { ascending: false })
        .limit(20);
      if (mentionedPharmacy) drugQuery = drugQuery.eq('pharmacy_id', mentionedPharmacy.id);
      if (scopedFacilityId) drugQuery = drugQuery.eq('facility_id', scopedFacilityId);
      const { data } = await drugQuery;
      drugAccumulator = (data ?? []).map((r: any) => ({ ...r, pharmacyName: r.pharmacies?.name ?? null }));
    }

    const wantsUnmatched = /unmatched/i.test(message);
    let unmatched: any[] = [];
    if (wantsUnmatched) {
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400 * 1000).toISOString().slice(0, 10);
      let recentClaimsQuery = supabase.from('claims').select('id, claim_date, pharmacy_id').gte('claim_date', thirtyDaysAgo).limit(500);
      if (mentionedPharmacy) recentClaimsQuery = recentClaimsQuery.eq('pharmacy_id', mentionedPharmacy.id);
      if (scopedFacilityId) recentClaimsQuery = recentClaimsQuery.eq('facility_id', scopedFacilityId);
      const { data: recentClaims } = await recentClaimsQuery;
      const recentIds = (recentClaims ?? []).map((c: any) => c.id);
      if (recentIds.length > 0) {
        const { data } = await supabase
          .from('claim_line_items')
          .select('ndc, product_name, qty_dispensed, claim_id')
          .in('claim_id', recentIds)
          .eq('matched', false)
          .limit(300);
        unmatched = data ?? [];
      }
    }

    const wantsExpiring = /expir/i.test(message);
    let expiring: any[] = [];
    if (wantsExpiring) {
      const sixtyDaysOut = new Date(now.getTime() + 60 * 86400 * 1000).toISOString().slice(0, 10);
      let expiringQuery = supabase
        .from('accumulator')
        .select('ndc, product_name, exp_day, qty_on_hand, facility_id, pharmacy_id, month, year, pharmacies(name)')
        .lte('exp_day', sixtyDaysOut)
        .order('exp_day', { ascending: true })
        .limit(100);
      if (mentionedPharmacy) expiringQuery = expiringQuery.eq('pharmacy_id', mentionedPharmacy.id);
      if (scopedFacilityId) expiringQuery = expiringQuery.eq('facility_id', scopedFacilityId);
      const { data } = await expiringQuery;
      expiring = (data ?? []).map((r: any) => ({ ...r, pharmacyName: r.pharmacies?.name ?? null }));
    }

    // Aggregate dispensing volume by NDC for the detected month (top 15).
    const volumeByNdc = new Map<string, { product_name: string; total_qty: number }>();
    for (const li of lineItems) {
      if (!li.matched) continue;
      const key = li.ndc;
      const prev = volumeByNdc.get(key) ?? { product_name: li.product_name, total_qty: 0 };
      prev.total_qty += Number(li.qty_dispensed ?? 0);
      volumeByNdc.set(key, prev);
    }
    const topVolume = Array.from(volumeByNdc.entries())
      .map(([ndc, v]) => ({ ndc, ...v }))
      .sort((a, b) => b.total_qty - a.total_qty)
      .slice(0, 15);

    const totalReimbursement = (claims ?? []).reduce((sum: number, c: any) => sum + Number(c.total_reimbursement ?? 0), 0);

    const contextPayload = {
      queryDetected: {
        month,
        year,
        explicitDate,
        mentionedPharmacy: mentionedPharmacy?.name ?? null,
        scopeNote: mentionedPharmacy
          ? `All figures below are already filtered to pharmacy "${mentionedPharmacy.name}" only.`
          : 'No specific pharmacy was named in the question — figures below may include multiple pharmacies. If the user asks about a specific pharmacy by name, only use data where pharmacy_id/pharmacyName matches it.',
      },
      facilities,
      pharmacies,
      periodSummary: {
        month,
        year,
        totalClaims: (claims ?? []).length,
        totalReimbursement: Number(totalReimbursement.toFixed(2)),
      },
      claims: (claims ?? []).map((c: any) => ({ ...c, pharmacyName: c.pharmacies?.name ?? null })),
      claimLineItemsSample: lineItems.slice(0, 500),
      topDispensingVolume: topVolume,
      drugAccumulatorMatches: drugAccumulator,
      unmatchedNdcsLast30Days: unmatched,
      drugsExpiringWithin60Days: expiring,
      note: 'All arrays are capped for payload size; if a total looks incomplete, tell the user to check the Dashboard/Reports page for the full dataset. Every accumulator and claim row belongs to exactly one pharmacy — never sum figures across different pharmacyName values unless the user asked for an all-pharmacy total.',
    };

    const anthropicMessages = [
      ...(Array.isArray(history) ? history.slice(-10) : []),
      {
        role: 'user',
        content: `Database context (JSON):\n${JSON.stringify(contextPayload)}\n\nQuestion: ${message}`,
      },
    ];

    const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1536,
        system: SYSTEM_PROMPT,
        messages: anthropicMessages,
      }),
    });

    if (!anthropicResp.ok) {
      const errText = await anthropicResp.text();
      return new Response(JSON.stringify({ error: `Claude API error: ${errText}` }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const anthropicJson = await anthropicResp.json();
    const replyText = anthropicJson?.content?.[0]?.text ?? 'No response generated.';

    return new Response(JSON.stringify({ reply: replyText }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: `Unexpected error: ${(err as Error).message}` }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
