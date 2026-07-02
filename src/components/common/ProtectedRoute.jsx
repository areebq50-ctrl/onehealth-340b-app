import { Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext.jsx';

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
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-alt px-4">
        <div className="card max-w-md p-8 text-center">
          <h2 className="mb-2 text-lg font-bold text-navy">Account inactive</h2>
          <p className="text-sm text-gray-500">
            Your account has been deactivated. Contact a One.Health Partners administrator for access.
          </p>
        </div>
      </div>
    );
  }

  if (adminOnly && profile?.role !== 'admin') {
    return <Navigate to="/" replace />;
  }

  return children;
}
