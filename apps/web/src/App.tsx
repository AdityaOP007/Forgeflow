import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SignIn } from '@clerk/clerk-react';
import { Terminal } from 'lucide-react';
import { AuthProvider, useAppAuth } from './context/auth-context';
import { AppShell } from './components/layout/app-shell';
import { DashboardPage } from './pages/dashboard-page';
import { CatalogPage } from './pages/catalog-page';
import { CreateServicePage } from './pages/create-service-page';
import { ServiceDetailPage } from './pages/service-detail-page';
import { TemplatesPage } from './pages/templates-page';
import { WorkflowsPage } from './pages/workflows-page';
import { WorkflowDetailPage } from './pages/workflow-detail-page';
import { DeploymentsPage } from './pages/deployments-page';
import { ActivityLogsPage } from './pages/activity-logs-page';
import { SettingsPage } from './pages/settings-page';
import { ComingSoonPage } from './pages/coming-soon-page';
import { Skeleton } from './components/ui/skeleton';
import { ErrorBoundary } from './components/error-boundary';
import { ApiError } from './lib/api-client';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        // Retry network / transient errors up to 3 times before rendering error state
        if (failureCount >= 3) return false;
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          return false;
        }
        return true;
      },
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 3000),
      refetchOnWindowFocus: false,
    },
  },
});

function AppRouter() {
  const { isLoaded, isSignedIn } = useAppAuth();

  if (!isLoaded) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-6 space-y-4">
        <Skeleton className="h-10 w-10 rounded-full" />
        <Skeleton className="h-4 w-32" />
      </div>
    );
  }

  if (!isSignedIn) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-6 space-y-6">
        <div className="flex items-center space-x-3">
          <div className="h-10 w-10 rounded-lg bg-indigo-600 flex items-center justify-center text-white shadow-md shadow-indigo-500/20">
            <Terminal className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">ForgeFlow</h1>
            <p className="text-xs text-slate-400">Internal Developer Platform</p>
          </div>
        </div>
        <SignIn />
      </div>
    );
  }

  return (
    <Routes>
      <Route element={<AppShell />}>
        {/* Root redirect to /dashboard Overview page */}
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/services" element={<CatalogPage />} />
        <Route path="/services/new" element={<CreateServicePage />} />
        <Route path="/services/:id" element={<ServiceDetailPage />} />
        <Route path="/templates" element={<TemplatesPage />} />
        <Route path="/workflows" element={<WorkflowsPage />} />
        <Route path="/workflows/:id" element={<WorkflowDetailPage />} />
        <Route path="/deployments" element={<DeploymentsPage />} />

        {/* Coming Soon Feature Routes */}
        <Route
          path="/observability"
          element={
            <ComingSoonPage
              title="Observability & Metrics"
              description="Real-time Prometheus metrics, Grafana dashboards, and container health telemetry."
              phase="Phase 4: Monitoring & Metrics"
              phaseNumber={4}
              icon="observability"
            />
          }
        />
        <Route path="/activity" element={<ActivityLogsPage />} />
        <Route path="/settings" element={<SettingsPage />} />

        {/* Fallback Catch-All */}
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <BrowserRouter>
            <AppRouter />
          </BrowserRouter>
        </AuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
