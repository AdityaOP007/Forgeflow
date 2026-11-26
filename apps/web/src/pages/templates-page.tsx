import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { FileCode2, ArrowRight, Tag, Code2 } from 'lucide-react';
import { useAppAuth } from '../context/auth-context';
import { fetchTemplates } from '../lib/api-client';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';

export function TemplatesPage() {
  const { role } = useAppAuth();
  const navigate = useNavigate();

  const {
    data: templates,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['templates'],
    queryFn: () => fetchTemplates(),
  });

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white">Service Templates</h1>
        <p className="text-sm text-slate-400">
          Standardized architecture blueprints with pre-configured CI/CD, linting, Docker, and
          Kubernetes deployment specs.
        </p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-56 w-full" />
          ))}
        </div>
      ) : error ? (
        <div className="p-8 text-center text-rose-400 bg-rose-950/20 border border-rose-900 rounded-lg">
          Failed to load templates. {(error as Error).message}
        </div>
      ) : !templates || templates.length === 0 ? (
        <Card className="p-12 text-center border-dashed border-slate-800 bg-slate-900/40">
          <div className="mx-auto h-12 w-12 rounded-full bg-slate-800 flex items-center justify-center text-slate-400 mb-4">
            <FileCode2 className="h-6 w-6" />
          </div>
          <h3 className="text-lg font-semibold text-white">No templates available</h3>
          <p className="text-sm text-slate-400 max-w-sm mx-auto mt-1">
            No architecture templates are currently registered in the database.
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {templates.map((tpl) => (
            <Card
              key={tpl.id}
              className="border-slate-800 bg-slate-900/80 hover:border-slate-700 transition-all flex flex-col justify-between"
            >
              <CardHeader>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center space-x-2">
                    <div className="h-8 w-8 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
                      <Code2 className="h-4 w-4" />
                    </div>
                    <Badge variant="outline" className="font-mono text-[10px]">
                      v{tpl.version}
                    </Badge>
                  </div>
                  <div className="flex items-center space-x-1.5">
                    <Badge variant={tpl.available ? 'healthy' : 'unknown'} className="text-xs">
                      {tpl.available ? 'Available' : 'Coming Soon'}
                    </Badge>
                    <Badge variant="secondary" className="capitalize text-xs">
                      {tpl.language}
                    </Badge>
                    <Badge variant="secondary" className="capitalize text-xs">
                      {tpl.framework}
                    </Badge>
                  </div>
                </div>

                <CardTitle className="text-lg">{tpl.name}</CardTitle>
                <CardDescription className="text-xs font-mono text-slate-500">
                  {tpl.slug}
                </CardDescription>
              </CardHeader>

              <CardContent className="space-y-4">
                <p className="text-sm text-slate-300 leading-relaxed">
                  Production-ready {tpl.language} microservice scaffold powered by {tpl.framework},
                  including health checks, structured logging, and container configuration.
                </p>

                <div className="p-2.5 rounded bg-slate-950/60 border border-slate-800/80 text-xs font-mono text-slate-400 flex items-center space-x-2">
                  <Tag className="h-3.5 w-3.5 text-slate-500 shrink-0" />
                  <span className="truncate">{tpl.sourceLocation}</span>
                </div>
              </CardContent>

              <CardFooter className="pt-2 border-t border-slate-800/60">
                {role !== 'viewer' ? (
                  <Button
                    disabled={!tpl.available}
                    onClick={() => navigate(`/services/new?templateId=${tpl.id}`)}
                    className="w-full justify-between"
                  >
                    <span>{tpl.available ? 'Use this template' : 'Coming Soon'}</span>
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                ) : (
                  <div className="text-xs text-slate-500 text-center w-full py-2">
                    Viewers cannot provision services from templates
                  </div>
                )}
              </CardFooter>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
