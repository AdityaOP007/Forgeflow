import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Search, Plus, ExternalLink, Layers, Filter } from 'lucide-react';
import { useAppAuth } from '../context/auth-context';
import { fetchServices } from '../lib/api-client';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
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
import { isSafeHttpsUrl } from '../lib/utils';
import type { EnvironmentStatus, ServiceProvisioningStatus } from '@forgeflow/shared-types';

export function CatalogPage() {
  const { role } = useAppAuth();
  const navigate = useNavigate();

  const [search, setSearch] = useState('');
  const [healthFilter, setHealthFilter] = useState<string>('all');
  const [page, setPage] = useState(1);
  const pageSize = 15;

  const {
    data: response,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['services', search, healthFilter, page],
    queryFn: () =>
      fetchServices({
        search: search || undefined,
        health: healthFilter !== 'all' ? (healthFilter as EnvironmentStatus) : undefined,
        page,
        pageSize,
        sort: 'createdAt',
        order: 'desc',
      }),
  });

  const getProvisioningBadge = (status: ServiceProvisioningStatus) => {
    switch (status) {
      case 'ready':
        return (
          <Badge variant="healthy" className="capitalize">
            Ready
          </Badge>
        );
      case 'failed':
        return (
          <Badge variant="failed" className="capitalize">
            Failed
          </Badge>
        );
      default:
        return (
          <Badge variant="degraded" className="capitalize">
            Provisioning
          </Badge>
        );
    }
  };

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

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Service Catalog</h1>
          <p className="text-sm text-slate-400">
            Browse, manage, and inspect all platform-managed services.
          </p>
        </div>
        {role !== 'viewer' && (
          <Button onClick={() => navigate('/services/new')} className="space-x-2 shrink-0">
            <Plus className="h-4 w-4" />
            <span>Create Service</span>
          </Button>
        )}
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-center gap-3 bg-slate-900/60 p-3 rounded-lg border border-slate-800">
        <div className="relative flex-1 w-full">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
          <Input
            placeholder="Search services by name or description..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="pl-9 bg-slate-950/60"
          />
        </div>

        <div className="flex items-center space-x-2 w-full sm:w-auto">
          <Filter className="h-4 w-4 text-slate-500 shrink-0" />
          <Select
            value={healthFilter}
            onChange={(e) => {
              setHealthFilter(e.target.value);
              setPage(1);
            }}
            className="w-full sm:w-44 bg-slate-950/60"
          >
            <option value="all">All Health States</option>
            <option value="healthy">Healthy</option>
            <option value="degraded">Degraded</option>
            <option value="failed">Failed</option>
            <option value="unknown">Unknown</option>
          </Select>
        </div>
      </div>

      {/* Services Table */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : error ? (
        <div className="p-8 text-center text-rose-400 bg-rose-950/20 border border-rose-900 rounded-lg">
          Failed to load service catalog. {(error as Error).message}
        </div>
      ) : !response || response.data.length === 0 ? (
        <Card className="p-12 text-center border-dashed border-slate-800 bg-slate-900/40">
          <div className="mx-auto h-12 w-12 rounded-full bg-slate-800 flex items-center justify-center text-slate-400 mb-4">
            <Layers className="h-6 w-6" />
          </div>
          <h3 className="text-lg font-semibold text-white">No services found</h3>
          <p className="text-sm text-slate-400 max-w-sm mx-auto mt-1 mb-6">
            {search || healthFilter !== 'all'
              ? 'No services match the active search query and health filter.'
              : 'The catalog is empty. Provision a service to get started.'}
          </p>
          {role !== 'viewer' && (
            <Button onClick={() => navigate('/services/new')}>Create Service</Button>
          )}
        </Card>
      ) : (
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Service</TableHead>
                <TableHead>Provisioning</TableHead>
                <TableHead>Health</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Template</TableHead>
                <TableHead>Repository</TableHead>
                <TableHead className="text-right">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {response.data.map((svc) => (
                <TableRow
                  key={svc.id}
                  onClick={() => navigate(`/services/${svc.id}`)}
                  className="cursor-pointer hover:bg-slate-800/60 transition-colors"
                >
                  <TableCell>
                    <div>
                      <span className="font-semibold text-white hover:text-indigo-400 transition-colors block">
                        {svc.name}
                      </span>
                      <span className="text-xs text-slate-500 font-mono">{svc.slug}</span>
                    </div>
                  </TableCell>

                  <TableCell>{getProvisioningBadge(svc.provisioningStatus)}</TableCell>

                  <TableCell>{getHealthBadge(svc.health)}</TableCell>

                  <TableCell className="text-slate-300">{svc.ownerName || 'Unassigned'}</TableCell>

                  <TableCell>
                    {svc.templateName ? (
                      <span className="text-xs text-slate-300 bg-slate-800 px-2 py-0.5 rounded">
                        {svc.templateName}
                      </span>
                    ) : (
                      <span className="text-xs text-slate-500">Custom</span>
                    )}
                  </TableCell>

                  <TableCell>
                    {isSafeHttpsUrl(svc.repositoryUrl) ? (
                      <a
                        href={svc.repositoryUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center space-x-1 text-xs text-indigo-400 hover:text-indigo-300 hover:underline"
                      >
                        <span className="truncate max-w-[180px]">
                          {svc.repositoryUrl.replace(/^https?:\/\//, '')}
                        </span>
                        <ExternalLink className="h-3 w-3 shrink-0" />
                      </a>
                    ) : (
                      <span className="text-xs text-slate-500">—</span>
                    )}
                  </TableCell>

                  <TableCell className="text-right text-xs text-slate-400 font-mono">
                    {new Date(svc.createdAt).toLocaleDateString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {/* Pagination bar */}
          {response.totalPages > 1 && (
            <div className="flex items-center justify-between p-4 border-t border-slate-800 text-xs text-slate-400">
              <div>
                Page {response.page} of {response.totalPages} ({response.total} total)
              </div>
              <div className="space-x-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
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
        </div>
      )}
    </div>
  );
}
