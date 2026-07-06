import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Loader2, LogOut, AlertTriangle } from 'lucide-react';
import { useAuth } from '../../context/AuthContext.jsx';

function SignOutButton() {
  const { signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    await signOut();
    // onAuthStateChange clears `session`, so ProtectedRoute re-renders and
    // falls through to the `!session` branch below, redirecting to /login.
  }

  return (
    <button type="button" className="btn-primary mx-auto" disabled={signingOut} onClick={handleSignOut}>
      {signingOut ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
      Sign Out
    </button>
  );
}

function DeactivatedScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-alt px-4">
      <div className="card max-w-md p-8 text-center">
        <h2 className="mb-2 text-lg font-bold text-navy">Account inactive</h2>
        <p className="mb-6 text-sm text-gray-500">
          Your account has been deactivated. Contact a One.Health Partners administrator for access.
        </p>
        <SignOutButton />
      </div>
    </div>
  );
}

// Shown when the users-table check itself failed (RLS denial, network error,
// missing row, etc.) — distinct from a genuine "inactive" account. Surfacing
// the real error here means a broken check is visible and debuggable instead
// of silently bouncing the user back to the login screen. `detail` is the
// structured error object from AuthContext's describeError().
function ProfileErrorScreen({ detail }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-alt px-4">
      <div className="card max-w-md p-8 text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-red-50 text-danger">
          <AlertTriangle className="h-5 w-5" />
        </div>
        <h2 className="mb-2 text-lg font-bold text-navy">Couldn&apos;t verify your account</h2>
        <p className="mb-1 text-sm text-gray-500">
          We signed you in, but couldn&apos;t confirm your account status.
        </p>
        <div className="mb-6 space-y-1 rounded-lg bg-gray-50 px-3 py-2 text-left font-mono text-xs text-gray-600">
          <p><strong>message:</strong> {detail?.message}</p>
          {detail?.code && <p><strong>code:</strong> {detail.code}</p>}
          {detail?.details && <p><strong>details:</strong> {detail.details}</p>}
          {detail?.hint && <p><strong>hint:</strong> {detail.hint}</p>}
          {detail?.status !== null && detail?.status !== undefined && <p><strong>status:</strong> {detail.status}</p>}
          {detail?.stack && (
            <details className="mt-1">
              <summary className="cursor-pointer select-none text-gray-500">stack trace</summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all">{detail.stack}</pre>
            </details>
          )}
        </div>
        <SignOutButton />
      </div>
    </div>
  );
}

export default function ProtectedRoute({ children, adminOnly = false }) {
  const { session, profile, profileError, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-alt">
        <Loader2 className="h-8 w-8 animate-spin text-teal" />
      </div>
    );
  }

  if (!session) return <Navigate to="/login" replace />;

  if (profileError) {
    return <ProfileErrorScreen detail={profileError} />;
  }

  if (!profile?.active) {
    return <DeactivatedScreen />;
  }

  if (adminOnly && profile?.role !== 'admin') {
    return <Navigate to="/" replace />;
  }

  return children;
}
