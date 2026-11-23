import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  Layers,
  CheckCircle2,
  Rocket,
  XCircle,
  Plus,
  Check,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';
import { useAppAuth } from '../context/auth-context';
import { fetchDashboardSummary } from '../lib/api-client';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';

export function DashboardPage() {
  const { token, user, role } = useAppAuth();
  const navigate = useNavigate();

  const {
    data: summary,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['dashboardSummary', token],
    queryFn: () => fetchDashboardSummary(token || ''),
    enabled: Boolean(token),
  });

  if (isLoading) {
    return (
      <div className="space-y-8">
        <div>
          <Skeleton className="h-8 w-64 mb-2" />
          <Skeleton className="h-4 w-96" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (error || !summary) {
    return (
      <div className="p-8 text-center bg-rose-950/20 border border-rose-900 rounded-lg space-y-4 max-w-xl mx-auto my-8">
        <AlertCircle className="h-8 w-8 text-rose-400 mx-auto" />
        <div>
          <h2 className="text-lg font-semibold text-white">Failed to Load Dashboard</h2>
          <p className="text-sm text-slate-400 mt-1">
            {(error as Error)?.message ||
              'An error occurred while communicating with the platform API.'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} className="space-x-2">
          <RefreshCw className="h-4 w-4" />
          <span>Try Again</span>
        </Button>
      </div>
    );
  }

  // Get Started checklist computed dynamically from real data (no saved flags)
  const checklist = [
    {
      title: 'Authenticate account',
      description: `Signed in as ${user?.email || 'authenticated user'} (${role})`,
      done: Boolean(user),
    },
    {
      title: 'Provision your first service',
      description: 'Create a microservice from a standardized architecture template',
      done: summary.totalServices > 0,
    },
    {
      title: 'Deploy to environment',
      description: 'Trigger deployment pipeline and verify production health checks',
      done: summary.healthyCount > 0,
    },
  ];

  const isEmpty = summary.totalServices === 0;

  return (
    <div className="space-y-8 max-w-7xl">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Platform Dashboard</h1>
          <p className="text-sm text-slate-400">
            Real-time status across services, environments, and CI/CD pipelines.
          </p>
        </div>
        {role !== 'viewer' && (
          <Button onClick={() => navigate('/services/new')} className="space-x-2 shrink-0">
            <Plus className="h-4 w-4" />
            <span>Create Service</span>
          </Button>
        )}
      </div>

      {/* The Four Spec Cards: Services, Healthy, Deployments, Failed Builds */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {/* 1. Services */}
        <Card className="border-slate-800 bg-slate-900/60">
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-slate-300">Services</CardTitle>
            <Layers className="h-4 w-4 text-indigo-400" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-white">{summary.totalServices}</div>
            <p className="text-xs text-slate-500 mt-1">Catalogued microservices</p>
          </CardContent>
        </Card>

        {/* 2. Healthy */}
        <Card className="border-slate-800 bg-slate-900/60">
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-slate-300">Healthy</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-emerald-400">{summary.healthyCount}</div>
            <p className="text-xs text-slate-500 mt-1">Passing all health probes</p>
          </CardContent>
        </Card>

        {/* 3. Deployments */}
        <Card className="border-slate-800 bg-slate-900/60">
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-slate-300">Deployments</CardTitle>
            <Rocket className="h-4 w-4 text-blue-400" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-blue-400">{summary.activeDeployments}</div>
            <p className="text-xs text-slate-500 mt-1">Active deployment workflows</p>
          </CardContent>
        </Card>

        {/* 4. Failed Builds */}
        <Card className="border-slate-800 bg-slate-900/60">
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-slate-300">Failed Builds</CardTitle>
            <XCircle className="h-4 w-4 text-rose-400" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-rose-400">{summary.failedBuilds}</div>
            <p className="text-xs text-slate-500 mt-1">Failed within the last 24h</p>
          </CardContent>
        </Card>
      </div>

      {/* Get Started Checklist (computed from real data) */}
      <Card className="border-slate-800 bg-slate-900/40 p-6">
        <h2 className="text-base font-semibold text-white mb-1">Get Started with ForgeFlow</h2>
        <p className="text-xs text-slate-400 mb-5">
          Follow these milestones to bring your first service to production.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {checklist.map((item, index) => (
            <div
              key={item.title}
              className={`p-4 rounded-lg border transition-all ${
                item.done
                  ? 'bg-emerald-950/20 border-emerald-500/30 text-emerald-200'
                  : 'bg-slate-950/40 border-slate-800 text-slate-400'
              }`}
            >
              <div className="flex items-center space-x-2.5 mb-1.5">
                {item.done ? (
                  <div className="h-5 w-5 rounded-full bg-emerald-500/20 flex items-center justify-center text-emerald-400 shrink-0">
                    <Check className="h-3.5 w-3.5" />
                  </div>
                ) : (
                  <div className="h-5 w-5 rounded-full bg-slate-800 flex items-center justify-center text-slate-500 shrink-0 font-mono text-xs">
                    {index + 1}
                  </div>
                )}
                <span className="text-xs font-semibold text-slate-200">{item.title}</span>
              </div>
              <p className="text-[11px] text-slate-400 leading-normal pl-7.5">{item.description}</p>
            </div>
          ))}
        </div>
      </Card>

      {/* Empty State Onboarding if no services */}
      {isEmpty && (
        <Card className="p-12 text-center border-dashed border-slate-800 bg-slate-900/30">
          <div className="mx-auto h-12 w-12 rounded-full bg-slate-800 flex items-center justify-center text-slate-400 mb-4">
            <Layers className="h-6 w-6" />
          </div>
          <h3 className="text-lg font-semibold text-white">No services registered</h3>
          <p className="text-sm text-slate-400 max-w-sm mx-auto mt-1 mb-6">
            Get started by provisioning your first service from a standardized template.
          </p>
          {role !== 'viewer' ? (
            <Button onClick={() => navigate('/services/new')}>Create Your First Service</Button>
          ) : (
            <p className="text-xs text-slate-500">
              Contact a developer or admin to create services.
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
