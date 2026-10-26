import React from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { useAuth } from "./context/AuthContext";
import ProtectedRoute from "./components/auth/ProtectedRoute";
import { AdminLayout } from "./components/layout/AdminLayout";
import DashboardLayout from "./components/layout/DashboardLayout";
import Auth from "./pages/auth/Auth";
import AdminDashboard from "./pages/admin/AdminDashboard";
import ModelConfigPanel from "./pages/admin/ModelConfigPanel";
import DispatchRouting from "./pages/admin/DispatchRouting";
import ReportAuditQueue from "./pages/admin/ReportAuditQueue";
import { UserManagement } from "./pages/admin/UserManagement";
import LiveIncidentMap from "./pages/admin/LiveIncidentMap";
import AccidentDispatchPage from "./pages/admin/AccidentDispatchPage";
import Overview from "./pages/dashboard/Overview";
import BehaviorAnalytics from "./pages/dashboard/BehaviorAnalytics";
import LiveStream from "./pages/dashboard/LiveStream";
import VideoUpload from "./pages/dashboard/VideoUpload";
import SafetySimulator from "./pages/dashboard/SafetySimulator";
import IncidentLog from "./pages/incidents/IncidentLog";
import PredictiveRouting from "./pages/dashboard/PredictiveRouting";
import Settings from "./pages/settings/Settings";
import Billing from "./pages/billing/Billing";
import { syncQueuedVideos } from "./services/offlineSync";

// ── Admin-only route guard ────────────────────────────────────────────────────
function AdminRoute({ children }) {
  const { isAdmin, loading } = useAuth();
  const navigate = useNavigate();
  const [toastVisible, setToastVisible] = React.useState(false);

  React.useEffect(() => {
    if (!loading && !isAdmin) {
      setToastVisible(true);
      const t = setTimeout(() => {
        setToastVisible(false);
        navigate("/overview", { replace: true });
      }, 2800);
      return () => clearTimeout(t);
    }
  }, [loading, isAdmin, navigate]);

  if (loading) return null;

  if (!isAdmin) {
    return (
      <>
        {toastVisible && (
          <div className="fixed top-6 right-6 z-9999 flex items-center gap-3 px-5 py-3.5 rounded-2xl bg-red-950 border border-red-500/40 shadow-[0_0_30px_rgba(239,68,68,0.3)] animate-in fade-in slide-in-from-top-4 duration-300">
            <span className="text-red-400 text-lg">🔒</span>
            <div>
              <p className="text-sm font-black text-red-300 tracking-wide">Access Denied</p>
              <p className="text-xs text-red-400/80 font-mono">Admin Privileges Required</p>
            </div>
          </div>
        )}
      </>
    );
  }

  return children;
}

function ConnectivitySyncBridge() {
  const { getFreshToken } = useAuth();

  React.useEffect(() => {
    const syncNow = async () => {
      if (!navigator.onLine) return;
      await syncQueuedVideos({ getFreshToken });
    };

    const onOnline = () => {
      syncNow();
    };

    window.addEventListener("online", onOnline);
    syncNow();

    return () => {
      window.removeEventListener("online", onOnline);
    };
  }, [getFreshToken]);

  return null;
}

function RoleHomeRedirect() {
  const { role, user } = useAuth();
  const isAdmin = role === "admin" || user?.is_admin === true;
  return <Navigate to={isAdmin ? "/admin/config" : "/analytics"} replace />;
}

function AppRoutes() {
  return (
    <>
      <ConnectivitySyncBridge />
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Auth />} />

          <Route element={<ProtectedRoute allowedRoles={["admin"]} />}>
            <Route path="/admin" element={<AdminLayout />}>
              <Route path="dashboard"          element={<AdminDashboard />} />
              <Route path="accident-dispatch"  element={<AccidentDispatchPage />} />
              <Route path="incident-map"       element={<LiveIncidentMap />} />
              <Route path="config"             element={<ModelConfigPanel />} />
              <Route path="dispatch"           element={<DispatchRouting />} />
              <Route path="reports"            element={<ReportAuditQueue />} />
              <Route path="users"              element={<UserManagement />} />
              <Route index element={<Navigate to="/admin/config" replace />} />
            </Route>
          </Route>

          <Route element={<ProtectedRoute allowedRoles={["user", "admin"]} />}>
            <Route path="/" element={<DashboardLayout />}>
              <Route index element={<RoleHomeRedirect />} />
              <Route path="overview"           element={<Overview />} />
              <Route path="stream"             element={<LiveStream />} />
              <Route path="upload"             element={<VideoUpload />} />
              <Route path="accident-dispatch"  element={<AdminRoute><AccidentDispatchPage /></AdminRoute>} />
              <Route path="incidents"          element={<AdminRoute><IncidentLog /></AdminRoute>} />
              <Route path="analytics"          element={<BehaviorAnalytics />} />
              <Route path="predictive-routing" element={<PredictiveRouting />} />
              <Route path="simulator"          element={<SafetySimulator />} />
              <Route path="billing"            element={<Billing />} />
              <Route path="settings"           element={<Settings />} />
            </Route>
          </Route>

          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </BrowserRouter>
    </>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}