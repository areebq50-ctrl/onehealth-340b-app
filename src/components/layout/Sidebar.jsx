import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  UploadCloud,
  Database,
  FileBarChart2,
  Sparkles,
  Settings as SettingsIcon,
} from 'lucide-react';
import Logo from '../common/Logo.jsx';

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/upload', label: 'Upload Claims', icon: UploadCloud },
  { to: '/accumulator', label: 'Accumulator', icon: Database },
  { to: '/reports', label: 'Reports', icon: FileBarChart2 },
  { to: '/assistant', label: 'AI Assistant', icon: Sparkles },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

export default function Sidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 flex-col border-r border-gray-200 bg-white md:flex">
      <div className="flex h-16 items-center border-b border-gray-100 px-5">
        <Logo className="h-8 w-auto" />
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
                isActive ? 'bg-teal-50 text-teal-700 font-semibold' : 'text-gray-600 hover:bg-gray-50 hover:text-navy'
              }`
            }
          >
            <Icon className="h-4.5 w-4.5" />
            {label}
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-gray-100 p-4 text-xs text-gray-400">340B Operations Platform v1.0</div>
    </aside>
  );
}
