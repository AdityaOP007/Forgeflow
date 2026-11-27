import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import type { DeploymentItem, DeploymentStatus } from '@forgeflow/shared-types';
import {
  Rocket,
  RotateCcw,
  RefreshCw,
  AlertCircle,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { useAppAuth } from '../context/auth-context';
import { fetchDeployments, fetchServices, rollbackDeployment } from '../lib/api-client';
import { Card, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Select } from '../components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../components/ui/dialog';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '../components/ui/table';
import { Skeleton } from '../components/ui/skeleton';

function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return '—';
  const startMs = new Date(startedAt).getTime();
  const endMs = completedAt ? new Date(completedAt).getTime() : Date.now();
  const diffSec = Math.max(0, (endMs - startMs) / 1000);
  if (diffSec < 60) return `${diffSec.toFixed(1)}s`;
  const mins = Math.floor(diffSec / 60);
  const secs = Math.round(diffSec % 60);
  return `${mins}m ${secs}s`;
}

function deploymentBadge(status: DeploymentStatus) {
  switch (status) {
    case 'succeeded':
      return <Badge variant="healthy">Succeeded</Badge>;
    case 'failed':
      return <Badge variant="failed">Failed</Badge>;
    case 'in_progress':
    case 'queued':
      return (
        <Badge variant="degraded" className="capitalize">
          {status.replace('_', ' ')}
        </Badge>
      );
    case 'rolled_back':
      return <Badge variant="outline">Rolled back</Badge>;
    default:
      return (
        <Badge variant="unknown" className="capitalize">
          {status}
        </Badge>
      );
  }
}

