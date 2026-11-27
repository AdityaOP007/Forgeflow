import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, Link } from 'react-router-dom';
import {
  GitBranch,
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  Ban,
  Filter,
  ArrowRight,
} from 'lucide-react';
import { fetchWorkflows } from '../lib/api-client';
import { Button } from '../components/ui/button';
import { Select } from '../components/ui/select';
import { Badge } from '../components/ui/badge';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '../components/ui/table';
import { Card } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import type { WorkflowRunStatus, WorkflowType } from '@forgeflow/shared-types';

export function WorkflowsPage() {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [page, setPage] = useState(1);
  const pageSize = 15;

  const {
    data: response,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['workflows', statusFilter, typeFilter, page],
    queryFn: () =>
      fetchWorkflows({
        status: statusFilter !== 'all' ? (statusFilter as WorkflowRunStatus) : undefined,
        type: typeFilter !== 'all' ? (typeFilter as WorkflowType) : undefined,
        page,
        pageSize,
      }),
    refetchInterval: 4000,
  });

  const formatDuration = (startedAt: string | null, completedAt: string | null) => {
    if (!startedAt) return '—';
    const startMs = new Date(startedAt).getTime();
    const endMs = completedAt ? new Date(completedAt).getTime() : Date.now();
    const diffSec = Math.max(0, (endMs - startMs) / 1000);
    if (diffSec < 60) return `${diffSec.toFixed(1)}s`;
    const mins = Math.floor(diffSec / 60);
    const secs = Math.round(diffSec % 60);
    return `${mins}m ${secs}s`;
  };

  const getStatusBadge = (status: WorkflowRunStatus) => {
    switch (status) {
      case 'succeeded':
        return (
          <Badge variant="healthy" className="gap-1">
            <CheckCircle2 className="h-3 w-3" />
            Succeeded
          </Badge>
        );
      case 'failed':
        return (
          <Badge variant="failed" className="gap-1">
            <XCircle className="h-3 w-3" />
            Failed
          </Badge>
        );
      case 'running':
        return (
          <Badge variant="default" className="gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            Running
          </Badge>
        );
      case 'cancelled':
        return (
          <Badge variant="unknown" className="gap-1">
            <Ban className="h-3 w-3" />
            Cancelled
          </Badge>
        );
      default:
        return (
          <Badge variant="degraded" className="gap-1">
            <Clock className="h-3 w-3" />
            Queued
          </Badge>
        );
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Workflows</h1>
          <p className="text-sm text-slate-400">
            Track asynchronous service scaffolding runs, step progress, and execution logs.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between bg-slate-900/60 p-3 rounded-lg border border-slate-800">
        <div className="flex items-center space-x-2">
          <Filter className="h-4 w-4 text-slate-500 shrink-0" />
          <Select
            aria-label="Filter workflows by status"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            className="w-48 bg-slate-950/60"
          >
            <option value="all">All Statuses</option>
            <option value="queued">Queued</option>
            <option value="running">Running</option>
            <option value="succeeded">Succeeded</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
          </Select>
          <Select
            aria-label="Filter workflows by type"
            value={typeFilter}
            onChange={(e) => {
              setTypeFilter(e.target.value);
              setPage(1);
            }}
            className="w-44 bg-slate-950/60"
          >
            <option value="all">All Types</option>
            <option value="scaffold">Scaffold</option>
            <option value="deploy">Deploy</option>
            <option value="undeploy">Undeploy</option>
          </Select>
        </div>
        {response && (
          <span className="text-xs text-slate-400">
            {response.total} total workflow{response.total === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : error ? (
        <div className="p-8 text-center text-rose-400 bg-rose-950/20 border border-rose-900 rounded-lg">
          Failed to load workflows. {(error as Error).message}
        </div>
      ) : !response || response.data.length === 0 ? (
        <Card className="p-12 text-center border-dashed border-slate-800 bg-slate-900/40">
          <div className="mx-auto h-12 w-12 rounded-full bg-slate-800 flex items-center justify-center text-slate-400 mb-4">
            <GitBranch className="h-6 w-6" />
          </div>
          <h3 className="text-lg font-semibold text-white">No workflow runs found</h3>
          <p className="text-sm text-slate-400 max-w-sm mx-auto mt-1 mb-6">
            {statusFilter !== 'all'
              ? 'No workflow runs match the selected status filter.'
              : 'Scaffold a new service from a template to start a provisioning workflow.'}
          </p>
          <Button onClick={() => navigate('/services/new')}>Scaffold a Service</Button>
        </Card>
      ) : (
        <Card className="overflow-hidden border-slate-800 bg-slate-900/50">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workflow ID</TableHead>
                <TableHead>Service</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead className="text-right">Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {response.data.map((wf) => (
                <TableRow
                  key={wf.id}
                  onClick={() => navigate(`/workflows/${wf.id}`)}
                  className="cursor-pointer hover:bg-slate-800/40"
                >
                  <TableCell className="font-mono text-xs">
                    <Link
                      to={`/workflows/${wf.id}`}
                      title={wf.id}
                      onClick={(e) => e.stopPropagation()}
                      className="text-indigo-400 hover:text-indigo-300 hover:underline"
                    >
                      {wf.id.slice(0, 8)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <div className="font-medium text-white">{wf.serviceName}</div>
                    <div className="text-xs font-mono text-slate-500">{wf.serviceSlug}</div>
                  </TableCell>
                  <TableCell className="capitalize text-slate-300">{wf.type}</TableCell>
                  <TableCell>{getStatusBadge(wf.status)}</TableCell>
                  <TableCell className="font-mono text-slate-400">{wf.attempts}</TableCell>
                  <TableCell className="text-xs text-slate-400 font-mono">
                    {wf.startedAt ? new Date(wf.startedAt).toLocaleString() : '—'}
                  </TableCell>
                  <TableCell className="text-xs text-slate-300 font-mono">
                    {formatDuration(wf.startedAt, wf.completedAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/workflows/${wf.id}`);
                      }}
                    >
                      <span>View</span>
                      <ArrowRight className="h-3.5 w-3.5 ml-1" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {response.totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-slate-800 bg-slate-900/80">
              <span className="text-xs text-slate-400">
                Page {response.page} of {response.totalPages}
              </span>
              <div className="flex items-center space-x-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= response.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
