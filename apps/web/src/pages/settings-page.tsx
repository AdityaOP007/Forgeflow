import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Shield, Users, AlertCircle, CheckCircle2 } from 'lucide-react';
import type { UserRole } from '@forgeflow/shared-types';
import { useAppAuth } from '../context/auth-context';
import { fetchUsers, updateUserRole } from '../lib/api-client';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
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

export function SettingsPage() {
  const { user, role } = useAppAuth();
  const queryClient = useQueryClient();
  const [roleError, setRoleError] = useState<string | null>(null);
  const [roleSuccess, setRoleSuccess] = useState<string | null>(null);

  const {
    data: members,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['users'],
    queryFn: () => fetchUsers(),
    enabled: role === 'admin',
  });

  const roleMutation = useMutation({
    mutationFn: ({ userId, nextRole }: { userId: string; nextRole: UserRole }) =>
      updateUserRole(userId, nextRole),
    onSuccess: (updated) => {
      setRoleError(null);
      setRoleSuccess(`Updated ${updated.email} role to ${updated.role}.`);
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err: Error) => {
      setRoleSuccess(null);
      setRoleError(err.message);
    },
  });

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white">Settings</h1>
        <p className="text-sm text-slate-400">
          Manage platform members, role assignments, and your account permissions.
        </p>
      </div>

      {/* Current User Card */}
      <Card className="border-slate-800 bg-slate-900/60">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center space-x-2">
            <Shield className="h-4 w-4 text-indigo-400" />
            <span>Your Account</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-sm">
          <div>
            <div className="font-medium text-white">{user?.name || 'Authenticated User'}</div>
            <div className="text-xs text-slate-400">{user?.email}</div>
          </div>
          <div className="flex items-center space-x-3">
            <Badge
              variant="outline"
              className="capitalize border-indigo-500 text-indigo-300 bg-indigo-950/30"
            >
              {role}
            </Badge>
            <span className="text-xs text-slate-400">
              {role === 'admin'
                ? 'Full access including member role management'
                : role === 'developer'
                  ? 'Can scaffold, deploy, and manage owned services'
                  : 'Read-only access across the catalog and workflows'}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Members Section (Admin only) */}
      {role === 'admin' ? (
        <Card className="border-slate-800 bg-slate-900/60 overflow-hidden">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center space-x-2">
              <Users className="h-4 w-4 text-indigo-400" />
              <span>Members</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {roleError && (
              <div className="p-3 bg-rose-500/15 border border-rose-500/30 rounded text-xs text-rose-300 flex items-center space-x-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{roleError}</span>
              </div>
            )}
            {roleSuccess && (
              <div className="p-3 bg-emerald-500/15 border border-emerald-500/30 rounded text-xs text-emerald-300 flex items-center space-x-2">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>{roleSuccess}</span>
              </div>
            )}

            {isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : error ? (
              <div className="text-sm text-rose-400">{(error as Error).message}</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead className="text-right">Joined</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(members ?? []).map((member) => {
                    const isSelf = member.id === user?.id;
                    return (
                      <TableRow key={member.id}>
                        <TableCell className="font-medium text-white">
                          {member.name || '—'}
                          {isSelf && <span className="ml-2 text-[11px] text-slate-400">(you)</span>}
                        </TableCell>
                        <TableCell className="text-xs font-mono text-slate-300">
                          {member.email}
                        </TableCell>
                        <TableCell>
                          <Select
                            aria-label={`Role for ${member.email}`}
                            value={member.role}
                            disabled={isSelf || roleMutation.isPending}
                            title={isSelf ? 'Admins cannot change their own role' : undefined}
                            onChange={(e) =>
                              roleMutation.mutate({
                                userId: member.id,
                                nextRole: e.target.value as UserRole,
                              })
                            }
                            className="w-36 bg-slate-950/60"
                          >
                            <option value="viewer">viewer</option>
                            <option value="developer">developer</option>
                            <option value="admin">admin</option>
                          </Select>
                        </TableCell>
                        <TableCell className="text-right text-xs font-mono text-slate-400">
                          {new Date(member.createdAt).toLocaleDateString()}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card className="border-slate-800 bg-slate-900/40 p-6 text-sm text-slate-400">
          Member management is restricted to administrators. Contact an admin if you need your role
          updated.
        </Card>
      )}
    </div>
  );
}
