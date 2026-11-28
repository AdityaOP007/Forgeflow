import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { History, AlertCircle, ChevronLeft, ChevronRight, Lock } from 'lucide-react';
import { useAppAuth } from '../context/auth-context';
import { fetchAuditLogs } from '../lib/api-client';
import { Card, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
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

export function ActivityLogsPage() {
  const { role } = useAppAuth();
  const [page, setPage] = useState(1);
  const [actionFilter, setActionFilter] = useState('');
  const [resourceTypeFilter, setResourceTypeFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['auditLogs', page, actionFilter, resourceTypeFilter, fromDate, toDate],
    queryFn: () =>
      fetchAuditLogs({
        page,
        pageSize: 20,
        action: actionFilter.trim() || undefined,
        resourceType: resourceTypeFilter || undefined,
        from: fromDate ? new Date(`${fromDate}T00:00:00.000Z`).toISOString() : undefined,
        to: toDate ? new Date(`${toDate}T23:59:59.999Z`).toISOString() : undefined,
      }),
    enabled: role === 'admin' || role === 'developer',
  });

  if (role === 'viewer') {
    return (
      <Card className="border-slate-800 bg-slate-900/40 p-10 text-center max-w-xl mx-auto my-8 space-y-3">
        <Lock className="h-8 w-8 text-slate-400 mx-auto" />
        <h2 className="text-lg font-semibold text-white">Activity Logs Restricted</h2>
        <p className="text-sm text-slate-400">
          Audit logs are available to developers and administrators. Your current role is{' '}
          <span className="font-mono text-slate-200">viewer</span>.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-6 max-w-7xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white flex items-center space-x-2">
          <History className="h-6 w-6 text-indigo-400" />
          <span>Activity Logs</span>
        </h1>
        <p className="text-sm text-slate-400">
          Immutable audit trail of service, deployment, workflow, and member actions.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 bg-slate-900/60 p-3 rounded-lg border border-slate-800">
        <Input
          aria-label="Filter by action"
          placeholder="Action (e.g. service.deploy)"
          value={actionFilter}
          onChange={(e) => {
            setActionFilter(e.target.value);
            setPage(1);
          }}
          className="bg-slate-950/60"
        />
        <Select
          aria-label="Filter by resource type"
          value={resourceTypeFilter}
          onChange={(e) => {
            setResourceTypeFilter(e.target.value);
            setPage(1);
          }}
          className="bg-slate-950/60"
        >
          <option value="">All resource types</option>
          <option value="service">service</option>
          <option value="deployment">deployment</option>
          <option value="workflow">workflow</option>
          <option value="user">user</option>
        </Select>
        <Input
          aria-label="From date"
          type="date"
          value={fromDate}
          onChange={(e) => {
            setFromDate(e.target.value);
            setPage(1);
          }}
          className="bg-slate-950/60"
        />
        <Input
          aria-label="To date"
          type="date"
          value={toDate}
          onChange={(e) => {
            setToDate(e.target.value);
            setPage(1);
          }}
          className="bg-slate-950/60"
        />
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : error ? (
        <Card className="border-rose-900 bg-rose-950/20 p-6 text-center space-y-2">
          <AlertCircle className="h-6 w-6 text-rose-400 mx-auto" />
          <p className="text-sm text-rose-300">{(error as Error).message}</p>
        </Card>
      ) : !data || data.data.length === 0 ? (
        <Card className="border-slate-800 bg-slate-900/40 p-10 text-center space-y-2">
          <History className="h-8 w-8 text-slate-500 mx-auto" />
          <h2 className="text-base font-semibold text-white">No audit entries found</h2>
          <p className="text-xs text-slate-400">No audit events match the active filters yet.</p>
        </Card>
      ) : (
        <Card className="border-slate-800 bg-slate-900/60 overflow-hidden">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Timestamp</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Resource</TableHead>
                  <TableHead>Resource ID</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.data.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="text-xs font-mono text-slate-400">
                      {new Date(entry.timestamp).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <div className="text-sm text-white">{entry.actorName || '—'}</div>
                      <div className="text-xs font-mono text-slate-400">{entry.actorEmail}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-xs text-indigo-300">
                        {entry.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs font-mono text-slate-300">
                      {entry.resourceType}
                    </TableCell>
                    <TableCell className="text-xs font-mono text-slate-400">
                      {entry.resourceId}
                    </TableCell>
                  </TableRow>
                ))}
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
    </div>
  );
}
