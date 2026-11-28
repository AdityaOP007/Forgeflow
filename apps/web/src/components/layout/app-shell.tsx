import React from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Layers,
  FileCode2,
  Rocket,
  Activity,
  History,
  Settings,
  Terminal,
  ChevronRight,
  GitBranch,
  LogOut,
} from 'lucide-react';
import { useAppAuth } from '../../context/auth-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';

export function AppShell() {
  const { user, role, signOut } = useAppAuth();
  const location = useLocation();
  const navigate = useNavigate();

  // Generate breadcrumb items from path
  const pathSegments = location.pathname.split('/').filter(Boolean);
  const breadcrumbs = [
    { label: 'ForgeFlow', path: '/dashboard' },
    ...pathSegments
      .filter((segment) => segment !== 'dashboard')
      .map((segment, index) => {
        const path = '/' + pathSegments.slice(0, index + 1).join('/');
        let label = segment.charAt(0).toUpperCase() + segment.slice(1);
        if (segment === 'services') label = 'Catalog';
        if (segment === 'new') label = 'New Service';
        if (segment === 'workflows') label = 'Workflows';
        return { label, path };
      }),
  ];

  const navLinkClasses = ({ isActive }: { isActive: boolean }) =>
    `flex items-center space-x-3 px-3 py-2 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
      isActive
        ? 'bg-indigo-600/15 text-indigo-400 font-semibold'
        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
    }`;

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">
      {/* Sidebar */}
      <aside
        aria-label="Sidebar Navigation"
        className="w-64 border-r border-slate-800 bg-slate-900/70 flex flex-col justify-between shrink-0"
      >
        <div>
          {/* Logo */}
          <div className="p-6 border-b border-slate-800/80 flex items-center space-x-3">
            <div className="h-9 w-9 rounded-lg bg-indigo-600 flex items-center justify-center text-white shadow-md shadow-indigo-500/20">
              <Terminal className="h-5 w-5" />
            </div>
            <div>
              <span className="font-bold text-lg tracking-tight text-white block">ForgeFlow</span>
              <span className="text-xs text-slate-400 block -mt-1">
                Internal Developer Platform
              </span>
            </div>
          </div>

          {/* Core Navigation Links */}
          <nav aria-label="Main Navigation" className="p-4 space-y-1">
            <div className="text-[10px] uppercase font-semibold text-slate-500 px-3 py-1 tracking-wider">
              Platform
            </div>
            <NavLink to="/dashboard" className={navLinkClasses}>
              <LayoutDashboard className="h-4 w-4" />
              <span>Overview</span>
            </NavLink>

            <NavLink to="/services" className={navLinkClasses}>
              <Layers className="h-4 w-4" />
              <span>Service Catalog</span>
            </NavLink>

            <NavLink to="/templates" className={navLinkClasses}>
              <FileCode2 className="h-4 w-4" />
              <span>Templates</span>
            </NavLink>

            {/* Delivery & Operations */}
            <div className="text-[10px] uppercase font-semibold text-slate-500 px-3 pt-4 pb-1 tracking-wider">
              Operations
            </div>
            <NavLink to="/workflows" className={navLinkClasses}>
              <GitBranch className="h-4 w-4" />
              <span>Workflows</span>
            </NavLink>

            <NavLink to="/deployments" className={navLinkClasses}>
              <Rocket className="h-4 w-4" />
              <span>Deployments</span>
            </NavLink>

            <NavLink to="/observability" className={navLinkClasses}>
              <Activity className="h-4 w-4" />
              <span>Observability</span>
            </NavLink>

            <NavLink to="/activity" className={navLinkClasses}>
              <History className="h-4 w-4" />
              <span>Activity Logs</span>
            </NavLink>

            <NavLink to="/settings" className={navLinkClasses}>
              <Settings className="h-4 w-4" />
              <span>Settings</span>
            </NavLink>
          </nav>
        </div>

        {/* Sidebar Footer with authenticated user menu, role, and sign-out */}
        <div className="p-4 border-t border-slate-800/80 space-y-2.5">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <span className="text-sm font-medium text-slate-200 block truncate">
                {user?.name || user?.email || 'Signed in'}
              </span>
              <span className="text-xs text-slate-500 block truncate">{user?.email || ''}</span>
            </div>
            <Badge
              variant="outline"
              className="capitalize text-[10px] ml-2 shrink-0 border-indigo-500 text-indigo-400 bg-indigo-950/30"
            >
              {role}
            </Badge>
          </div>
          {role === 'viewer' && (
            <p className="text-[11px] text-slate-400">
              Read-only viewer role. Ask an admin to grant developer access.
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => signOut()}
            className="w-full justify-center space-x-1.5 text-xs text-slate-300"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span>Sign out</span>
          </Button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top Header / Breadcrumbs & Topbar User Display */}
        <header
          aria-label="Top Navigation Bar"
          className="h-16 border-b border-slate-800 bg-slate-900/40 px-6 flex items-center justify-between shrink-0"
        >
          {/* Breadcrumb Trail */}
          <nav aria-label="Breadcrumbs" className="flex items-center space-x-2 text-sm">
            {breadcrumbs.map((crumb, idx) => (
              <React.Fragment key={`${crumb.path}-${idx}`}>
                {idx > 0 && <ChevronRight className="h-3.5 w-3.5 text-slate-600" />}
                {idx === breadcrumbs.length - 1 ? (
                  <span className="font-semibold text-slate-100">{crumb.label}</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => navigate(crumb.path)}
                    className="text-slate-400 hover:text-slate-200 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500 rounded px-1"
                  >
                    {crumb.label}
                  </button>
                )}
              </React.Fragment>
            ))}
          </nav>

          {/* Topbar: User Info as plain text and action buttons */}
          <div className="flex items-center space-x-4">
            <div className="text-right">
              <span className="text-sm font-medium text-slate-200 block">
                {user?.name || 'Local Admin'}
              </span>
              <span className="text-xs text-indigo-400 font-mono capitalize block">{role}</span>
            </div>

            {role !== 'viewer' && (
              <Button
                size="sm"
                onClick={() => navigate('/services/new')}
                className="focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                Create Service
              </Button>
            )}
          </div>
        </header>

        {/* Page Content Viewport */}
        <main
          aria-label="Main Page Content"
          className="flex-1 overflow-y-auto p-8 focus-visible:outline-none"
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
