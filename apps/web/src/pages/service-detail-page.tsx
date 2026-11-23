import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
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
} from 'lucide-react';
import { useAppAuth } from '../context/auth-context';
import { fetchServiceById, updateService, deleteService } from '../lib/api-client';
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
import { Skeleton } from '../components/ui/skeleton';

export function ServiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { token, user, role } = useAppAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  const {
    data: service,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['service', id, token],
    queryFn: () => fetchServiceById(token || '', id || ''),
    enabled: Boolean(token && id),
  });

  // Check edit & delete authorization
  const isOwner = Boolean(user?.id && service?.ownerId && user.id === service.ownerId);
  const canModify = role === 'admin' || (role === 'developer' && isOwner);

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
      updateService(token || '', id || '', {
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
    mutationFn: () => deleteService(token || '', id || ''),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['services'] });
      queryClient.invalidateQueries({ queryKey: ['dashboardSummary'] });
      navigate('/services');
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
              onClick={() => setIsDeleteDialogOpen(true)}
              className="space-x-1.5 focus-visible:ring-2 focus-visible:ring-rose-500"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>Delete</span>
            </Button>
          </div>
        )}
      </div>

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
                    <span>{service.templateName || 'Custom / None'}</span>
                  </div>
                </div>

                <div>
                  <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-1">
                    Repository
                  </span>
                  {service.repositoryUrl ? (
                    <a
                      href={service.repositoryUrl}
                      target="_blank"
                      rel="noreferrer"
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

        {/* Tab 2: Deployments (Empty State - Phase 3) */}
        <TabsContent value="deployments">
          <Card className="border-slate-800 bg-slate-900/40 p-8 text-center">
            <Rocket className="h-8 w-8 text-indigo-400 mx-auto mb-3" />
            <h3 className="text-base font-semibold text-white">Deployments</h3>
            <p className="text-xs text-slate-400 max-w-md mx-auto mt-1 mb-3">
              Multi-environment Kubernetes deployment tracking, rollout history, and canary
              releases.
            </p>
            <Badge variant="outline" className="text-indigo-400 border-indigo-500/30">
              <Clock className="h-3 w-3 mr-1 inline" /> Available in Phase 3
            </Badge>
          </Card>
        </TabsContent>

        {/* Tab 3: Pipelines (Empty State - Phase 2) */}
        <TabsContent value="pipelines">
          <Card className="border-slate-800 bg-slate-900/40 p-8 text-center">
            <GitFork className="h-8 w-8 text-blue-400 mx-auto mb-3" />
            <h3 className="text-base font-semibold text-white">Pipelines</h3>
            <p className="text-xs text-slate-400 max-w-md mx-auto mt-1 mb-3">
              Automated GitHub Actions CI/CD workflows, build artifacts, and test execution results.
            </p>
            <Badge variant="outline" className="text-blue-400 border-blue-500/30">
              <Clock className="h-3 w-3 mr-1 inline" /> Available in Phase 2
            </Badge>
          </Card>
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
