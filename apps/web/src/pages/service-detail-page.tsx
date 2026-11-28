import React, { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  updateServiceSchema,
  type UpdateServiceInput,
  type EnvironmentStatus,
} from '@forgeflow/shared-types';
import {
  ArrowLeft,
  ExternalLink,
  Edit,
  Trash2,
  Calendar,
  User,
  Layers,
  AlertCircle,
  Clock,
  Rocket,
  GitFork,
  Terminal,
  Sliders,
  BookOpen,
  RotateCcw,
  RefreshCw,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { useAppAuth } from '../context/auth-context';
import {
  createDeployment,
  deleteService,
  fetchDeployableCommits,
  fetchServiceById,
  fetchServiceCiRuns,
  fetchServiceDeployments,
  rollbackDeployment,
  syncServiceCiRuns,
  undeployService,
  updateService,
} from '../lib/api-client';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card, CardContent } from '../components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../components/ui/dialog';
import { Input, Textarea } from '../components/ui/input';
import { Select } from '../components/ui/select';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '../components/ui/table';
import { Skeleton } from '../components/ui/skeleton';
import { isSafeHttpsUrl, isSafeApplicationUrl } from '../lib/utils';
import type { DeploymentItem } from '@forgeflow/shared-types';

export function ServiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user, role } = useAppAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeployDialogOpen, setIsDeployDialogOpen] = useState(false);
  const [isUndeployDialogOpen, setIsUndeployDialogOpen] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<DeploymentItem | null>(null);
  const [selectedCommitSha, setSelectedCommitSha] = useState('');
  const [deployActionError, setDeployActionError] = useState<string | null>(null);
  const [deployNoopNotice, setDeployNoopNotice] = useState<string | null>(null);

  const {
    data: service,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['service', id],
    queryFn: () => fetchServiceById(id || ''),
    enabled: Boolean(id),
    refetchInterval: 10000,
  });

  const { data: deployments } = useQuery({
    queryKey: ['serviceDeployments', id],
    queryFn: () => fetchServiceDeployments(id || ''),
    enabled: Boolean(id),
    refetchInterval: 5000,
  });

  const { data: deployableCommits, isLoading: loadingDeployable } = useQuery({
    queryKey: ['deployableCommits', id],
    queryFn: () => fetchDeployableCommits(id || ''),
    enabled: Boolean(id) && isDeployDialogOpen,
  });

  const { data: ciRuns } = useQuery({
    queryKey: ['serviceCiRuns', id],
    queryFn: () => fetchServiceCiRuns(id || ''),
    enabled: Boolean(id),
    refetchInterval: 15000,
  });

  // Check edit & delete authorization
  const isOwner = Boolean(user?.id && service?.ownerId && user.id === service.ownerId);
  const canModify = role === 'admin' || (role === 'developer' && isOwner);
  const devEnv = service?.environments?.find((e) => e.name === 'development');
  const isDeployed = Boolean(devEnv?.deployedImage || devEnv?.deployedCommitSha);
  const hasActiveWorkflow = Boolean(
    service?.provisioningStatus === 'provisioning' ||
    service?.workflowRuns?.some((r) => r.status === 'queued' || r.status === 'running')
  );

  // Edit form handling
  const {
    register: registerEdit,
    handleSubmit: handleEditSubmit,
    reset: resetEdit,
    formState: { errors: editErrors },
  } = useForm<UpdateServiceInput>({
    resolver: zodResolver(updateServiceSchema),
    values: {
      name: service?.name,
      description: service?.description || '',
      repositoryUrl: service?.repositoryUrl || '',
    },
  });

  // Edit mutation
  const editMutation = useMutation({
    mutationFn: (data: UpdateServiceInput) =>
      updateService(id || '', {
        ...data,
        repositoryUrl: data.repositoryUrl === '' ? null : data.repositoryUrl,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['service', id] });
      queryClient.invalidateQueries({ queryKey: ['services'] });
      setIsEditDialogOpen(false);
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: () => deleteService(id || ''),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['services'] });
      queryClient.invalidateQueries({ queryKey: ['dashboardSummary'] });
      navigate('/services');
    },
  });

  const syncCiMutation = useMutation({
    mutationFn: () => syncServiceCiRuns(id || ''),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['serviceCiRuns', id] });
      queryClient.invalidateQueries({ queryKey: ['deployableCommits', id] });
    },
  });

  const deployMutation = useMutation({
    mutationFn: (commitSha?: string) =>
      createDeployment(id || '', {
        environment: 'development',
        ...(commitSha ? { commitSha } : {}),
      }),
    onSuccess: (res) => {
      setDeployActionError(null);
      setIsDeployDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: ['serviceDeployments', id] });
      queryClient.invalidateQueries({ queryKey: ['service', id] });
      if (res.noop) {
        setDeployNoopNotice('No change: selected commit is already deployed and healthy.');
        return;
      }
      setDeployNoopNotice(null);
      if (res.workflowId) {
        navigate(`/workflows/${res.workflowId}`);
      }
    },
    onError: (err: Error & { status?: number }) => {
      if (err.status === 409) {
        setDeployActionError(
          `Deployment conflict (409): ${err.message || 'Another deploy or undeploy workflow is already active for this service.'}`
        );
      } else if (err.status === 429) {
        setDeployActionError(
          `Rate limited (429): ${err.message || 'Too many deployment requests. Please wait and try again.'}`
        );
      } else if (err.status === 503) {
        setDeployActionError(
          `Service unavailable (503): ${err.message || 'Cluster or deployment runner is temporarily unavailable.'}`
        );
      } else {
        setDeployActionError(err.message);
      }
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: (deploymentId: string) => rollbackDeployment(deploymentId),
    onSuccess: (res) => {
      setDeployActionError(null);
      queryClient.invalidateQueries({ queryKey: ['serviceDeployments', id] });
      navigate(`/workflows/${res.workflowId}`);
    },
    onError: (err: Error & { status?: number }) => {
      if (err.status === 409) {
        setDeployActionError(
          `Deployment conflict (409): ${err.message || 'Another deploy or undeploy workflow is already active for this service.'}`
        );
      } else if (err.status === 429) {
        setDeployActionError(
          `Rate limited (429): ${err.message || 'Too many deployment requests. Please wait and try again.'}`
        );
      } else if (err.status === 503) {
        setDeployActionError(
          `Service unavailable (503): ${err.message || 'Cluster or deployment runner is temporarily unavailable.'}`
        );
      } else {
        setDeployActionError(err.message);
      }
    },
  });

  const undeployMutation = useMutation({
    mutationFn: () => undeployService(id || ''),
    onSuccess: (res) => {
      setDeployActionError(null);
      setIsUndeployDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: ['serviceDeployments', id] });
      queryClient.invalidateQueries({ queryKey: ['service', id] });
      navigate(`/workflows/${res.workflowId}`);
    },
    onError: (err: Error & { status?: number }) => {
      if (err.status === 409) {
        setDeployActionError(
          `Deployment conflict (409): ${err.message || 'Another deploy or undeploy workflow is already active for this service.'}`
        );
      } else if (err.status === 429) {
        setDeployActionError(
          `Rate limited (429): ${err.message || 'Too many deployment requests. Please wait and try again.'}`
        );
      } else if (err.status === 503) {
        setDeployActionError(
          `Service unavailable (503): ${err.message || 'Cluster or deployment runner is temporarily unavailable.'}`
        );
      } else {
        setDeployActionError(err.message);
      }
    },
  });

  const getHealthBadge = (health: EnvironmentStatus) => {
    switch (health) {
      case 'healthy':
        return <Badge variant="healthy">Healthy</Badge>;
      case 'degraded':
        return <Badge variant="degraded">Degraded</Badge>;
      case 'failed':
        return <Badge variant="failed">Failed</Badge>;
      default:
        return <Badge variant="unknown">Unknown</Badge>;
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !service) {
    return (
      <div className="p-8 text-center text-rose-400 bg-rose-950/20 border border-rose-900 rounded-lg space-y-4">
        <AlertCircle className="h-8 w-8 mx-auto" />
        <h2 className="text-lg font-semibold">Service Not Found</h2>
        <p className="text-sm text-slate-400">
          The requested service could not be located or you do not have permission to view it.
        </p>
        <Button variant="outline" onClick={() => navigate('/services')}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Back to Catalog
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Top Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center space-x-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate('/services')}
            className="focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center space-x-3">
              <h1 className="text-2xl font-bold tracking-tight text-white">{service.name}</h1>
              {getHealthBadge(service.health)}
              <Badge
                variant={
                  service.provisioningStatus === 'ready'
                    ? 'healthy'
                    : service.provisioningStatus === 'failed'
                      ? 'failed'
                      : 'degraded'
                }
                className="capitalize"
              >
                {service.provisioningStatus}
              </Badge>
            </div>
            <p className="text-xs text-slate-500 font-mono mt-0.5">{service.slug}</p>
          </div>
        </div>

        {/* Action Buttons (Visible only if owner or admin) */}
        {canModify && (
          <div className="flex items-center space-x-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                resetEdit({
                  name: service.name,
                  description: service.description || '',
                  repositoryUrl: service.repositoryUrl || '',
                });
                setIsEditDialogOpen(true);
              }}
              className="space-x-1.5 focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              <Edit className="h-3.5 w-3.5" />
              <span>Edit</span>
            </Button>

            <Button
              variant="destructive"
              size="sm"
              disabled={hasActiveWorkflow || isDeployed}
              title={
                isDeployed
                  ? 'Undeploy service before deleting'
                  : hasActiveWorkflow
                    ? 'Cannot delete while a workflow is running'
                    : 'Delete service'
              }
              onClick={() => setIsDeleteDialogOpen(true)}
              className="space-x-1.5 focus-visible:ring-2 focus-visible:ring-rose-500"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>Delete</span>
            </Button>
          </div>
        )}
      </div>

      {/* Provisioning Status Banner */}
      {(service.provisioningStatus === 'provisioning' || service.provisioningStatus === 'failed') &&
        service.latestWorkflowId && (
          <div
            className={`p-4 rounded-lg border flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
              service.provisioningStatus === 'failed'
                ? 'border-rose-500/40 bg-rose-950/20 text-rose-200'
                : 'border-amber-500/40 bg-amber-950/20 text-amber-200'
            }`}
          >
            <div className="flex items-center space-x-2.5 text-sm">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>
                {service.provisioningStatus === 'failed'
                  ? 'Service provisioning failed. Inspect the workflow logs or retry provisioning.'
                  : 'Service provisioning is currently in progress.'}
              </span>
            </div>
            <Link
              to={`/workflows/${service.latestWorkflowId}`}
              className="text-sm font-medium underline underline-offset-2 shrink-0 hover:opacity-80"
            >
              View Latest Workflow &rarr;
            </Link>
          </div>
        )}

      {/* Tabs: Overview, Deployments, Pipelines, Logs, Configuration, Documentation */}
      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList className="flex flex-wrap h-auto gap-1 p-1">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="deployments">Deployments</TabsTrigger>
          <TabsTrigger value="pipelines">Pipelines</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="configuration">Configuration</TabsTrigger>
          <TabsTrigger value="documentation">Documentation</TabsTrigger>
        </TabsList>

        {/* Tab 1: Overview (Real Data) */}
        <TabsContent value="overview">
          <Card className="border-slate-800 bg-slate-900/60">
            <CardContent className="p-6">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                <div>
                  <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-1">
                    Owner
                  </span>
                  <div className="flex items-center space-x-2 text-slate-200 text-sm">
                    <User className="h-4 w-4 text-slate-400" />
                    <span>{service.ownerName || 'Unassigned'}</span>
                  </div>
                </div>

                <div>
                  <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-1">
                    Template
                  </span>
                  <div className="flex items-center space-x-2 text-slate-200 text-sm">
                    <Layers className="h-4 w-4 text-indigo-400" />
                    <span>
                      {service.templateName || 'Custom / None'}
                      {service.templateVersion ? ` (v${service.templateVersion})` : ''}
                    </span>
                  </div>
                </div>

                <div>
                  <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-1">
                    Repository
                  </span>
                  {isSafeHttpsUrl(service.repositoryUrl) ? (
                    <a
                      href={service.repositoryUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center space-x-1.5 text-sm text-indigo-400 hover:text-indigo-300 hover:underline truncate max-w-full"
                    >
                      <span className="truncate">
                        {service.repositoryUrl.replace(/^https?:\/\//, '')}
                      </span>
                      <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                    </a>
                  ) : (
                    <span className="text-sm text-slate-500">Not configured</span>
                  )}
                </div>

                <div>
                  <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-1">
                    Created
                  </span>
                  <div className="flex items-center space-x-2 text-slate-400 text-sm font-mono">
                    <Calendar className="h-4 w-4 text-slate-500" />
                    <span>{new Date(service.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>
              </div>

              {service.latestWorkflowId && (
                <div className="mt-6 pt-6 border-t border-slate-800 flex items-center justify-between">
                  <div>
                    <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-1">
                      Latest Provisioning Workflow
                    </span>
                    <span className="text-xs font-mono text-slate-400">
                      {service.latestWorkflowId}
                    </span>
                  </div>
                  <Link
                    to={`/workflows/${service.latestWorkflowId}`}
                    className="text-sm text-indigo-400 hover:text-indigo-300 hover:underline font-medium"
                  >
                    View Workflow Progress &rarr;
                  </Link>
                </div>
              )}

              {service.description && (
                <div className="mt-6 pt-6 border-t border-slate-800">
                  <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-1.5">
                    Description
                  </span>
                  <p className="text-sm text-slate-300 leading-relaxed">{service.description}</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab 2: Deployments */}
        <TabsContent value="deployments" className="space-y-4">
          {deployActionError && (
            <div className="p-3 bg-rose-500/15 border border-rose-500/30 rounded-lg text-xs text-rose-300 flex items-center space-x-2">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{deployActionError}</span>
            </div>
          )}

          {/* Development Environment Card */}
          <Card className="border-slate-800 bg-slate-900/60">
            <CardContent className="p-6 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <div className="flex items-center space-x-3">
                    <h3 className="text-base font-semibold text-white">Development Environment</h3>
                    {getHealthBadge(devEnv?.status ?? 'unknown')}
                  </div>
                  <p className="text-xs text-slate-400 font-mono mt-1">
                    {devEnv?.cluster ?? 'kind-forgeflow'} / {devEnv?.namespace ?? 'forgeflow-dev'}
                  </p>
                </div>

                {canModify && service.provisioningStatus === 'ready' && (
                  <div className="flex items-center space-x-2">
                    <Button
                      size="sm"
                      onClick={() => {
                        setDeployActionError(null);
                        setSelectedCommitSha('');
                        setIsDeployDialogOpen(true);
                      }}
                      className="space-x-1.5"
                    >
                      <Rocket className="h-3.5 w-3.5" />
                      <span>Deploy</span>
                    </Button>
                    {isDeployed && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setIsUndeployDialogOpen(true)}
                        className="text-rose-300 border-rose-500/30 hover:bg-rose-950/30"
                      >
                        Undeploy
                      </Button>
                    )}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 pt-3 border-t border-slate-800 text-xs">
                <div>
                  <span className="text-slate-400 uppercase font-semibold block mb-1">
                    Deployed Commit
                  </span>
                  <span className="font-mono text-slate-200">
                    {devEnv?.deployedCommitSha
                      ? devEnv.deployedCommitSha.slice(0, 7)
                      : 'Not deployed'}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 uppercase font-semibold block mb-1">
                    Endpoint
                  </span>
                  {isSafeApplicationUrl(devEnv?.url) ? (
                    <div className="flex flex-wrap items-center gap-3">
                      <a
                        href={
                          isSafeApplicationUrl(`${devEnv.url}/docs`)
                            ? `${devEnv.url}/docs`
                            : devEnv.url
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-indigo-400 hover:underline font-mono inline-flex items-center space-x-1"
                      >
                        <span>Open application</span>
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  ) : (
                    <span className="text-slate-500">—</span>
                  )}
                </div>
                <div>
                  <span className="text-slate-400 uppercase font-semibold block mb-1">
                    Replicas
                  </span>
                  <span className="font-mono text-slate-200">
                    {devEnv?.observedReadyReplicas ?? 0} / {devEnv?.observedReplicas ?? 0} ready
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 uppercase font-semibold block mb-1">
                    Last Observed
                  </span>
                  <span className="font-mono text-slate-400">
                    {devEnv?.lastObservedAt
                      ? new Date(devEnv.lastObservedAt).toLocaleTimeString()
                      : 'Never'}
                  </span>
                </div>
              </div>

              {deployNoopNotice && (
                <div className="p-2.5 rounded bg-emerald-950/30 border border-emerald-500/30 text-xs text-emerald-300">
                  {deployNoopNotice}
                </div>
              )}

              {devEnv?.lastObservedError && (
                <div className="p-2.5 rounded bg-rose-950/30 border border-rose-500/30 text-xs text-rose-300 font-mono break-all">
                  {devEnv.lastObservedError}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Deployment History Table */}
          <Card className="border-slate-800 bg-slate-900/60 overflow-hidden">
            <CardContent className="p-0">
              {!deployments || deployments.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-400">
                  No deployments recorded for this service yet. Click <strong>Deploy</strong> above
                  to deploy a verified image.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Commit</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Revision</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead>Workflow</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {deployments.map((dep) => {
                      const isRunningCommit = Boolean(
                        devEnv?.deployedImage && devEnv?.deployedCommitSha === dep.commitSha
                      );
                      const canRollback =
                        canModify &&
                        !isRunningCommit &&
                        (dep.status === 'succeeded' || dep.status === 'rolled_back');
                      return (
                        <TableRow key={dep.id}>
                          <TableCell className="font-mono text-xs text-slate-200">
                            <span title={dep.commitSha}>{dep.commitSha.slice(0, 7)}</span>
                            {dep.rollbackOf && (
                              <span className="ml-2 text-[11px] text-amber-300">(rollback)</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                dep.status === 'succeeded'
                                  ? 'healthy'
                                  : dep.status === 'failed'
                                    ? 'failed'
                                    : dep.status === 'rolled_back'
                                      ? 'outline'
                                      : 'degraded'
                              }
                              className="capitalize text-xs"
                            >
                              {dep.status.replace('_', ' ')}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-slate-400">
                            {dep.helmRevision !== null ? `rev ${dep.helmRevision}` : '—'}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-slate-400">
                            {new Date(dep.createdAt).toLocaleString()}
                          </TableCell>
                          <TableCell>
                            {dep.workflowRunId ? (
                              <Link
                                to={`/workflows/${dep.workflowRunId}`}
                                className="text-xs font-mono text-indigo-400 hover:underline"
                              >
                                {dep.workflowRunId.slice(0, 8)}
                              </Link>
                            ) : (
                              '—'
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
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab 3: Pipelines (CI Runs & ForgeFlow Workflows) */}
        <TabsContent value="pipelines" className="space-y-4">
          <Card className="border-slate-800 bg-slate-900/60">
            <CardContent className="p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-white">GitHub Actions CI Runs</h3>
                  <p className="text-xs text-slate-400">
                    Synced from main branch workflows and webhooks.
                  </p>
                </div>
                {canModify && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={syncCiMutation.isPending}
                    onClick={() => syncCiMutation.mutate()}
                    className="space-x-1.5"
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${syncCiMutation.isPending ? 'animate-spin' : ''}`}
                    />
                    <span>{syncCiMutation.isPending ? 'Syncing...' : 'Sync CI'}</span>
                  </Button>
                )}
              </div>

              {!ciRuns || ciRuns.length === 0 ? (
                <p className="text-xs text-slate-500">No CI runs synced yet.</p>
              ) : (
                <div className="space-y-2.5">
                  {ciRuns.map((run) => (
                    <div
                      key={run.id}
                      className="p-3.5 rounded-lg border border-slate-800 bg-slate-950/50 space-y-2"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-2.5">
                          {run.conclusion === 'success' ? (
                            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                          ) : run.conclusion === 'failure' || run.conclusion === 'timed_out' ? (
                            <XCircle className="h-4 w-4 text-rose-400" />
                          ) : (
                            <Clock className="h-4 w-4 text-amber-400" />
                          )}
                          <span className="font-mono text-xs text-white">
                            {run.headSha.slice(0, 7)}
                          </span>
                          <Badge variant="outline" className="text-[11px]">
                            {run.headBranch ?? 'main'}
                          </Badge>
                          <Badge
                            variant={
                              run.conclusion === 'success'
                                ? 'healthy'
                                : run.conclusion === 'failure'
                                  ? 'failed'
                                  : 'degraded'
                            }
                            className="capitalize text-[11px]"
                          >
                            {run.conclusion ?? run.status}
                          </Badge>
                          {run.publishSucceeded && (
                            <Badge variant="healthy" className="text-[11px]">
                              Image Published
                            </Badge>
                          )}
                        </div>
                        {isSafeHttpsUrl(run.htmlUrl) && (
                          <a
                            href={run.htmlUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-indigo-400 hover:underline inline-flex items-center space-x-1"
                          >
                            <span>GitHub</span>
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                      {run.jobs.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {run.jobs.map((job) => (
                            <Badge
                              key={job.id}
                              variant={
                                job.conclusion === 'success'
                                  ? 'healthy'
                                  : job.conclusion === 'failure'
                                    ? 'failed'
                                    : 'unknown'
                              }
                              className="text-[10px]"
                            >
                              {job.name}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {service.workflowRuns && service.workflowRuns.length > 0 ? (
            <Card className="border-slate-800 bg-slate-900/60">
              <CardContent className="p-4 space-y-3">
                <h3 className="text-sm font-semibold text-white">Platform Workflows</h3>
                {service.workflowRuns.map((run) => (
                  <div
                    key={run.id}
                    onClick={() => navigate(`/workflows/${run.id}`)}
                    className="p-3.5 rounded-lg border border-slate-800 bg-slate-950/50 hover:border-slate-700 cursor-pointer flex items-center justify-between"
                  >
                    <div>
                      <div className="flex items-center space-x-2">
                        <span className="text-sm font-medium text-white capitalize">
                          {run.type} workflow
                        </span>
                        <Badge
                          variant={
                            run.status === 'succeeded'
                              ? 'healthy'
                              : run.status === 'failed'
                                ? 'failed'
                                : 'degraded'
                          }
                          className="capitalize text-xs"
                        >
                          {run.status}
                        </Badge>
                      </div>
                      <div className="text-xs font-mono text-slate-500 mt-1">{run.id}</div>
                    </div>
                    <span className="text-xs text-indigo-400 font-medium">View &rarr;</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : (
            <Card className="border-slate-800 bg-slate-900/40 p-8 text-center">
              <GitFork className="h-8 w-8 text-blue-400 mx-auto mb-3" />
              <h3 className="text-base font-semibold text-white">Platform Workflows</h3>
              <p className="text-xs text-slate-400 max-w-md mx-auto mt-1">
                No workflow runs have been recorded for this service yet.
              </p>
            </Card>
          )}
        </TabsContent>

        {/* Tab 4: Logs (Empty State - Phase 4) */}
        <TabsContent value="logs">
          <Card className="border-slate-800 bg-slate-900/40 p-8 text-center">
            <Terminal className="h-8 w-8 text-purple-400 mx-auto mb-3" />
            <h3 className="text-base font-semibold text-white">Service Logs</h3>
            <p className="text-xs text-slate-400 max-w-md mx-auto mt-1 mb-3">
              Live container stdout/stderr log streaming and aggregation across clusters.
            </p>
            <Badge variant="outline" className="text-purple-400 border-purple-500/30">
              <Clock className="h-3 w-3 mr-1 inline" /> Available in Phase 4
            </Badge>
          </Card>
        </TabsContent>

        {/* Tab 5: Configuration (Empty State - Phase 2) */}
        <TabsContent value="configuration">
          <Card className="border-slate-800 bg-slate-900/40 p-8 text-center">
            <Sliders className="h-8 w-8 text-amber-400 mx-auto mb-3" />
            <h3 className="text-base font-semibold text-white">Configuration & Secrets</h3>
            <p className="text-xs text-slate-400 max-w-md mx-auto mt-1 mb-3">
              Environment variables, secret injection, and per-environment ConfigMap management.
            </p>
            <Badge variant="outline" className="text-amber-400 border-amber-500/30">
              <Clock className="h-3 w-3 mr-1 inline" /> Available in Phase 2
            </Badge>
          </Card>
        </TabsContent>

        {/* Tab 6: Documentation (Empty State - Phase 4) */}
        <TabsContent value="documentation">
          <Card className="border-slate-800 bg-slate-900/40 p-8 text-center">
            <BookOpen className="h-8 w-8 text-emerald-400 mx-auto mb-3" />
            <h3 className="text-base font-semibold text-white">API Documentation</h3>
            <p className="text-xs text-slate-400 max-w-md mx-auto mt-1 mb-3">
              Interactive OpenAPI / Swagger documentation, service architecture diagrams, and
              runbooks.
            </p>
            <Badge variant="outline" className="text-emerald-400 border-emerald-500/30">
              <Clock className="h-3 w-3 mr-1 inline" /> Available in Phase 4
            </Badge>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Edit Service Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent>
          <form
            onSubmit={handleEditSubmit((data) => editMutation.mutate(data))}
            className="space-y-4"
          >
            <DialogHeader>
              <DialogTitle>Edit Service</DialogTitle>
              <DialogDescription>
                Update service description and Git repository URL.
              </DialogDescription>
            </DialogHeader>

            {editMutation.isError && (
              <div className="p-3 bg-rose-500/15 border border-rose-500/30 rounded text-xs text-rose-300">
                {(editMutation.error as Error).message}
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-300 uppercase">Description</label>
              <Textarea rows={3} {...registerEdit('description')} />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-300 uppercase">
                Repository URL
              </label>
              <Input
                placeholder="https://github.com/org/repo (or leave empty to clear)"
                {...registerEdit('repositoryUrl')}
              />
              {editErrors.repositoryUrl && (
                <p className="text-xs text-rose-400">{editErrors.repositoryUrl.message}</p>
              )}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsEditDialogOpen(false)}
                disabled={editMutation.isPending}
                className="focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={editMutation.isPending}
                className="focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                {editMutation.isPending ? 'Saving...' : 'Save Changes'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Deploy Dialog */}
      <Dialog open={isDeployDialogOpen} onOpenChange={setIsDeployDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deploy {service.name}</DialogTitle>
            <DialogDescription>
              Select a verified commit with a published GHCR image to deploy to{' '}
              <span className="font-mono text-slate-200">development</span>.
            </DialogDescription>
          </DialogHeader>

          {deployActionError && (
            <div className="p-3 bg-rose-500/15 border border-rose-500/30 rounded text-xs text-rose-300">
              {deployActionError}
            </div>
          )}

          {service.templateVersion === '1.0.0' ? (
            <div className="p-3 rounded bg-amber-950/30 border border-amber-500/30 text-xs text-amber-200">
              Template version <span className="font-mono">1.0.0</span> does not include container
              image publishing. Scaffold a service with template{' '}
              <span className="font-mono">1.1.0+</span> to deploy to Kubernetes.
            </div>
          ) : loadingDeployable ? (
            <Skeleton className="h-10 w-full" />
          ) : !deployableCommits || deployableCommits.length === 0 ? (
            ciRuns?.some((r) => r.status === 'queued' || r.status === 'in_progress') ? (
              <div className="p-3 rounded bg-indigo-950/30 border border-indigo-500/30 text-xs text-indigo-200">
                GitHub Actions CI is still running. Wait for the{' '}
                <span className="font-mono">Publish Image</span> job to finish on{' '}
                <span className="font-mono">main</span>, then sync CI.
              </div>
            ) : (
              <div className="p-3 rounded bg-amber-950/30 border border-amber-500/30 text-xs text-amber-200">
                No successful published commit yet. Wait for GitHub Actions CI and the{' '}
                <span className="font-mono">Publish Image</span> job to succeed on{' '}
                <span className="font-mono">main</span>, then sync CI.
              </div>
            )
          ) : (
            <div className="space-y-2">
              <label className="text-xs font-semibold text-slate-300 uppercase">
                Deployable Commit
              </label>
              <Select
                aria-label="Deployable Commit"
                value={selectedCommitSha || deployableCommits[0].commitSha}
                onChange={(e) => setSelectedCommitSha(e.target.value)}
              >
                {deployableCommits.map((c) => (
                  <option key={c.commitSha} value={c.commitSha}>
                    {c.shortSha} — {new Date(c.completedAt).toLocaleString()}
                  </option>
                ))}
              </Select>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsDeployDialogOpen(false)}
              disabled={deployMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={
                service.templateVersion === '1.0.0' ||
                deployMutation.isPending ||
                loadingDeployable ||
                !deployableCommits ||
                deployableCommits.length === 0
              }
              onClick={() =>
                deployMutation.mutate(
                  selectedCommitSha || deployableCommits?.[0]?.commitSha || undefined
                )
              }
            >
              {deployMutation.isPending ? 'Deploying...' : 'Start Deploy'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rollback Confirmation Dialog */}
      <Dialog
        open={Boolean(rollbackTarget)}
        onOpenChange={(open) => !open && setRollbackTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Rollback</DialogTitle>
            <DialogDescription>
              Roll back <span className="font-semibold text-white">{service.name}</span> in{' '}
              <span className="font-mono text-slate-200">development</span> to commit{' '}
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

      {/* Undeploy Confirmation Dialog */}
      <Dialog open={isUndeployDialogOpen} onOpenChange={setIsUndeployDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-rose-400">Undeploy {service.name}</DialogTitle>
            <DialogDescription>
              This will uninstall the Helm release and remove Kubernetes deployments, secrets, and
              database PVC from <span className="font-mono text-slate-200">forgeflow-dev</span>.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsUndeployDialogOpen(false)}
              disabled={undeployMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => undeployMutation.mutate()}
              disabled={undeployMutation.isPending}
            >
              {undeployMutation.isPending ? 'Undeploying...' : 'Confirm Undeploy'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-rose-400">Delete Service</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete{' '}
              <span className="font-semibold text-white">{service.name}</span>? This will remove the
              service, attached environments, workflow runs, and records from the platform catalog.
              This action cannot be undone.
              {service.repositoryUrl && (
                <span className="block mt-2 text-amber-300 font-medium">
                  The GitHub repository will not be deleted.
                </span>
              )}
            </DialogDescription>
          </DialogHeader>

          {deleteMutation.isError && (
            <div className="p-3 bg-rose-500/15 border border-rose-500/30 rounded text-xs text-rose-300">
              {(deleteMutation.error as Error).message}
            </div>
          )}

          <DialogFooter className="pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsDeleteDialogOpen(false)}
              disabled={deleteMutation.isPending}
              className="focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              className="focus-visible:ring-2 focus-visible:ring-rose-500"
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Confirm Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