export function DeploymentsPage() {
  const { role } = useAppAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [serviceFilter, setServiceFilter] = useState<string>('');
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<DeploymentItem | null>(null);

  const { data: servicesData } = useQuery({
    queryKey: ['services', 'all-for-filter'],
    queryFn: () => fetchServices({ pageSize: 100 }),
  });

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['deployments', page, statusFilter, serviceFilter],
    queryFn: () =>
      fetchDeployments({
        page,
        pageSize: 20,
        status: statusFilter ? (statusFilter as DeploymentStatus) : undefined,
        serviceId: serviceFilter || undefined,
      }),
    refetchInterval: 5000,
  });

  const rollbackMutation = useMutation({
    mutationFn: (deploymentId: string) => rollbackDeployment(deploymentId),
    onSuccess: (res) => {
      setRollbackError(null);
      queryClient.invalidateQueries({ queryKey: ['deployments'] });
      navigate(`/workflows/${res.workflowId}`);
    },
    onError: (err: Error) => {
      setRollbackError(err.message);
    },
  });

  const serviceNameById = new Map<string, string>();
  for (const s of servicesData?.data ?? []) {
    serviceNameById.set(s.id, s.name);
  }

  return (
    <div className="space-y-6 max-w-7xl">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white flex items-center space-x-2">
            <Rocket className="h-6 w-6 text-indigo-400" />
            <span>Deployments</span>
          </h1>
          <p className="text-sm text-slate-400">
            Kubernetes Helm deployment history and rollbacks across development environments.
          </p>
        </div>

        <div className="flex items-center space-x-2">
          <Select
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            className="w-40"
          >
            <option value="">All statuses</option>
            <option value="succeeded">Succeeded</option>
            <option value="in_progress">In Progress</option>
            <option value="failed">Failed</option>
            <option value="rolled_back">Rolled Back</option>
          </Select>

          <Select
            aria-label="Filter by service"
            value={serviceFilter}
            onChange={(e) => {
              setServiceFilter(e.target.value);
              setPage(1);
            }}
            className="w-44"
          >
            <option value="">All services</option>
            {(servicesData?.data ?? []).map((svc) => (
              <option key={svc.id} value={svc.id}>
                {svc.name}
              </option>
            ))}
          </Select>

          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {rollbackError && (
        <div className="p-3 bg-rose-500/15 border border-rose-500/30 rounded-lg text-xs text-rose-300 flex items-center space-x-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{rollbackError}</span>
        </div>
      )}

      {isLoading ? (
        <Card className="border-slate-800 bg-slate-900/60 p-6 space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </Card>
      ) : error ? (
        <Card className="border-rose-900 bg-rose-950/20 p-6 text-center space-y-3">
          <AlertCircle className="h-7 w-7 text-rose-400 mx-auto" />
          <p className="text-sm text-rose-300">{(error as Error).message}</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Retry
          </Button>
        </Card>
      ) : !data || data.data.length === 0 ? (
        <Card className="border-slate-800 bg-slate-900/40 p-10 text-center space-y-2">
          <Rocket className="h-8 w-8 text-slate-500 mx-auto" />
          <h2 className="text-base font-semibold text-white">No deployments yet</h2>
          <p className="text-xs text-slate-400">
            Open any ready service in the{' '}
            <Link to="/services" className="text-indigo-400 underline">
              Service Catalog
            </Link>{' '}
            to deploy a built container image.
          </p>
        </Card>
      ) : (
        <Card className="border-slate-800 bg-slate-900/60 overflow-hidden">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Service</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Environment</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Workflow</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.data.map((dep: DeploymentItem) => {
                  const canRollback =
                    role !== 'viewer' &&
                    (dep.status === 'succeeded' || dep.status === 'rolled_back');
                  return (
                    <TableRow key={dep.id}>
                      <TableCell>
                        <Link
                          to={`/services/${dep.serviceId}`}
                          className="text-indigo-400 hover:underline font-medium"
                        >
                          {serviceNameById.get(dep.serviceId) ?? dep.serviceId.slice(0, 8)}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-xs text-slate-200" title={dep.commitSha}>
                          {dep.commitSha.slice(0, 7)}
                        </span>
                        {dep.rollbackOf && (
                          <span className="ml-2 text-[11px] text-amber-300">(rollback)</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-mono text-[11px] text-slate-300">
                          development
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-slate-400 font-mono">
                        {dep.startedAt
                          ? new Date(dep.startedAt).toLocaleString()
                          : new Date(dep.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-xs text-slate-400 font-mono">
                        {formatDuration(dep.startedAt, dep.completedAt)}
                      </TableCell>
                      <TableCell>
                        {deploymentBadge(dep.status)}
                        {dep.errorSummary && (
                          <p
                            className="text-[11px] text-rose-400 truncate max-w-xs mt-1"
                            title={dep.errorSummary}
                          >
                            {dep.errorSummary}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        {dep.workflowRunId ? (
                          <Link
                            to={`/workflows/${dep.workflowRunId}`}
                            className="inline-flex items-center space-x-1 text-xs text-indigo-400 hover:underline font-mono"
                          >
                            <span>{dep.workflowRunId.slice(0, 8)}</span>
                            <ExternalLink className="h-3 w-3" />
                          </Link>
                        ) : (
                          <span className="text-xs text-slate-500">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {canRollback && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={rollbackMutation.isPending}
                            onClick={() => setRollbackTarget(dep)}
                            className="space-x-1"
                          >
                            <RotateCcw className="h-3 w-3" />
                            <span>Rollback</span>
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-slate-400">
          <span>
            Page {data.page} of {data.totalPages} ({data.total} total)
          </span>
          <div className="flex items-center space-x-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= data.totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      <Dialog
        open={Boolean(rollbackTarget)}
        onOpenChange={(open) => !open && setRollbackTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Rollback</DialogTitle>
            <DialogDescription>
              Roll back{' '}
              <span className="font-semibold text-white">
                {rollbackTarget
                  ? (serviceNameById.get(rollbackTarget.serviceId) ??
                    rollbackTarget.serviceId.slice(0, 8))
                  : ''}
              </span>{' '}
              in <span className="font-mono text-slate-200">development</span> to commit{' '}
              <span className="font-mono text-indigo-300">
                {rollbackTarget?.commitSha.slice(0, 7)}
              </span>
              ? This creates a new deployment using that commit&apos;s verified image.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRollbackTarget(null)}
              disabled={rollbackMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!rollbackTarget || rollbackMutation.isPending}
              onClick={() => {
                if (rollbackTarget) {
                  rollbackMutation.mutate(rollbackTarget.id);
                  setRollbackTarget(null);
                }
              }}
            >
              {rollbackMutation.isPending ? 'Starting Rollback...' : 'Confirm Rollback'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
