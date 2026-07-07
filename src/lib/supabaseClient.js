import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // Fail loudly at startup rather than silently making requests to `undefined`.
  // eslint-disable-next-line no-console
  console.error(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy .env.example to .env and fill in your Supabase project credentials.'
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});

/**
 * Invokes a Supabase Edge Function and throws an Error with the REAL reason
 * whenever possible. supabase-js's FunctionsHttpError only ever exposes a
 * generic "Edge Function returned a non-2xx status code" via `.message` —
 * the function's actual JSON error body is on `error.context` (a Response)
 * and has to be read separately, or every failure looks identical no matter
 * what actually went wrong server-side.
 */
export async function invokeEdgeFunction(name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let detail = error.message;
    if (error.context && typeof error.context.json === 'function') {
      try {
        const parsed = await error.context.json();
        if (parsed?.error) detail = parsed.error;
      } catch {
        // response body wasn't JSON — fall back to the generic message
      }
    }
    throw new Error(detail);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}
