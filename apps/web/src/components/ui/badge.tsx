import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

export const badgeVariants = cva(
  'inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-indigo-600/20 text-indigo-300 border-indigo-500/30',
        secondary: 'border-transparent bg-slate-800 text-slate-300',
        destructive: 'border-transparent bg-rose-500/20 text-rose-300 border-rose-500/30',
        outline: 'text-slate-300 border-slate-700',
        healthy: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
        degraded: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
        failed: 'border-rose-500/30 bg-rose-500/10 text-rose-400',
        unknown: 'border-slate-700 bg-slate-800/60 text-slate-400',
        admin: 'border-purple-500/30 bg-purple-500/20 text-purple-300',
        developer: 'border-blue-500/30 bg-blue-500/20 text-blue-300',
        viewer: 'border-slate-600 bg-slate-700/30 text-slate-300',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}
