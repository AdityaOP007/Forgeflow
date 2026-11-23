import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAppAuth } from './context/auth-context';
import { AppShell } from './components/layout/app-shell';
import { SignInScreen } from './components/auth/sign-in-screen';
import { DashboardPage } from './pages/dashboard-page';
import { CatalogPage } from './pages/catalog-page';
import { CreateServicePage } from './pages/create-service-page';
import { ServiceDetailPage } from './pages/service-detail-page';
import { TemplatesPage } from './pages/templates-page';
import { ComingSoonPage } from './pages/coming-soon-page';
import { Skeleton } from './components/ui/skeleton';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function AppRouter() {
  const { isSignedIn, isLoaded } = useAppAuth();

  if (!isLoaded) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-6 space-y-4">
        <Skeleton className="h-10 w-10 rounded-full" />
        <Skeleton className="h-4 w-32" />
      </div>
    );
  }

  if (!isSignedIn) {
    return <SignInScreen />;
  }

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/services" element={<CatalogPage />} />
        <Route path="/services/new" element={<CreateServicePage />} />
        <Route path="/services/:id" element={<ServiceDetailPage />} />
        <Route path="/templates" element={<TemplatesPage />} />

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

        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <AppRouter />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
