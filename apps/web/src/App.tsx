import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAppAuth } from './context/auth-context';
import { AppShell } from './components/layout/app-shell';
import { DashboardPage } from './pages/dashboard-page';
import { CatalogPage } from './pages/catalog-page';
import { CreateServicePage } from './pages/create-service-page';
import { ServiceDetailPage } from './pages/service-detail-page';
import { TemplatesPage } from './pages/templates-page';
import { WorkflowsPage } from './pages/workflows-page';
import { WorkflowDetailPage } from './pages/workflow-detail-page';
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
  const { isLoaded } = useAppAuth();

  if (!isLoaded) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-6 space-y-4">
        <Skeleton className="h-10 w-10 rounded-full" />
        <Skeleton className="h-4 w-32" />
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

        {/* Coming Soon Feature Routes */}
        <Route
          path="/deployments"
          element={
            <ComingSoonPage
              title="Deployments"
              description="Orchestrate and track multi-environment container deployments across Kubernetes clusters."
              phase="Phase 3: Deployments & Environments"
              phaseNumber={3}
              icon="deployments"
            />
          }
        />
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
        <Route
          path="/activity"
          element={
            <ComingSoonPage
              title="Activity Logs"
              description="Audit log stream tracking service mutations, pipeline triggers, and security events."
              phase="Phase 4: Audit Logs & Activity Stream"
              phaseNumber={4}
              icon="activity"
            />
          }
        />
        <Route
          path="/settings"
          element={
            <ComingSoonPage
              title="Platform Settings"
              description="Team role-based access control, GitHub app integrations, and cloud cluster credentials."
              phase="Phase 4: Platform Settings & Integrations"
              phaseNumber={4}
              icon="settings"
            />
          }
        />

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
