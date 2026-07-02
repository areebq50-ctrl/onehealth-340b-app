import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar.jsx';
import Header from './Header.jsx';
import ErrorBoundary from '../common/ErrorBoundary.jsx';
import { FacilityProvider } from '../../context/FacilityContext.jsx';

export default function AppLayout() {
  return (
    <FacilityProvider>
      <div className="min-h-screen bg-surface-alt">
        <Sidebar />
        <div className="md:pl-64">
          <Header />
          <main className="p-6">
            <ErrorBoundary label="This page">
              <Outlet />
            </ErrorBoundary>
          </main>
        </div>
      </div>
    </FacilityProvider>
  );
}
