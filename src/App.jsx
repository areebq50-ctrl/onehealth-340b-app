import { Routes, Route } from 'react-router-dom';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import DayDetail from './pages/DayDetail.jsx';
import UploadClaims from './pages/UploadClaims.jsx';
import Accumulator from './pages/Accumulator.jsx';
import Reports from './pages/Reports.jsx';
import AIAssistant from './pages/AIAssistant.jsx';
import Settings from './pages/Settings.jsx';
import AppLayout from './components/layout/AppLayout.jsx';
import ProtectedRoute from './components/common/ProtectedRoute.jsx';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route
        element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<Dashboard />} />
        <Route path="/day/:claimId" element={<DayDetail />} />
        <Route path="/upload" element={<UploadClaims />} />
        <Route path="/accumulator" element={<Accumulator />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/assistant" element={<AIAssistant />} />
        <Route
          path="/settings"
          element={
            <ProtectedRoute adminOnly>
              <Settings />
            </ProtectedRoute>
          }
        />
      </Route>
    </Routes>
  );
}
