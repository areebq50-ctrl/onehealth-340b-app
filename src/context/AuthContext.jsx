import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';

const AuthContext = createContext(null);

// Auth events that represent an actual identity change (a new user session
// starting or ending). We only want to show the full-screen loading state
// for these — not for silent background events like TOKEN_REFRESHED, which
// fire periodically for an already-logged-in user and must never flash the
// whole app back to a spinner.
const IDENTITY_EVENTS = new Set(['SIGNED_IN', 'SIGNED_OUT']);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [profileError, setProfileError] = useState(null);
  const [loading, setLoading] = useState(true);

  // Always hits the database directly — never a cached value — and reports
  // the raw Supabase error back to the caller instead of collapsing every
  // failure mode (RLS denial, network error, missing row) into "no profile".
  const loadProfile = useCallback(async (userId) => {
    if (!userId) {
      console.log('[Auth] loadProfile: no user id, clearing profile'); // eslint-disable-line no-console
      setProfile(null);
      setProfileError(null);
      return { data: null, error: null };
    }
    console.log('[Auth] loadProfile: querying public.users for id=', userId); // eslint-disable-line no-console
    const { data, error } = await supabase.from('users').select('*').eq('id', userId).single();
    if (error) {
      console.error('[Auth] loadProfile: query failed:', error.message, error); // eslint-disable-line no-console
      setProfile(null);
      setProfileError(error.message);
      return { data: null, error };
    }
    console.log('[Auth] loadProfile: loaded row', { id: data.id, role: data.role, active: data.active }); // eslint-disable-line no-console
    setProfile(data);
    setProfileError(null);
    return { data, error: null };
  }, []);

  useEffect(() => {
    let mounted = true;

    console.log('[Auth] init: fetching existing session'); // eslint-disable-line no-console
    supabase.auth.getSession().then(async ({ data: { session: initialSession }, error: sessionError }) => {
      if (!mounted) return;
      if (sessionError) console.error('[Auth] init: getSession error:', sessionError.message); // eslint-disable-line no-console
      console.log('[Auth] init: initial session =', initialSession ? `user ${initialSession.user.id}` : 'none'); // eslint-disable-line no-console
      setSession(initialSession);
      await loadProfile(initialSession?.user?.id);
      console.log('[Auth] init: complete'); // eslint-disable-line no-console
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      if (!mounted) return;
      console.log(`[Auth] onAuthStateChange: event=${event} user=${newSession?.user?.id ?? 'none'}`); // eslint-disable-line no-console

      // Gate the app-wide loading flag on identity changes only, so the
      // users-table check for a fresh sign-in fully resolves (profile loaded
      // and verified) before any screen reacts to `session` — this is what
      // prevents the "flash a protected screen, then bounce back to login"
      // race: a page must never see session=truthy with a stale/unverified
      // profile.
      const isIdentityChange = IDENTITY_EVENTS.has(event);
      if (isIdentityChange) setLoading(true);

      setSession(newSession);

      if (newSession?.user?.id) {
        console.log('[Auth] onAuthStateChange: verifying users-table row before exposing session'); // eslint-disable-line no-console
        await loadProfile(newSession.user.id);
      } else {
        setProfile(null);
        setProfileError(null);
      }

      if (isIdentityChange) setLoading(false);
      console.log(`[Auth] onAuthStateChange: event=${event} handling complete`); // eslint-disable-line no-console
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const signIn = useCallback(
    async (email, password) => {
      console.log('[Auth] signIn: attempting password sign-in for', email); // eslint-disable-line no-console
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        console.error('[Auth] signIn: signInWithPassword failed:', error.message); // eslint-disable-line no-console
        throw error;
      }
      console.log('[Auth] signIn: password auth succeeded for user', data.user.id); // eslint-disable-line no-console

      // Always re-check the users-table row fresh on every login attempt —
      // never trust a cached/previous profile — so an admin's status change
      // (e.g. deactivation, or reactivation) takes effect immediately.
      const { data: freshProfile, error: profileFetchError } = await loadProfile(data.user.id);

      if (profileFetchError) {
        console.error('[Auth] signIn: users-table check failed, signing back out:', profileFetchError.message); // eslint-disable-line no-console
        await supabase.auth.signOut();
        // Distinct from "inactive" — this is a real fetch/RLS/network error
        // and must be shown to the user verbatim, not silently swallowed.
        throw new Error(`Unable to verify your account (${profileFetchError.message}). Please try again.`);
      }

      if (!freshProfile?.active) {
        console.warn('[Auth] signIn: account is inactive, signing back out'); // eslint-disable-line no-console
        await supabase.auth.signOut();
        throw new Error('Your account has been deactivated. Contact a One.Health Partners administrator for access.');
      }

      console.log('[Auth] signIn: account verified active, role=', freshProfile.role); // eslint-disable-line no-console
    },
    [loadProfile]
  );

  const signOut = useCallback(async () => {
    console.log('[Auth] signOut: signing out'); // eslint-disable-line no-console
    await supabase.auth.signOut();
  }, []);

  const value = {
    session,
    user: session?.user ?? null,
    profile,
    profileError,
    isAdmin: profile?.role === 'admin',
    isActive: profile?.active === true,
    loading,
    signIn,
    signOut,
    refreshProfile: () => loadProfile(session?.user?.id),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
