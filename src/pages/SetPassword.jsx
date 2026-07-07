import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { supabase } from '../lib/supabaseClient.js';
import Logo from '../components/common/Logo.jsx';

const MIN_LENGTH = 8;

export default function SetPassword() {
  const { session, needsPasswordSetup, clearNeedsPasswordSetup, loading: authLoading } = useAuth();
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-alt">
        <Loader2 className="h-8 w-8 animate-spin text-teal" />
      </div>
    );
  }

  // Nothing to do here without a session from the invite/recovery link
  // (someone navigating here directly), and nothing to do here once a
  // password has already been set — both send back to the normal flow.
  if (!session) return <Navigate to="/login" replace />;
  if (!needsPasswordSetup) return <Navigate to="/" replace />;

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_LENGTH) {
      setError(`Password must be at least ${MIN_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      const { error: updateErr } = await supabase.auth.updateUser({ password });
      if (updateErr) throw updateErr;
      clearNeedsPasswordSetup();
      toast.success('Password set — welcome to the One.Health Partners platform.');
    } catch (err) {
      setError(err.message ?? 'Failed to set password. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-alt px-4">
      <div className="w-full max-w-md">
        <div className="card p-8">
          <div className="mb-6 flex flex-col items-center gap-3">
            <Logo className="h-10 w-auto" />
            <p className="text-sm font-medium text-gray-500">Set your password to finish setting up your account</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="label-text" htmlFor="new-password">
                New password
              </label>
              <input
                id="new-password"
                type="password"
                required
                autoComplete="new-password"
                className="input-field"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                minLength={MIN_LENGTH}
              />
              <p className="mt-1 text-xs text-gray-400">At least {MIN_LENGTH} characters.</p>
            </div>

            <div>
              <label className="label-text" htmlFor="confirm-password">
                Confirm password
              </label>
              <input
                id="confirm-password"
                type="password"
                required
                autoComplete="new-password"
                className="input-field"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="••••••••"
                minLength={MIN_LENGTH}
              />
            </div>

            {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-danger">{error}</div>}

            <button type="submit" disabled={submitting} className="btn-primary w-full">
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Set Password &amp; Continue
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
