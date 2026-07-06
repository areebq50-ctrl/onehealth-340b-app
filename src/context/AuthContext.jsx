import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadProfile = useCallback(async (userId) => {
    if (!userId) {
      setProfile(null);
      return null;
    }
    const { data, error } = await supabase.from('users').select('*').eq('id', userId).single();
    if (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to load user profile:', error.message);
      setProfile(null);
      return null;
    }
    setProfile(data);
    return data;
  }, []);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(async ({ data: { session: initialSession } }) => {
      if (!mounted) return;
      setSession(initialSession);
      await loadProfile(initialSession?.user?.id);
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange(async (_event, newSession) => {
      setSession(newSession);
      await loadProfile(newSession?.user?.id);
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const signIn = useCallback(
    async (email, password) => {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;

      // Always re-fetch the profile fresh from the database on every login
      // attempt — never trust a cached/previous profile — so a status change
      // made by an admin (e.g. deactivation) takes effect immediately without
      // requiring a redeploy or waiting for a token refresh.
      const freshProfile = await loadProfile(data.user.id);

      if (!freshProfile?.active) {
        await supabase.auth.signOut();
        throw new Error('Your account has been deactivated. Contact a One.Health Partners administrator for access.');
      }
    },
    [loadProfile]
  );

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const value = {
    session,
    user: session?.user ?? null,
    profile,
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
