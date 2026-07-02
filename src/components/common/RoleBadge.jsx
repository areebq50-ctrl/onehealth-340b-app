export default function RoleBadge({ role }) {
  const isAdmin = role === 'admin';
  return (
    <span className={`badge ${isAdmin ? 'bg-coral-50 text-coral-700' : 'bg-teal-50 text-teal-700'}`}>
      {isAdmin ? 'Admin' : 'Regular'}
    </span>
  );
}
