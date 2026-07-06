import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Loader2, LogOut } from 'lucide-react';
import { useAuth } from '../../context/AuthContext.jsx';

function DeactivatedScreen() {
  const { signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    await signOut();
    // onAuthStateChange clears `session`, so ProtectedRoute re-renders and
    // falls through to the `!session` branch below, redirecting to /login.
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-alt px-4">
      <div className="card max-w-md p-8 text-center">
        <h2 className="mb-2 text-lg font-bold text-navy">Account inactive</h2>
        <p className="mb-6 text-sm text-gray-500">
          Your account has been deactivated. Contact a One.Health Partners administrator for access.
        </p>
        <button type="button" className="btn-primary mx-auto" disabled={signingOut} onClick={handleSignOut}>
          {signingOut ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
          Sign Out
        </button>
      </div>
    </div>
  );
}

export default function ProtectedRoute({ children, adminOnly = false }) {
  const { session, profile, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-alt">
        <Loader2 className="h-8 w-8 animate-spin text-teal" />
      </div>
    );
  }

  if (!session) return <Navigate to="/login" replace />;

  if (!profile?.active) {
    return <DeactivatedScreen />;
  }

  if (adminOnly && profile?.role !== 'admin') {
    return <Navigate to="/" replace />;
  }

  return children;
}
