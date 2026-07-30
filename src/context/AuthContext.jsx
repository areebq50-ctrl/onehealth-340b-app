import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';
import { isPasswordSetupRedirect } from '../lib/inviteFlow.js';

const AuthContext = createContext(null);

// Auth events that represent an actual identity change (a new user session
// starting or ending). We only want to show the full-screen loading state
// for these — not for silent background events like TOKEN_REFRESHED, which
// fire periodically for an already-logged-in user and must never flash the
// whole app back to a spinner.
const IDENTITY_EVENTS = new Set(['SIGNED_IN', 'SIGNED_OUT']);

// Normalizes a PostgREST/Supabase error (message/code/details/hint) OR a
// thrown JS exception (message/stack) into one shape so the UI can render
// every field verbatim instead of just `.message`.
function describeError(source, label) {
  const structured = {
    label,
    message: source?.message || String(source) || 'Unknown error',
    code: source?.code ?? null,
    details: source?.details ?? null,
    hint: source?.hint ?? null,
    status: source?.status ?? null,
    stack: source?.stack ?? new Error().stack,
  };
  console.error(`[Auth] ${label}:`); // eslint-disable-line no-console
  console.error('  message:', structured.message); // eslint-disable-line no-console
  console.error('  code:', structured.code); // eslint-disable-line no-console
  console.error('  details:', structured.details); // eslint-disable-line no-console
  console.error('  hint:', structured.hint); // eslint-disable-line no-console
  console.error('  status:', structured.status); // eslint-disable-line no-console
  console.error('  raw error object:', source); // eslint-disable-line no-console
  console.error('  stack:', structured.stack); // eslint-disable-line no-console
  return structured;
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [profileError, setProfileError] = useState(null);
  const [loading, setLoading] = useState(true);
  // Two independent signals for "this session came from an invite/recovery
  // email link, prompt for a password before letting them into the app":
  // the raw-URL check (captured before Supabase's own hash-stripping, see
  // inviteFlow.js) and the PASSWORD_RECOVERY auth event, which Supabase
  // fires reliably for both invite and recovery links. Either one is
  // enough; cleared once the user actually sets a password.
  const [needsPasswordSetup, setNeedsPasswordSetup] = useState(isPasswordSetupRedirect);

  // Always hits the database directly — never a cached value — and reports
  // the full raw Supabase error (message/code/details/hint/status/stack)
  // back to the caller instead of collapsing every failure mode (RLS
  // denial, network error, missing row, thrown exception) into one string.
  const loadProfile = useCallback(async (userId) => {
    if (!userId) {
      console.log('[Auth] loadProfile: no user id, clearing profile'); // eslint-disable-line no-console
      setProfile(null);
      setProfileError(null);
      return { data: null, error: null };
    }
    console.log('[Auth] loadProfile: querying public.users for id=', userId); // eslint-disable-line no-console
    try {
      const res = await supabase.from('users').select('*').eq('id', userId).single();
      console.log('[Auth] loadProfile: raw response', res); // eslint-disable-line no-console
      const { data, error, status, statusText } = res;
      if (error) {
        const structured = describeError({ ...error, status: status ?? error.status }, 'loadProfile: query returned an error');
        console.error('[Auth] loadProfile: statusText=', statusText); // eslint-disable-line no-console
        setProfile(null);
        setProfileError(structured);
        return { data: null, error: structured };
      }
      console.log('[Auth] loadProfile: loaded row', data); // eslint-disable-line no-console
      setProfile(data);
      setProfileError(null);
      return { data, error: null };
    } catch (thrown) {
      const structured = describeError(thrown, 'loadProfile: threw an exception (not a query error response)');
      setProfile(null);
      setProfileError(structured);
      return { data: null, error: structured };
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    let settledInit = false;

    async function applyInitialSession(initialSession, sessionError, source) {
      if (!mounted || settledInit) return;
      settledInit = true;
      if (sessionError) console.error(`[Auth] init (${source}): getSession error:`, sessionError.message); // eslint-disable-line no-console
      console.log(`[Auth] init (${source}): initial session =`, initialSession ? `user ${initialSession.user.id}` : 'none'); // eslint-disable-line no-console
      setSession(initialSession);
      await loadProfile(initialSession?.user?.id);
      console.log(`[Auth] init (${source}): complete`); // eslint-disable-line no-console
      setLoading(false);
    }

    console.log('[Auth] init: fetching existing session'); // eslint-disable-line no-console
    supabase.auth
      .getSession()
      .then(({ data: { session: initialSession }, error: sessionError }) => applyInitialSession(initialSession, sessionError, 'getSession'))
      .catch((err) => applyInitialSession(null, err, 'getSession-threw'));

    // Defensive timeout: supabase-js's getSession() coordinates across tabs
    // via a browser lock, and on a truly cold load (e.g. opening a
    // bookmark after the browser was fully closed, or a flaky first
    // network request) it can occasionally hang indefinitely instead of
    // resolving — which previously left the app stuck on the loading
    // spinner forever, recoverable only by a manual reload. If it hasn't
    // resolved within 8s, stop waiting and let routing proceed as
    // signed-out; `settledInit` above means the real getSession() result is
    // simply ignored if it eventually does arrive late, but a session that
    // genuinely exists still flows in moments later via onAuthStateChange
    // below (which sets `session` unconditionally on every event), so nothing
    // is lost — the app just stops blocking on it.
    const timeoutId = setTimeout(() => applyInitialSession(null, null, 'timeout-fallback'), 8000);

    const { data: listener } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      if (!mounted) return;
      console.log(`[Auth] onAuthStateChange: event=${event} user=${newSession?.user?.id ?? 'none'}`); // eslint-disable-line no-console

      if (event === 'PASSWORD_RECOVERY') setNeedsPasswordSetup(true);

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
      clearTimeout(timeoutId);
      listener.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const signIn = useCallback(
    async (email, password) => {
      try {
        console.log('[Auth] signIn: step 1 — attempting password sign-in for', email); // eslint-disable-line no-console
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
          const structured = describeError(error, 'signIn: signInWithPassword failed');
          const err = new Error(error.message);
          err.detail = structured;
          throw err;
        }
        console.log('[Auth] signIn: step 2 — password auth succeeded for user', data.user.id); // eslint-disable-line no-console

        // Always re-check the users-table row fresh on every login attempt —
        // never trust a cached/previous profile — so an admin's status
        // change (e.g. deactivation, or reactivation) takes effect
        // immediately.
        console.log('[Auth] signIn: step 3 — querying public.users to verify active/role'); // eslint-disable-line no-console
        const { data: freshProfile, error: profileFetchError } = await loadProfile(data.user.id);

        if (profileFetchError) {
          console.error('[Auth] signIn: step 3 failed — users-table check errored, signing back out'); // eslint-disable-line no-console
          await supabase.auth.signOut();
          // Distinct from "inactive" — this is a real fetch/RLS/network
          // error and must be shown to the user verbatim, not silently
          // swallowed or mislabeled as a deactivated account.
          const err = new Error('Unable to verify your account.');
          err.detail = profileFetchError;
          throw err;
        }

        console.log('[Auth] signIn: step 3 succeeded — row:', freshProfile); // eslint-disable-line no-console

        if (!freshProfile?.active) {
          console.warn('[Auth] signIn: step 4 — account is inactive, signing back out'); // eslint-disable-line no-console
          await supabase.auth.signOut();
          const err = new Error('Your account has been deactivated. Contact a One.Health Partners administrator for access.');
          err.detail = { label: 'signIn: account inactive', message: err.message, code: 'INACTIVE', details: null, hint: null, status: null, stack: err.stack };
          throw err;
        }

        console.log('[Auth] signIn: step 4 — account verified active, role=', freshProfile.role); // eslint-disable-line no-console
      } catch (err) {
        if (!err.detail) {
          // Not already a structured/described error (e.g. a plain thrown
          // Error, or an exception from somewhere unexpected) — describe it
          // now so nothing reaches the UI as a bare, undiagnosable message.
          err.detail = describeError(err, 'signIn: unhandled exception');
        }
        throw err;
      }
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
    needsPasswordSetup,
    clearNeedsPasswordSetup: () => setNeedsPasswordSetup(false),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
