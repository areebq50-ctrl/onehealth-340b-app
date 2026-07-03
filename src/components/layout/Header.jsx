import { useState } from 'react';
import { LogOut, ChevronDown } from 'lucide-react';
import { useAuth } from '../../context/AuthContext.jsx';
import Breadcrumb from './Breadcrumb.jsx';
import ScopeLabel from '../common/ScopeLabel.jsx';

export default function Header() {
  const { profile, signOut } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  const initials = (profile?.email ?? '?').slice(0, 2).toUpperCase();

  return (
    <header className="sticky top-0 z-10 flex h-16 items-center justify-between border-b border-gray-200 bg-white px-6">
      <Breadcrumb />

      <div className="flex items-center gap-4">
        <ScopeLabel className="hidden lg:flex" />

        <div className="relative">
          <button
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-gray-50"
            onClick={() => setMenuOpen((o) => !o)}
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-teal text-xs font-semibold text-white">
              {initials}
            </div>
            <div className="hidden text-left sm:block">
              <p className="text-sm font-medium leading-tight text-navy">{profile?.email}</p>
              <p className="text-xs capitalize leading-tight text-gray-500">{profile?.role}</p>
            </div>
            <ChevronDown className="h-4 w-4 text-gray-400" />
          </button>

          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 z-20 mt-2 w-44 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
                <button
                  className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-navy hover:bg-gray-50"
                  onClick={signOut}
                >
                  <LogOut className="h-4 w-4" />
                  Log out
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
