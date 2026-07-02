import { useLocation, Link } from 'react-router-dom';

const LABELS = {
  '': 'Dashboard',
  upload: 'Upload Claims',
  accumulator: 'Accumulator',
  reports: 'Reports',
  assistant: 'AI Assistant',
  settings: 'Settings',
  day: 'Day Detail',
};

export default function Breadcrumb() {
  const { pathname } = useLocation();
  const parts = pathname.split('/').filter(Boolean);

  if (parts.length === 0) {
    return <h1 className="text-lg font-bold text-navy">Dashboard</h1>;
  }

  return (
    <nav className="flex items-center gap-1.5 text-sm text-gray-500">
      <Link to="/" className="hover:text-teal">
        Home
      </Link>
      {parts.map((part, i) => {
        const href = '/' + parts.slice(0, i + 1).join('/');
        const isLast = i === parts.length - 1;
        const label = LABELS[part] ?? decodeURIComponent(part);
        return (
          <span key={href} className="flex items-center gap-1.5">
            <span>/</span>
            {isLast ? (
              <span className="font-semibold text-navy">{label}</span>
            ) : (
              <Link to={href} className="hover:text-teal">
                {label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
