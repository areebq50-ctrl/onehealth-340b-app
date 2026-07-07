/**
 * Detects an invite/password-recovery redirect (Supabase appends
 * `type=invite` or `type=recovery` to the URL hash when someone clicks an
 * email link) BEFORE the Supabase client's own async session-from-URL
 * handling strips the hash. Must be imported at the very top of the entry
 * point, ahead of anything that creates the Supabase client, since this
 * module's top-level code needs to run first to reliably see the raw hash.
 */
const hash = typeof window !== 'undefined' ? window.location.hash : '';
export const isPasswordSetupRedirect = /type=invite|type=recovery/.test(hash);
