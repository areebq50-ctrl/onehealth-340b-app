import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import Logo from '../components/common/Logo.jsx';

export default function Login() {
  const { session, signIn, loading: authLoading } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  if (!authLoading && session) {
    return <Navigate to="/" replace />;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email, password);
    } catch (err) {
      setError(err.message ?? 'Unable to sign in. Check your credentials and try again.');
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
            <p className="text-sm font-medium text-gray-500">340B Operations Platform</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="label-text" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                className="input-field"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@onehealthpartners.com"
              />
            </div>

            <div>
              <label className="label-text" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                className="input-field"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>

            {error && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-danger">{error}</div>
            )}

            <button type="submit" disabled={submitting} className="btn-primary w-full">
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Sign in
            </button>
          </form>
        </div>
        <p className="mt-4 text-center text-xs text-gray-400">
          Access is provisioned by your One.Health Partners administrator.
        </p>
      </div>
    </div>
  );
}
