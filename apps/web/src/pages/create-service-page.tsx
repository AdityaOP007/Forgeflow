import React, { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createServiceSchema,
  generateSlug,
  type CreateServiceInput,
} from '@forgeflow/shared-types';
import { ShieldAlert, ArrowLeft, Loader2, Sparkles } from 'lucide-react';
import { useAppAuth } from '../context/auth-context';
import { createService, fetchTemplates } from '../lib/api-client';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input, Textarea } from '../components/ui/input';
import { Select } from '../components/ui/select';

export function CreateServicePage() {
  const { role } = useAppAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const preselectedTemplateId = searchParams.get('templateId') || undefined;

  // Role Guard: Viewer is blocked with a 403 screen
  if (role === 'viewer') {
    return (
      <div className="max-w-md mx-auto my-12 text-center p-8 bg-slate-900 border border-slate-800 rounded-xl space-y-4">
        <div className="h-12 w-12 rounded-full bg-rose-500/20 text-rose-400 mx-auto flex items-center justify-center">
          <ShieldAlert className="h-6 w-6" />
        </div>
        <h2 className="text-xl font-bold text-white">403 Forbidden</h2>
        <p className="text-sm text-slate-400">
          Your current role is <span className="font-semibold text-slate-200">Viewer</span>. Only
          Developers and Platform Admins can register and provision services.
        </p>
        <Button variant="outline" onClick={() => navigate('/services')} className="mt-4">
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Service Catalog
        </Button>
      </div>
    );
  }

  // Fetch templates for dropdown
  const { data: templates, isLoading: loadingTemplates } = useQuery({
    queryKey: ['templates'],
    queryFn: () => fetchTemplates(),
  });

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<CreateServiceInput>({
    resolver: zodResolver(createServiceSchema),
    defaultValues: {
      name: '',
      description: '',
      repositoryUrl: undefined,
      templateId: preselectedTemplateId,
    },
  });

  // Pre-fill templateId if query param arrives later
  useEffect(() => {
    if (preselectedTemplateId) {
      setValue('templateId', preselectedTemplateId);
    }
  }, [preselectedTemplateId, setValue]);

  const watchedName = watch('name');
  const generatedSlug = watchedName ? generateSlug(watchedName) : '';

  const mutation = useMutation({
    mutationFn: (data: CreateServiceInput) => createService(data),
    onSuccess: (createdService) => {
      queryClient.invalidateQueries({ queryKey: ['services'] });
      queryClient.invalidateQueries({ queryKey: ['dashboardSummary'] });
      navigate(`/services/${createdService.id}`);
    },
  });

  const onSubmit = (data: CreateServiceInput) => {
    mutation.mutate(data);
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center space-x-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/services')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Create New Service</h1>
          <p className="text-sm text-slate-400">Register a new service in the platform catalog.</p>
        </div>
      </div>

      <Card className="border-slate-800 bg-slate-900/90 shadow-xl">
        <form onSubmit={handleSubmit(onSubmit)}>
          <CardHeader>
            <CardTitle>Service Specification</CardTitle>
            <CardDescription>
              Service names must start with a lowercase letter and contain only lowercase letters,
              numbers, and hyphens (3–40 characters).
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-5">
            {mutation.isError && (
              <div className="p-3 bg-rose-500/15 border border-rose-500/30 rounded-md text-xs text-rose-300">
                {(mutation.error as Error).message}
              </div>
            )}

            {/* Service Name */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                Service Name <span className="text-rose-400">*</span>
              </label>
              <Input
                placeholder="e.g. payment-service"
                {...register('name')}
                className={errors.name ? 'border-rose-500 focus-visible:ring-rose-500' : ''}
              />
              {errors.name && <p className="text-xs text-rose-400">{errors.name.message}</p>}
              {/* Live slug preview */}
              <div className="flex items-center space-x-1.5 text-xs text-slate-500 pt-0.5">
                <Sparkles className="h-3 w-3 text-indigo-400" />
                <span>Slug preview:</span>
                <span className="font-mono text-indigo-300 bg-slate-950 px-1.5 py-0.5 rounded border border-slate-800">
                  {generatedSlug || 'service-slug'}
                </span>
              </div>
            </div>

            {/* Template Selection */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                Service Template
              </label>
              <Select {...register('templateId')} disabled={loadingTemplates}>
                <option value="">No template (Custom / Standalone)</option>
                {templates?.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.language} / {t.framework})
                  </option>
                ))}
              </Select>
              <p className="text-xs text-slate-500">
                Select an architecture blueprint to auto-configure build and runtime environments.
              </p>
            </div>

            {/* Repository URL */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                Git Repository URL
              </label>
              <Input
                placeholder="https://github.com/organization/repo"
                {...register('repositoryUrl')}
                className={
                  errors.repositoryUrl ? 'border-rose-500 focus-visible:ring-rose-500' : ''
                }
              />
              {errors.repositoryUrl && (
                <p className="text-xs text-rose-400">{errors.repositoryUrl.message}</p>
              )}
              <p className="text-xs text-slate-500">
                Must start with http:// or https://. Optional during initial draft.
              </p>
            </div>

            {/* Description */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                Description
              </label>
              <Textarea
                placeholder="Brief summary of service purpose, capabilities, and team ownership..."
                rows={3}
                {...register('description')}
              />
              {errors.description && (
                <p className="text-xs text-rose-400">{errors.description.message}</p>
              )}
            </div>
          </CardContent>

          <CardFooter className="flex justify-end space-x-3 border-t border-slate-800/80 pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate('/services')}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending} className="min-w-[120px]">
              {mutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                'Create Service'
              )}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
