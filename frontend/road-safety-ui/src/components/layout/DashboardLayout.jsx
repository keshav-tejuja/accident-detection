import { Outlet, Link, useLocation, Navigate } from "react-router-dom";
import {
  LayoutDashboard,
  Video,
  UploadCloud,
  FileText,
  Settings,
  ShieldAlert,
  Car,
  Route,
  CreditCard,
  LogOut,
  Bell,
  Gamepad2,
  ChevronDown
} from "lucide-react";
import { useAuth } from "../../hooks/useAuth.jsx";
import VoiceCopilot from "@/components/VoiceCopilot";

export default function DashboardLayout() {
  const location = useLocation();
  const { user, loading, isAuthenticated, logout, isAdmin: authIsAdmin, role } = useAuth();
  const isAdmin = authIsAdmin || role === "admin" || user?.role === "admin" || user?.is_admin === true || user?.email?.toLowerCase().includes("admin");
  const displayName = user?.fullname || user?.email || "Operator";
  const displayEmail = user?.email || "";

  const navItems = [
    { name: "Overview",            path: "/overview",           icon: LayoutDashboard },
    { name: "Live Stream",         path: "/stream",             icon: Video },
    { name: "Upload Video",        path: "/upload",             icon: UploadCloud },
    { name: "Accident Dispatch",   path: "/accident-dispatch",  icon: ShieldAlert, adminOnly: true, badge: "Admin" },
    { name: "Accident Logs",       path: "/incidents",          icon: FileText,   adminOnly: true },
    { name: "Behavior Analytics",  path: "/analytics",          icon: Car },
    { name: "Predictive Routing",  path: "/predictive-routing", icon: Route },
    { name: "Safety Simulator",    path: "/simulator",          icon: Gamepad2 },
    { name: "Billing",             path: "/billing",            icon: CreditCard },
    { name: "Settings",            path: "/settings",           icon: Settings },
  ];

  const visibleNavItems = navItems.filter((item) => {
    if (item.adminOnly && !isAdmin) return false;
    return true;
  });

  // Show loading state
  if (loading) {
    return (
      <div className="w-full h-screen bg-zinc-950 flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 bg-zinc-800 rounded-lg border border-white/10 flex items-center justify-center mx-auto mb-4 animate-pulse">
            <ShieldAlert className="h-6 w-6 text-white" />
          </div>
          <p className="text-zinc-300">Loading...</p>
        </div>
      </div>
    );
  }

  // Check if user is authenticated
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  const handleLogout = () => {
    logout();
  };

  return (
    <div className="flex h-screen w-full bg-transparent overflow-hidden">

      {/* Dynamic Background Elements */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full bg-zinc-800/20 blur-3xl pointer-events-none -z-10 animate-pulse" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[30%] h-[30%] rounded-full bg-zinc-700/10 blur-3xl pointer-events-none -z-10" />

      {/* ---------------- SIDEBAR ---------------- */}
      <aside className="w-72 glass border-r border-white/5 flex flex-col justify-between z-20 shadow-[4px_0_24px_-4px_rgba(0,0,0,0.5)]">

        {/* Top Section */}
        <div className="px-6 py-8">
          <div className="flex items-center gap-3 mb-10 text-white group cursor-pointer">
            <div className="bg-linear-to-br from-zinc-700 to-zinc-900 p-2.5 rounded-xl shadow-lg shadow-zinc-950/50 transform transition-transform group-hover:scale-105 border border-white/10">
              <ShieldAlert className="h-5 w-5 text-white" />
            </div>
            <div className="flex flex-col">
              <span className="text-xl font-black tracking-tight text-gradient">Road Safety AI</span>
              <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mt-0.5">Enterprise Edition</span>
            </div>
          </div>

          <nav className="flex flex-col gap-1.5 mt-4">
            <div className="text-[11px] font-bold text-zinc-500 mb-3 px-3 uppercase tracking-widest">Main Menu</div>
            {visibleNavItems.map((item) => {
              const isActive = location.pathname === item.path || location.pathname.startsWith(`${item.path}/`);
              const Icon = item.icon;
              return (
                <Link
                  key={item.name}
                  to={item.path}
                  className={`relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold transition-all duration-200 ${isActive
                    ? "bg-zinc-800/80 text-white shadow-sm border border-zinc-700/50"
                    : "text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200 border border-transparent"
                    }`}
                >
                  {isActive && (
                    <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-white rounded-r-full shadow-[0_0_8px_rgba(255,255,255,0.4)]" />
                  )}
                  <Icon className={`h-5 w-5 transition-colors ${isActive ? "text-white" : "text-zinc-500"}`} />
                  <span>{item.name}</span>
                  {item.badge && (
                    <span className="ml-auto text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30">
                      {item.badge}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Bottom Section */}
        <div className="p-6 border-t border-white/5 bg-black/20 backdrop-blur-md">
          <div className="flex items-center gap-3 px-3 py-3 rounded-xl bg-zinc-900/50 hover:bg-zinc-800/80 cursor-pointer mb-4 transition-all border border-white/5 hover:border-white/10 hover:shadow-lg">
            <div className="relative">
              <div className="h-10 w-10 rounded-full border border-white/20 shadow-sm object-cover bg-linear-to-br from-amber-400 to-orange-500 flex items-center justify-center text-white font-bold">
                {displayName?.charAt(0)?.toUpperCase()}
              </div>
              <div className="absolute bottom-0 right-0 h-3 w-3 rounded-full bg-green-500 border-2 border-zinc-900"></div>
            </div>
            <div className="flex flex-col flex-1 min-w-0">
              <span className="text-sm font-bold text-white leading-none mb-1.5 truncate">{displayName}</span>
              <span className="text-[10px] font-bold tracking-wider text-zinc-400 uppercase leading-none">{isAdmin ? "System Administrator" : "Operator"}</span>
            </div>
          </div>
          <button 
            onClick={handleLogout}
            className="flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold text-zinc-400 bg-black/40 border border-white/5 hover:bg-white hover:text-zinc-950 hover:border-white transition-all shadow-sm group"
          >
            <LogOut className="h-4 w-4 group-hover:-translate-x-1 transition-transform" />
            Terminate Session
          </button>
        </div>
      </aside>

      {/* ---------------- MAIN CONTENT AREA ---------------- */}
      <main className="flex-1 flex flex-col h-screen overflow-hidden relative z-10 min-w-0">

        {/* Top Header */}
        <header className="flex h-20 items-center justify-between glass border-b border-white/5 px-8 z-20 shrink-0">
          <div className="flex items-center gap-3">
            <h1 className="text-base font-extrabold text-white tracking-tight">Intelligent Transportation System</h1>
          </div>

          <div className="flex items-center gap-4">
            <button className="p-2.5 rounded-full bg-zinc-900/80 border border-white/10 text-zinc-400 hover:text-white hover:border-white/20 hover:shadow-[0_0_15px_rgba(255,255,255,0.1)] transition-all relative">
              <Bell className="h-5 w-5" />
              <span className="absolute top-2 right-2.5 h-2 w-2 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.8)] border border-zinc-900"></span>
            </button>
            <div className="hidden sm:flex flex-col items-end leading-tight">
              <span className="text-sm font-semibold text-zinc-100 truncate max-w-55">{displayName}</span>
              {displayEmail && <span className="text-[11px] text-zinc-400 truncate max-w-55">{displayEmail}</span>}
            </div>
            <div className="flex items-center gap-2.5 px-4 py-2 bg-zinc-900/80 border border-white/10 rounded-full shadow-inner">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.8)]"></span>
              </span>
              <span className="text-[10px] font-bold text-zinc-300 uppercase tracking-widest">FastAPI Online</span>
            </div>
            <button 
              onClick={handleLogout}
              className="p-2.5 rounded-full bg-linear-to-br from-zinc-800 to-zinc-950 border border-red-500/20 text-red-400 hover:text-white hover:bg-red-500 hover:border-red-500 transition-all shadow-sm group"
              title="Terminate Session"
            >
              <LogOut className="h-4 w-4 group-hover:-translate-x-0.5 transition-transform" />
            </button>
          </div>
        </header>

        {/* Dynamic Page Content */}
        <div className="flex-1 overflow-y-auto p-8 relative z-0 hide-scrollbar">
          <div className="max-w-6xl mx-auto pb-12">
            <Outlet />
          </div>
        </div>

      </main>

      {/* Voice Co-Pilot — floats globally on all operator pages */}
      <VoiceCopilot />
    </div>
  );
}