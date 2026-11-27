import React, { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  Ban,
  RotateCcw,
  ExternalLink,
  GitCommit,
  GitFork,
  Terminal,
  AlertTriangle,
  FileCode2,
  Copy,
  Check,
} from 'lucide-react';
import {
  fetchWorkflowById,
  fetchWorkflowLogs,
  retryWorkflow,
  cancelWorkflow,
} from '../lib/api-client';
import { useAppAuth } from '../context/auth-context';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../components/ui/dialog';
import { Skeleton } from '../components/ui/skeleton';
import { isSafeHttpsUrl, isSafeApplicationUrl } from '../lib/utils';
import type { WorkflowLog, WorkflowRunStatus, WorkflowStepStatus } from '@forgeflow/shared-types';

interface WorkflowResourcesShape {
  template?: {
    slug?: string;
    version?: string;
    fileCount?: number;
  };
  repository?: {
    url?: string;
    fullName?: string;
    private?: boolean;
    defaultBranch?: string;
  };
  commit?: {
    sha?: string;
    url?: string;
  };
  deploymentId?: string;
  environment?: string;
  commitSha?: string;
  image?: string;
  helmRevision?: number;
  url?: string;
  nodePort?: number;
}

export function WorkflowDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { role } = useAppAuth();

  const [logs, setLogs] = useState<WorkflowLog[]>([]);
  const [copiedSha, setCopiedSha] = useState(false);
  const [isCancelDialogOpen, setIsCancelDialogOpen] = useState(false);
  const cursorRef = useRef<number>(0);
  const logContainerRef = useRef<HTMLDivElement | null>(null);

  const {
    data: workflow,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['workflow', id],
    queryFn: () => fetchWorkflowById(id || ''),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (!status || status === 'queued' || status === 'running') {
        return 1500;
      }
      return false;
    },
  });

  // Reset logs when workflow ID changes
  useEffect(() => {
    setLogs([]);
    cursorRef.current = 0;
  }, [id]);

  // Poll incremental logs while running, plus one final fetch when terminal
  useEffect(() => {
    if (!id || !workflow) return;
    let active = true;

    const pullLogs = async () => {
      try {
        const res = await fetchWorkflowLogs(id, cursorRef.current, 200);
        if (!active) return;
        if (res.logs.length > 0) {
          setLogs((prev) => {
            const seen = new Set(prev.map((l) => l.id));
            const next = res.logs.filter((l) => !seen.has(l.id));
            return next.length > 0 ? [...prev, ...next] : prev;
          });
          if (res.nextCursor !== null) {
            cursorRef.current = res.nextCursor;
          }
        }
      } catch {
        // Ignore transient log polling errors
      }
    };

    void pullLogs();

    const isActive = workflow.status === 'queued' || workflow.status === 'running';
    if (!isActive) {
      return () => {
        active = false;
      };
    }

    const timer = setInterval(() => {
      void pullLogs();
    }, 1500);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [id, workflow?.status, workflow?.attempts]);

  // Auto-scroll log viewer
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs.length]);

  const retryMutation = useMutation({
    mutationFn: () => retryWorkflow(id || ''),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflow', id] });
      queryClient.invalidateQueries({ queryKey: ['workflows'] });
      if (workflow?.serviceId) {
        queryClient.invalidateQueries({ queryKey: ['service', workflow.serviceId] });
      }
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => cancelWorkflow(id || ''),
    onSuccess: () => {
      setIsCancelDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: ['workflow', id] });
      queryClient.invalidateQueries({ queryKey: ['workflows'] });
    },
  });

  const getStatusBadge = (status: WorkflowRunStatus) => {
    switch (status) {
      case 'succeeded':
        return (
          <Badge variant="healthy" className="gap-1">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Succeeded
          </Badge>
        );
      case 'failed':
        return (
          <Badge variant="failed" className="gap-1">
            <XCircle className="h-3.5 w-3.5" />
            Failed
          </Badge>
        );
      case 'running':
        return (
          <Badge variant="default" className="gap-1">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Running
          </Badge>
        );
      case 'cancelled':
        return (
          <Badge variant="unknown" className="gap-1">
            <Ban className="h-3.5 w-3.5" />
            Cancelled
          </Badge>
        );
      default:
        return (
          <Badge variant="degraded" className="gap-1">
            <Clock className="h-3.5 w-3.5" />
            Queued
          </Badge>
        );
    }
  };

  const getStepIcon = (status: WorkflowStepStatus) => {
    switch (status) {
      case 'succeeded':
        return <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0" />;
      case 'failed':
        return <XCircle className="h-5 w-5 text-rose-400 shrink-0" />;
      case 'running':
        return <Loader2 className="h-5 w-5 text-indigo-400 animate-spin shrink-0" />;
      case 'skipped':
        return <Ban className="h-5 w-5 text-slate-500 shrink-0" />;
      default:
        return <Clock className="h-5 w-5 text-slate-500 shrink-0" />;
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-5xl">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !workflow) {
    return (
      <div className="p-8 text-center text-rose-400 bg-rose-950/20 border border-rose-900 rounded-lg space-y-4 max-w-2xl">
        <AlertTriangle className="h-8 w-8 mx-auto" />
        <h2 className="text-lg font-semibold">Workflow Not Found</h2>
        <p className="text-sm text-slate-400">
          {(error as Error)?.message || 'The requested workflow run could not be loaded.'}
        </p>
        <Button variant="outline" onClick={() => navigate('/workflows')}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Back to Workflows
        </Button>
      </div>
    );
  }

  const resources = (workflow.resources || {}) as WorkflowResourcesShape;
  const canOperate = role !== 'viewer';
  const isActive = workflow.status === 'queued' || workflow.status === 'running';

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center space-x-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/workflows')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center space-x-3">
              <h1 className="text-2xl font-bold tracking-tight text-white">
                {workflow.serviceName}
              </h1>
              {getStatusBadge(workflow.status)}
            </div>
            <div className="flex items-center space-x-3 text-xs text-slate-400 mt-1">
              <span className="font-mono">{workflow.id}</span>
              <span>•</span>
              <span className="capitalize">{workflow.type} workflow</span>
              <span>•</span>
              <span>Attempt {workflow.attempts}</span>
              <span>•</span>
              <Link
                to={`/services/${workflow.serviceId}`}
                className="text-indigo-400 hover:text-indigo-300 hover:underline"
              >
                View Service
              </Link>
            </div>
          </div>
        </div>

        {canOperate && (
          <div className="flex items-center space-x-2">
            {isActive && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsCancelDialogOpen(true)}
                disabled={cancelMutation.isPending || workflow.cancelRequested}
              >
                <Ban className="h-4 w-4 mr-1.5" />
                {workflow.cancelRequested ? 'Cancelling...' : 'Cancel'}
              </Button>
            )}
            {workflow.status === 'failed' && (
              <Button
                size="sm"
                onClick={() => retryMutation.mutate()}
                disabled={retryMutation.isPending}
              >
                {retryMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                ) : (
                  <RotateCcw className="h-4 w-4 mr-1.5" />
                )}
                Retry Workflow
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Mutation error banner */}
      {(retryMutation.isError || cancelMutation.isError) && (
        <div className="p-3 bg-rose-500/15 border border-rose-500/30 rounded-md text-xs text-rose-300">
          {((retryMutation.error || cancelMutation.error) as Error).message}
        </div>
      )}

      {/* Cancelled State Alert */}
      {workflow.status === 'cancelled' && (
        <Card className="border-amber-500/40 bg-amber-950/20">
          <CardContent className="p-5 space-y-2">
            <div className="flex items-center space-x-2 text-sm font-semibold text-amber-200">
              <Ban className="h-5 w-5 text-amber-400 shrink-0" />
              <span>Workflow was cancelled</span>
            </div>
            <p className="text-xs text-amber-300/90">
              Completed steps:{' '}
              {workflow.steps
                .filter((s) => s.status === 'succeeded')
                .map((s) => s.key)
                .join(', ') || 'none'}
              . Any GitHub repository created before cancellation was NOT deleted.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Failed State Alert */}
      {workflow.status === 'failed' && (
        <Card className="border-rose-500/40 bg-rose-950/20">
          <CardContent className="p-5 flex flex-col sm:flex-row sm:items-start justify-between gap-4">
            <div className="flex items-start space-x-3">
              <XCircle className="h-5 w-5 text-rose-400 mt-0.5 shrink-0" />
              <div className="space-y-1">
                <div className="text-sm font-semibold text-rose-200">
                  Workflow failed
                  {workflow.failedStepKey ? (
                    <>
                      {' '}
                      at step{' '}
                      <span className="font-mono bg-rose-950/60 px-1.5 py-0.5 rounded border border-rose-500/30">
                        {workflow.failedStepKey}
                      </span>
                    </>
                  ) : null}
                </div>
                <p className="text-sm text-rose-300/90">
                  {workflow.errorSummary || 'An unexpected error occurred during execution.'}
                </p>
              </div>
            </div>
            {canOperate && (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => retryMutation.mutate()}
                disabled={retryMutation.isPending}
                className="shrink-0"
              >
                {retryMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                ) : (
                  <RotateCcw className="h-4 w-4 mr-1.5" />
                )}
                Retry
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Stepper */}
      <Card className="border-slate-800 bg-slate-900/60">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Execution Steps</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {workflow.steps.map((step) => (
            <div
              key={step.id}
              className={`p-3.5 rounded-lg border flex flex-col sm:flex-row sm:items-center justify-between gap-2 ${
                step.status === 'failed'
                  ? 'border-rose-500/40 bg-rose-950/15'
                  : step.status === 'running'
                    ? 'border-indigo-500/40 bg-indigo-950/15'
                    : step.status === 'succeeded'
                      ? 'border-emerald-500/20 bg-slate-950/40'
                      : 'border-slate-800 bg-slate-950/30'
              }`}
            >
              <div className="flex items-start space-x-3">
                {getStepIcon(step.status)}
                <div>
                  <div className="flex items-center space-x-2">
                    <span className="text-sm font-medium text-white">{step.name}</span>
                    <span className="text-xs font-mono text-slate-500">({step.key})</span>
                  </div>
                  {step.errorSummary && (
                    <p className="text-xs text-rose-300 mt-1">{step.errorSummary}</p>
                  )}
                </div>
              </div>

              <div className="flex items-center space-x-3 text-xs font-mono text-slate-400 pl-8 sm:pl-0">
                <span className="capitalize">{step.status}</span>
                {step.completedAt && step.startedAt && (
                  <span>
                    {(
                      (new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()) /
                      1000
                    ).toFixed(2)}
                    s
                  </span>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Deployment Details (for deploy workflows) */}
      {(resources.image || resources.url || resources.commitSha) && (
        <Card className="border-slate-800 bg-slate-900/60">
          <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Deployment Details</CardTitle>
            {workflow.status === 'succeeded' && isSafeApplicationUrl(resources.url) && (
              <div className="flex items-center space-x-3">
                <a
                  href={resources.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center space-x-1.5 text-xs font-medium text-indigo-400 hover:text-indigo-300 hover:underline"
                >
                  <span>Open application</span>
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
                {isSafeApplicationUrl(`${resources.url}/docs`) && (
                  <a
                    href={`${resources.url}/docs`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center space-x-1.5 text-xs font-medium text-slate-300 hover:text-indigo-300 hover:underline"
                  >
                    <span>API docs</span>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </div>
            )}
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-4 text-xs">
            <div>
              <span className="text-slate-400 uppercase font-semibold block mb-1">Environment</span>
              <span className="font-mono text-slate-200">
                {resources.environment || 'development'}
              </span>
            </div>
            <div>
              <span className="text-slate-400 uppercase font-semibold block mb-1">Commit</span>
              <span className="font-mono text-slate-200" title={resources.commitSha}>
                {resources.commitSha ? resources.commitSha.slice(0, 7) : '—'}
              </span>
            </div>
            <div>
              <span className="text-slate-400 uppercase font-semibold block mb-1">
                Helm Revision
              </span>
              <span className="font-mono text-slate-200">
                {resources.helmRevision !== undefined ? `rev ${resources.helmRevision}` : '—'}
              </span>
            </div>
            <div className="min-w-0">
              <span className="text-slate-400 uppercase font-semibold block mb-1">Image</span>
              <span className="font-mono text-slate-300 truncate block" title={resources.image}>
                {resources.image || '—'}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Provisioned Resources */}
      {(resources.template || resources.repository || resources.commit) && (
        <Card className="border-slate-800 bg-slate-900/60">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Provisioned Resources</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {resources.template && (
              <div className="p-3.5 rounded-lg border border-slate-800 bg-slate-950/50 space-y-1 min-w-0 overflow-hidden">
                <div className="flex items-center space-x-1.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  <FileCode2 className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
                  <span>Template</span>
                </div>
                <div className="text-sm font-mono text-white truncate">
                  {resources.template.slug}@{resources.template.version}
                </div>
                {resources.template.fileCount !== undefined && (
                  <div className="text-xs text-slate-400">
                    {resources.template.fileCount} rendered files
                  </div>
                )}
              </div>
            )}

            {isSafeHttpsUrl(resources.repository?.url) && (
              <div className="p-3.5 rounded-lg border border-slate-800 bg-slate-950/50 space-y-1 min-w-0 overflow-hidden">
                <div className="flex items-center space-x-1.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  <GitFork className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                  <span>Repository</span>
                </div>
                <a
                  href={resources.repository.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={resources.repository.url}
                  className="inline-flex items-center space-x-1.5 text-sm text-indigo-400 hover:text-indigo-300 hover:underline max-w-full"
                >
                  <span className="truncate">
                    {resources.repository.fullName || resources.repository.url}
                  </span>
                  <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                </a>
                <div className="text-xs text-slate-400">
                  {resources.repository.private ? 'Private' : 'Public'} •{' '}
                  {resources.repository.defaultBranch || 'main'}
                </div>
              </div>
            )}

            {resources.commit?.sha && (
              <div className="p-3.5 rounded-lg border border-slate-800 bg-slate-950/50 space-y-1 min-w-0 overflow-hidden">
                <div className="flex items-center space-x-1.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  <GitCommit className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
                  <span>Initial Commit</span>
                </div>
                <div className="flex items-center space-x-2 min-w-0">
                  {isSafeHttpsUrl(resources.commit.url) ? (
                    <a
                      href={resources.commit.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={resources.commit.sha}
                      className="inline-flex items-center space-x-1.5 text-sm font-mono text-indigo-400 hover:text-indigo-300 hover:underline"
                    >
                      <span>{resources.commit.sha.slice(0, 7)}</span>
                      <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                    </a>
                  ) : (
                    <span title={resources.commit.sha} className="text-sm font-mono text-slate-200">
                      {resources.commit.sha.slice(0, 7)}
                    </span>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    title="Copy full commit SHA"
                    onClick={() => {
                      navigator.clipboard?.writeText(resources.commit?.sha || '');
                      setCopiedSha(true);
                      setTimeout(() => setCopiedSha(false), 1500);
                    }}
                    className="h-6 px-2 text-xs text-slate-400 hover:text-white"
                  >
                    {copiedSha ? (
                      <>
                        <Check className="h-3 w-3 mr-1 text-emerald-400" />
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3 mr-1" />
                        <span>Copy</span>
                      </>
                    )}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Execution Logs */}
      <Card className="border-slate-800 bg-slate-900/60">
        <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
          <div className="flex items-center space-x-2">
            <Terminal className="h-4 w-4 text-slate-400" />
            <CardTitle className="text-base">Execution Logs</CardTitle>
          </div>
          <span className="text-xs font-mono text-slate-500">
            {logs.length} line{logs.length === 1 ? '' : 's'}
          </span>
        </CardHeader>
        <CardContent>
          <div
            ref={logContainerRef}
            className="bg-slate-950 border border-slate-800 rounded-lg p-4 font-mono text-xs space-y-1.5 max-h-80 overflow-y-auto"
          >
            {logs.length === 0 ? (
              <div className="text-slate-500">Waiting for workflow logs...</div>
            ) : (
              logs.map((entry) => (
                <div key={entry.id} className="flex items-start space-x-2 leading-relaxed">
                  <span className="text-slate-500 shrink-0">
                    {new Date(entry.createdAt).toLocaleTimeString()}
                  </span>
                  <span
                    className={`uppercase font-semibold shrink-0 w-12 ${
                      entry.level === 'error'
                        ? 'text-rose-400'
                        : entry.level === 'warn'
                          ? 'text-amber-400'
                          : 'text-emerald-400'
                    }`}
                  >
                    {entry.level}
                  </span>
                  {entry.stepKey && (
                    <span className="text-indigo-400 shrink-0">[{entry.stepKey}]</span>
                  )}
                  <span className="text-slate-200 break-words">{entry.message}</span>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      {/* Cancel Confirmation Dialog */}
      <Dialog open={isCancelDialogOpen} onOpenChange={setIsCancelDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel Workflow?</DialogTitle>
            <DialogDescription>
              Are you sure you want to cancel this workflow run for{' '}
              <span className="font-semibold text-white">{workflow.serviceName}</span>? Any step
              already in progress will stop before the next step begins.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsCancelDialogOpen(false)}
              disabled={cancelMutation.isPending}
            >
              Keep Running
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => cancelMutation.mutate()}
              disabled={cancelMutation.isPending}
            >
              {cancelMutation.isPending ? 'Cancelling...' : 'Confirm Cancel'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <p className="text-xs text-slate-500 text-center">
        GitOps, approvals, and observability arrive in Phase 4.
      </p>
    </div>
  );
}
