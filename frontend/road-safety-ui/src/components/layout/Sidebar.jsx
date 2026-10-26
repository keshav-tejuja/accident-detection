import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ShieldAlert, LayoutDashboard, Users, Brain, Route, FileSearch, LogOut, MapPin } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

export const Sidebar = () => {
    const location = useLocation();
    const { user, logout } = useAuth();
    const displayName = user?.fullname || user?.email || "Administrator";

    const navItems = [
        { label: 'System Overview',    path: '/admin/dashboard', icon: LayoutDashboard },
        { label: 'Accident Dispatch',  path: '/admin/accident-dispatch', icon: ShieldAlert },
        { label: 'Live Incident Map',  path: '/admin/incident-map', icon: MapPin },
        { label: 'User Management',    path: '/admin/users',     icon: Users },
        { label: 'Model Config',       path: '/admin/config',    icon: Brain },
        { label: 'Dispatch Routing',   path: '/admin/dispatch',  icon: Route },
        { label: 'Report Audit',       path: '/admin/reports',   icon: FileSearch },
    ];

    const isActive = (path) => location.pathname === path;

    const handleLogout = () => {
        logout();
    };

    return (
        <aside className="w-72 glass border-r border-white/5 flex flex-col justify-between z-20 shadow-[4px_0_24px_-4px_rgba(0,0,0,0.5)]">
            {/* Branding */}
            <div className="px-6 py-8">
                <div className="flex items-center gap-3 mb-10 text-white group cursor-pointer">
                    <div className="bg-linear-to-br from-zinc-700 to-zinc-900 p-2.5 rounded-xl shadow-lg shadow-zinc-950/50 transform transition-transform group-hover:scale-105 border border-white/10">
                        <ShieldAlert className="h-5 w-5 text-white" />
                    </div>
                    <div>
                        <span className="text-xl font-black tracking-tight text-gradient">Road Safety AI</span>
                        <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mt-0.5">Admin Console</p>
                    </div>
                </div>

            <nav className="flex flex-col gap-1.5 mt-4">
                <p className="text-[11px] font-bold text-zinc-500 mb-3 px-3 uppercase tracking-widest">System Menu</p>
                <ul className="space-y-1.5">
                    {navItems.map((item) => (
                        <li key={item.path}>
                            {(() => {
                                const Icon = item.icon;
                                return (
                            <Link
                                to={item.path}
                                className={`relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold transition-all duration-200 ${
                                    isActive(item.path)
                                        ? 'bg-zinc-800/80 text-white shadow-sm border border-zinc-700/50'
                                        : 'text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200 border border-transparent'
                                }`}
                            >
                                {isActive(item.path) && (
                                    <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-white rounded-r-full shadow-[0_0_8px_rgba(255,255,255,0.4)]" />
                                )}
                                <Icon className={`h-5 w-5 transition-colors ${isActive(item.path) ? 'text-white' : 'text-zinc-500'}`} />
                                <span className="font-medium">{item.label}</span>
                            </Link>
                                );
                            })()}
                        </li>
                    ))}
                </ul>
            </nav>
            </div>

            {/* Footer */}
            <div className="p-6 border-t border-white/5 bg-black/20 backdrop-blur-md">
                <div className="flex items-center gap-3 px-3 py-3 rounded-xl bg-zinc-900/50 hover:bg-zinc-800/80 cursor-pointer mb-4 transition-all border border-white/5 hover:border-white/10 hover:shadow-lg">
                    <div className="relative">
                        <div className="h-10 w-10 rounded-full border border-white/20 shadow-sm object-cover bg-linear-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white font-bold">
                            {displayName?.charAt(0)?.toUpperCase()}
                        </div>
                        <div className="absolute bottom-0 right-0 h-3 w-3 rounded-full bg-green-500 border-2 border-zinc-900"></div>
                    </div>
                    <div className="flex flex-col flex-1 min-w-0">
                        <span className="text-sm font-bold text-white leading-none mb-1.5 truncate">{displayName}</span>
                        <span className="text-[10px] font-bold tracking-wider text-zinc-400 uppercase leading-none">System Admin</span>
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
    );
};
