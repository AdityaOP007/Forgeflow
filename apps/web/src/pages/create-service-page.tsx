import React, { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createServiceSchema,
  scaffoldServiceSchema,
  generateSlug,
  type CreateServiceInput,
  type ScaffoldServiceInput,
} from '@forgeflow/shared-types';
import {
  ShieldAlert,
  ArrowLeft,
  ArrowRight,
  Loader2,
  Sparkles,
  Rocket,
  GitBranch,
  CheckCircle2,
  AlertTriangle,
  Database,
  Server,
  Lock,
  Globe,
  Code2,
} from 'lucide-react';
import { useAppAuth } from '../context/auth-context';
import {
  createService,
  scaffoldService,
  fetchTemplates,
  fetchGitHubIntegration,
} from '../lib/api-client';
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
import { Badge } from '../components/ui/badge';

type WizardStep = 1 | 2 | 3 | 4 | 5;

const WIZARD_STEPS: ReadonlyArray<{ num: WizardStep; label: string }> = [
  { num: 1, label: '1. Basics' },
  { num: 2, label: '2. Template' },
  { num: 3, label: '3. Repository' },
  { num: 4, label: '4. Target' },
  { num: 5, label: '5. Review' },
];

export function CreateServicePage() {
  const { user, role } = useAppAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const preselectedTemplateId = searchParams.get('templateId') || '';

  const [mode, setMode] = useState<'scaffold' | 'register'>('scaffold');
  const [wizardStep, setWizardStep] = useState<WizardStep>(1);

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

  const { data: templates, isLoading: loadingTemplates } = useQuery({
    queryKey: ['templates'],
    queryFn: () => fetchTemplates(),
  });

  const { data: githubStatus, isLoading: loadingGitHub } = useQuery({
    queryKey: ['githubIntegration'],
    queryFn: () => fetchGitHubIntegration(),
  });

  interface ScaffoldFormValues {
    name: string;
    description?: string;
    templateId: string;
    database?: 'postgresql';
    repositoryVisibility?: 'private' | 'public';
    environment?: 'local-docker';
  }

  const scaffoldForm = useForm<ScaffoldFormValues, unknown, ScaffoldServiceInput>({
    resolver: zodResolver(scaffoldServiceSchema),
    mode: 'onChange',
    defaultValues: {
      name: '',
      description: '',
      templateId: preselectedTemplateId,
      database: 'postgresql',
      repositoryVisibility: 'private',
      environment: 'local-docker',
    },
  });

  const registerForm = useForm<CreateServiceInput>({
    resolver: zodResolver(createServiceSchema),
    defaultValues: {
      name: '',
      description: '',
      repositoryUrl: undefined,
      templateId: preselectedTemplateId || undefined,
    },
  });

  useEffect(() => {
    if (!templates || templates.length === 0) return;
    if (preselectedTemplateId) {
      scaffoldForm.setValue('templateId', preselectedTemplateId, { shouldValidate: true });
      registerForm.setValue('templateId', preselectedTemplateId);
      return;
    }
    const currentTpl = scaffoldForm.getValues('templateId');
    if (!currentTpl) {
      const firstAvailable = templates.find((t) => t.available);
      if (firstAvailable) {
        scaffoldForm.setValue('templateId', firstAvailable.id, { shouldValidate: true });
      }
    }
  }, [templates, preselectedTemplateId, scaffoldForm, registerForm]);

  const watchedValues = scaffoldForm.watch();
  const watchedRegisterName = registerForm.watch('name');
  const generatedSlug =
    mode === 'scaffold'
      ? watchedValues.name
        ? generateSlug(watchedValues.name)
        : ''
      : watchedRegisterName
        ? generateSlug(watchedRegisterName)
        : '';

  const scaffoldMutation = useMutation({
    mutationFn: (data: ScaffoldServiceInput) => scaffoldService(data),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['services'] });
      queryClient.invalidateQueries({ queryKey: ['workflows'] });
      queryClient.invalidateQueries({ queryKey: ['dashboardSummary'] });
      navigate(`/workflows/${res.workflowId}`);
    },
  });

  const registerMutation = useMutation({
    mutationFn: (data: CreateServiceInput) => createService(data),
    onSuccess: (createdService) => {
      queryClient.invalidateQueries({ queryKey: ['services'] });
      queryClient.invalidateQueries({ queryKey: ['dashboardSummary'] });
      navigate(`/services/${createdService.id}`);
    },
  });

  const githubReady = Boolean(githubStatus?.configured && githubStatus?.connected);
  const selectedTemplate = templates?.find((t) => t.id === watchedValues.templateId);
  const ownerDisplay = user?.name || user?.email || 'Local Admin';
  const descriptionLength = (watchedValues.description || '').length;

  const handleNextStep = async () => {
    if (wizardStep === 1) {
      const valid = await scaffoldForm.trigger(['name', 'description']);
      if (valid) setWizardStep(2);
    } else if (wizardStep === 2) {
      const valid = await scaffoldForm.trigger(['templateId', 'database']);
      if (valid) setWizardStep(3);
    } else if (wizardStep === 3) {
      const valid = await scaffoldForm.trigger(['repositoryVisibility']);
      if (valid && githubReady) setWizardStep(4);
    } else if (wizardStep === 4) {
      const valid = await scaffoldForm.trigger(['environment']);
      if (valid) setWizardStep(5);
    }
  };

  const handleBackStep = () => {
    setWizardStep((s) => (s > 1 ? ((s - 1) as WizardStep) : 1));
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center space-x-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/services')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Create New Service</h1>
          <p className="text-sm text-slate-400">
            Scaffold a new microservice repository on GitHub or register an existing one.
          </p>
        </div>
      </div>

      {/* Mode Selector */}
      <div className="grid grid-cols-2 gap-3 max-w-2xl">
        <button
          type="button"
          onClick={() => setMode('scaffold')}
          className={`p-3.5 rounded-lg border text-left transition-colors ${
            mode === 'scaffold'
              ? 'border-indigo-500 bg-indigo-600/15 text-white'
              : 'border-slate-800 bg-slate-900/60 text-slate-400 hover:border-slate-700'
          }`}
        >
          <div className="flex items-center space-x-2 font-semibold text-sm">
            <Rocket className="h-4 w-4 text-indigo-400" />
            <span>Scaffold New Service</span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Render a template, create a GitHub repository, and push initial files.
          </p>
        </button>

        <button
          type="button"
          onClick={() => setMode('register')}
          className={`p-3.5 rounded-lg border text-left transition-colors ${
            mode === 'register'
              ? 'border-indigo-500 bg-indigo-600/15 text-white'
              : 'border-slate-800 bg-slate-900/60 text-slate-400 hover:border-slate-700'
          }`}
        >
          <div className="flex items-center space-x-2 font-semibold text-sm">
            <GitBranch className="h-4 w-4 text-slate-400" />
            <span>Register existing service</span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Add an existing repository directly to the service catalog.
          </p>
        </button>
      </div>

      {mode === 'scaffold' ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
          {/* Main 5-Step Wizard */}
          <Card className="lg:col-span-2 border-slate-800 bg-slate-900/90 shadow-xl">
            {/* Step Indicator */}
            <div className="px-6 pt-6 pb-3 border-b border-slate-800/80">
              <div className="grid grid-cols-5 gap-1.5">
                {WIZARD_STEPS.map((s) => (
                  <div
                    key={s.num}
                    className={`px-2 py-2 rounded-md text-[11px] font-medium text-center border ${
                      wizardStep === s.num
                        ? 'border-indigo-500 bg-indigo-600/20 text-indigo-300'
                        : wizardStep > s.num
                          ? 'border-emerald-500/30 bg-emerald-950/20 text-emerald-300'
                          : 'border-slate-800 bg-slate-950/40 text-slate-500'
                    }`}
                  >
                    {s.label}
                  </div>
                ))}
              </div>
            </div>

            <form onSubmit={scaffoldForm.handleSubmit((data) => scaffoldMutation.mutate(data))}>
              <CardHeader>
                <CardTitle>
                  {wizardStep === 1 && 'Step 1: Basics'}
                  {wizardStep === 2 && 'Step 2: Template & Database'}
                  {wizardStep === 3 && 'Step 3: Repository'}
                  {wizardStep === 4 && 'Step 4: Deployment Target'}
                  {wizardStep === 5 && 'Step 5: Review & Create'}
                </CardTitle>
                <CardDescription>
                  {wizardStep === 1 &&
                    'Name your service (3–40 lowercase letters, numbers, hyphens) and describe its purpose.'}
                  {wizardStep === 2 &&
                    'Select an architecture template and database engine for your new service.'}
                  {wizardStep === 3 &&
                    'Verify the target GitHub organization and choose repository visibility.'}
                  {wizardStep === 4 &&
                    'Select the target runtime environment for local development or deployment.'}
                  {wizardStep === 5 &&
                    'Review all choices below and click Create to start provisioning.'}
                </CardDescription>
              </CardHeader>

              <CardContent className="space-y-5">
                {scaffoldMutation.isError && (
                  <div
                    role="alert"
                    className="p-3 bg-rose-500/15 border border-rose-500/30 rounded-md text-xs text-rose-300"
                  >
                    {(scaffoldMutation.error as Error).message}
                  </div>
                )}

                {/* STEP 1: BASICS */}
                {wizardStep === 1 && (
                  <>
                    <div className="space-y-1.5">
                      <label
                        htmlFor="scaffold-name"
                        className="text-xs font-semibold text-slate-300 uppercase tracking-wider"
                      >
                        Service Name <span className="text-rose-400">*</span>
                      </label>
                      <Input
                        id="scaffold-name"
                        placeholder="e.g. orders-service"
                        {...scaffoldForm.register('name')}
                        className={
                          scaffoldForm.formState.errors.name
                            ? 'border-rose-500 focus-visible:ring-rose-500'
                            : ''
                        }
                      />
                      {scaffoldForm.formState.errors.name && (
                        <p className="text-xs text-rose-400">
                          {scaffoldForm.formState.errors.name.message}
                        </p>
                      )}
                      <div className="flex items-center space-x-1.5 text-xs text-slate-500 pt-0.5">
                        <Sparkles className="h-3 w-3 text-indigo-400" />
                        <span>Repository name preview:</span>
                        <span className="font-mono text-indigo-300 bg-slate-950 px-1.5 py-0.5 rounded border border-slate-800">
                          {githubStatus?.org ? `${githubStatus.org}/` : ''}
                          {generatedSlug || 'service-slug'}
                        </span>
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <label
                          htmlFor="scaffold-description"
                          className="text-xs font-semibold text-slate-300 uppercase tracking-wider"
                        >
                          Description
                        </label>
                        <span
                          className={`text-xs font-mono ${
                            descriptionLength > 300 ? 'text-rose-400' : 'text-slate-500'
                          }`}
                        >
                          {descriptionLength}/300
                        </span>
                      </div>
                      <Textarea
                        id="scaffold-description"
                        placeholder="Brief summary of service purpose, capabilities, and team ownership..."
                        rows={3}
                        maxLength={300}
                        {...scaffoldForm.register('description')}
                      />
                      {scaffoldForm.formState.errors.description && (
                        <p className="text-xs text-rose-400">
                          {scaffoldForm.formState.errors.description.message}
                        </p>
                      )}
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                        Owner
                      </label>
                      <Input value={ownerDisplay} readOnly disabled className="bg-slate-950/60" />
                    </div>
                  </>
                )}

                {/* STEP 2: TEMPLATE & DATABASE */}
                {wizardStep === 2 && (
                  <>
                    <div className="space-y-2">
                      <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider block">
                        Service Template <span className="text-rose-400">*</span>
                      </label>
                      {loadingTemplates ? (
                        <div className="text-xs text-slate-400">Loading templates...</div>
                      ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          {templates?.map((t) => {
                            const selected = watchedValues.templateId === t.id;
                            return (
                              <button
                                key={t.id}
                                type="button"
                                disabled={!t.available}
                                onClick={() =>
                                  scaffoldForm.setValue('templateId', t.id, {
                                    shouldValidate: true,
                                  })
                                }
                                className={`p-3.5 rounded-lg border text-left transition-colors ${
                                  !t.available
                                    ? 'border-slate-800 bg-slate-950/30 opacity-60 cursor-not-allowed'
                                    : selected
                                      ? 'border-indigo-500 bg-indigo-600/15 text-white'
                                      : 'border-slate-800 bg-slate-950/50 text-slate-300 hover:border-slate-700'
                                }`}
                              >
                                <div className="flex items-center justify-between mb-1">
                                  <div className="flex items-center space-x-2">
                                    <Code2 className="h-4 w-4 text-indigo-400" />
                                    <span className="font-semibold text-sm">{t.name}</span>
                                  </div>
                                  <Badge
                                    variant={t.available ? 'healthy' : 'unknown'}
                                    className="text-[10px]"
                                  >
                                    {t.available ? `v${t.version}` : 'Available in a later phase'}
                                  </Badge>
                                </div>
                                <div className="text-xs text-slate-400 capitalize">
                                  {t.language} / {t.framework}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}
                      {scaffoldForm.formState.errors.templateId && (
                        <p className="text-xs text-rose-400">
                          {scaffoldForm.formState.errors.templateId.message}
                        </p>
                      )}
                    </div>

                    <div className="space-y-2 pt-2">
                      <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider block">
                        Database
                      </label>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <button
                          type="button"
                          onClick={() =>
                            scaffoldForm.setValue('database', 'postgresql', {
                              shouldValidate: true,
                            })
                          }
                          className="p-3 rounded-lg border border-indigo-500 bg-indigo-600/15 text-left"
                        >
                          <div className="flex items-center space-x-2 text-sm font-semibold text-white">
                            <Database className="h-4 w-4 text-indigo-400" />
                            <span>PostgreSQL</span>
                          </div>
                          <div className="text-[11px] text-emerald-400 mt-1">Selected</div>
                        </button>

                        <button
                          type="button"
                          disabled
                          className="p-3 rounded-lg border border-slate-800 bg-slate-950/30 text-left opacity-60 cursor-not-allowed"
                        >
                          <div className="flex items-center space-x-2 text-sm font-semibold text-slate-400">
                            <Database className="h-4 w-4" />
                            <span>MongoDB</span>
                          </div>
                          <div className="text-[11px] text-slate-500 mt-1">
                            Available in a later phase
                          </div>
                        </button>

                        <button
                          type="button"
                          disabled
                          className="p-3 rounded-lg border border-slate-800 bg-slate-950/30 text-left opacity-60 cursor-not-allowed"
                        >
                          <div className="flex items-center space-x-2 text-sm font-semibold text-slate-400">
                            <Database className="h-4 w-4" />
                            <span>None</span>
                          </div>
                          <div className="text-[11px] text-slate-500 mt-1">
                            Available in a later phase
                          </div>
                        </button>
                      </div>
                    </div>
                  </>
                )}

                {/* STEP 3: REPOSITORY */}
                {wizardStep === 3 && (
                  <>
                    {!loadingGitHub && githubStatus && !githubReady && (
                      <div className="p-4 rounded-lg border border-rose-500/40 bg-rose-950/20 text-xs text-rose-200 space-y-1.5">
                        <div className="flex items-center space-x-2 font-semibold">
                          <AlertTriangle className="h-4 w-4 text-rose-400 shrink-0" />
                          <span>GitHub App is not connected</span>
                        </div>
                        <p className="text-rose-300/90">
                          {githubStatus.message} Follow{' '}
                          <span className="font-mono bg-rose-950/60 px-1 py-0.5 rounded">
                            docs/github-app-setup.md
                          </span>{' '}
                          to configure GitHub App credentials before scaffolding.
                        </p>
                      </div>
                    )}

                    {!loadingGitHub && githubReady && githubStatus && (
                      <div className="p-3.5 rounded-lg border border-emerald-500/30 bg-emerald-950/20 text-xs text-emerald-300 flex items-center justify-between">
                        <div className="flex items-center space-x-2">
                          <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                          <span>Connected to GitHub organization {githubStatus.org}</span>
                        </div>
                        <Badge variant="outline" className="font-mono text-[10px]">
                          {githubStatus.org}
                        </Badge>
                      </div>
                    )}

                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                        GitHub Organization
                      </label>
                      <Input
                        value={githubStatus?.org || 'Not configured'}
                        readOnly
                        disabled
                        className="bg-slate-950/60 font-mono"
                      />
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider block">
                        Repository Visibility
                      </label>
                      <div className="grid grid-cols-2 gap-3">
                        <button
                          type="button"
                          onClick={() =>
                            scaffoldForm.setValue('repositoryVisibility', 'private', {
                              shouldValidate: true,
                            })
                          }
                          className={`p-3.5 rounded-lg border text-left transition-colors ${
                            (watchedValues.repositoryVisibility || 'private') === 'private'
                              ? 'border-indigo-500 bg-indigo-600/15 text-white'
                              : 'border-slate-800 bg-slate-950/50 text-slate-400'
                          }`}
                        >
                          <div className="flex items-center space-x-2 text-sm font-semibold">
                            <Lock className="h-4 w-4 text-indigo-400" />
                            <span>Private</span>
                          </div>
                          <p className="text-xs text-slate-400 mt-1">
                            Visible only to members of {githubStatus?.org || 'your organization'}.
                          </p>
                        </button>

                        <button
                          type="button"
                          onClick={() =>
                            scaffoldForm.setValue('repositoryVisibility', 'public', {
                              shouldValidate: true,
                            })
                          }
                          className={`p-3.5 rounded-lg border text-left transition-colors ${
                            watchedValues.repositoryVisibility === 'public'
                              ? 'border-indigo-500 bg-indigo-600/15 text-white'
                              : 'border-slate-800 bg-slate-950/50 text-slate-400'
                          }`}
                        >
                          <div className="flex items-center space-x-2 text-sm font-semibold">
                            <Globe className="h-4 w-4 text-emerald-400" />
                            <span>Public</span>
                          </div>
                          <p className="text-xs text-slate-400 mt-1">
                            Visible to everyone on GitHub.
                          </p>
                        </button>
                      </div>
                    </div>
                  </>
                )}

                {/* STEP 4: DEPLOYMENT TARGET */}
                {wizardStep === 4 && (
                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider block">
                      Deployment Target
                    </label>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <button
                        type="button"
                        onClick={() =>
                          scaffoldForm.setValue('environment', 'local-docker', {
                            shouldValidate: true,
                          })
                        }
                        className="p-3.5 rounded-lg border border-indigo-500 bg-indigo-600/15 text-left"
                      >
                        <div className="flex items-center space-x-2 text-sm font-semibold text-white">
                          <Server className="h-4 w-4 text-indigo-400" />
                          <span>Local Docker</span>
                        </div>
                        <div className="text-[11px] text-emerald-400 mt-1">Selected</div>
                      </button>

                      <button
                        type="button"
                        disabled
                        className="p-3.5 rounded-lg border border-slate-800 bg-slate-950/30 text-left opacity-60 cursor-not-allowed"
                      >
                        <div className="flex items-center space-x-2 text-sm font-semibold text-slate-400">
                          <Server className="h-4 w-4" />
                          <span>Kubernetes (Staging)</span>
                        </div>
                        <div className="text-[11px] text-slate-500 mt-1">Phase 3</div>
                      </button>

                      <button
                        type="button"
                        disabled
                        className="p-3.5 rounded-lg border border-slate-800 bg-slate-950/30 text-left opacity-60 cursor-not-allowed"
                      >
                        <div className="flex items-center space-x-2 text-sm font-semibold text-slate-400">
                          <Server className="h-4 w-4" />
                          <span>Kubernetes (Prod)</span>
                        </div>
                        <div className="text-[11px] text-slate-500 mt-1">Phase 3</div>
                      </button>
                    </div>
                  </div>
                )}

                {/* STEP 5: REVIEW */}
                {wizardStep === 5 && (
                  <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4 space-y-3 text-sm">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <span className="text-xs text-slate-500 block">Service Name</span>
                        <span className="font-mono text-white">{watchedValues.name}</span>
                      </div>
                      <div>
                        <span className="text-xs text-slate-500 block">Owner</span>
                        <span className="text-white">{ownerDisplay}</span>
                      </div>
                      <div>
                        <span className="text-xs text-slate-500 block">Template</span>
                        <span className="text-white">
                          {selectedTemplate
                            ? `${selectedTemplate.name} (v${selectedTemplate.version})`
                            : watchedValues.templateId}
                        </span>
                      </div>
                      <div>
                        <span className="text-xs text-slate-500 block">Database</span>
                        <span className="text-white">PostgreSQL</span>
                      </div>
                      <div>
                        <span className="text-xs text-slate-500 block">GitHub Repository</span>
                        <span className="font-mono text-indigo-300">
                          {githubStatus?.org}/{watchedValues.name}
                        </span>
                      </div>
                      <div>
                        <span className="text-xs text-slate-500 block">Visibility</span>
                        <span className="capitalize text-white">
                          {watchedValues.repositoryVisibility || 'private'}
                        </span>
                      </div>
                      <div>
                        <span className="text-xs text-slate-500 block">Deployment Target</span>
                        <span className="text-white">Local Docker</span>
                      </div>
                    </div>
                    {watchedValues.description && (
                      <div className="pt-2 border-t border-slate-800">
                        <span className="text-xs text-slate-500 block">Description</span>
                        <span className="text-slate-300">{watchedValues.description}</span>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>

              <CardFooter className="flex justify-between border-t border-slate-800/80 pt-4">
                <div>
                  {wizardStep > 1 ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleBackStep}
                      disabled={scaffoldMutation.isPending}
                    >
                      <ArrowLeft className="h-4 w-4 mr-1.5" />
                      Back
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => navigate('/services')}
                      disabled={scaffoldMutation.isPending}
                    >
                      Cancel
                    </Button>
                  )}
                </div>

                <div>
                  {wizardStep < 5 ? (
                    <Button
                      type="button"
                      onClick={handleNextStep}
                      disabled={
                        (wizardStep === 1 &&
                          (!watchedValues.name ||
                            Boolean(scaffoldForm.formState.errors.name) ||
                            Boolean(scaffoldForm.formState.errors.description))) ||
                        (wizardStep === 2 && !watchedValues.templateId) ||
                        (wizardStep === 3 && !githubReady)
                      }
                    >
                      <span>Continue</span>
                      <ArrowRight className="h-4 w-4 ml-1.5" />
                    </Button>
                  ) : (
                    <Button
                      type="submit"
                      disabled={scaffoldMutation.isPending || !githubReady}
                      className="min-w-[120px]"
                    >
                      {scaffoldMutation.isPending ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Creating...
                        </>
                      ) : (
                        'Create'
                      )}
                    </Button>
                  )}
                </div>
              </CardFooter>
            </form>
          </Card>

          {/* Always-visible Summary Sidebar */}
          <Card className="border-slate-800 bg-slate-900/60">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm uppercase tracking-wider text-slate-300">
                Summary
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-xs">
              <div>
                <span className="text-slate-500 block">Service Name</span>
                <span className="font-mono text-white">{watchedValues.name || 'Not set yet'}</span>
              </div>
              <div>
                <span className="text-slate-500 block">Owner</span>
                <span className="text-slate-200">{ownerDisplay}</span>
              </div>
              <div>
                <span className="text-slate-500 block">Template</span>
                <span className="text-slate-200">
                  {selectedTemplate ? selectedTemplate.name : 'Not selected'}
                </span>
              </div>
              <div>
                <span className="text-slate-500 block">Database</span>
                <span className="text-slate-200">PostgreSQL</span>
              </div>
              <div>
                <span className="text-slate-500 block">GitHub Organization</span>
                <span className="font-mono text-indigo-300">
                  {githubStatus?.org || 'Not connected'}
                </span>
              </div>
              <div>
                <span className="text-slate-500 block">Visibility</span>
                <span className="capitalize text-slate-200">
                  {watchedValues.repositoryVisibility || 'private'}
                </span>
              </div>
              <div>
                <span className="text-slate-500 block">Target</span>
                <span className="text-slate-200">Local Docker</span>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : (
        <Card className="max-w-2xl border-slate-800 bg-slate-900/90 shadow-xl">
          <form onSubmit={registerForm.handleSubmit((data) => registerMutation.mutate(data))}>
            <CardHeader>
              <CardTitle>Register existing service</CardTitle>
              <CardDescription>
                Service names must start with a lowercase letter and contain only lowercase letters,
                numbers, and hyphens (3–40 characters).
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-5">
              {registerMutation.isError && (
                <div className="p-3 bg-rose-500/15 border border-rose-500/30 rounded-md text-xs text-rose-300">
                  {(registerMutation.error as Error).message}
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                  Service Name <span className="text-rose-400">*</span>
                </label>
                <Input
                  placeholder="e.g. payment-service"
                  {...registerForm.register('name')}
                  className={
                    registerForm.formState.errors.name
                      ? 'border-rose-500 focus-visible:ring-rose-500'
                      : ''
                  }
                />
                {registerForm.formState.errors.name && (
                  <p className="text-xs text-rose-400">
                    {registerForm.formState.errors.name.message}
                  </p>
                )}
                <div className="flex items-center space-x-1.5 text-xs text-slate-500 pt-0.5">
                  <Sparkles className="h-3 w-3 text-indigo-400" />
                  <span>Slug preview:</span>
                  <span className="font-mono text-indigo-300 bg-slate-950 px-1.5 py-0.5 rounded border border-slate-800">
                    {generatedSlug || 'service-slug'}
                  </span>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                  Service Template
                </label>
                <Select {...registerForm.register('templateId')} disabled={loadingTemplates}>
                  <option value="">No template (Custom / Standalone)</option>
                  {templates?.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.language} / {t.framework})
                    </option>
                  ))}
                </Select>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                  Git Repository URL
                </label>
                <Input
                  placeholder="https://github.com/organization/repo"
                  {...registerForm.register('repositoryUrl')}
                  className={
                    registerForm.formState.errors.repositoryUrl
                      ? 'border-rose-500 focus-visible:ring-rose-500'
                      : ''
                  }
                />
                {registerForm.formState.errors.repositoryUrl && (
                  <p className="text-xs text-rose-400">
                    {registerForm.formState.errors.repositoryUrl.message}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                  Description
                </label>
                <Textarea
                  placeholder="Brief summary of service purpose, capabilities, and team ownership..."
                  rows={3}
                  {...registerForm.register('description')}
                />
              </div>
            </CardContent>

            <CardFooter className="flex justify-end space-x-3 border-t border-slate-800/80 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate('/services')}
                disabled={registerMutation.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={registerMutation.isPending} className="min-w-[120px]">
                {registerMutation.isPending ? (
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
      )}
    </div>
  );
}
