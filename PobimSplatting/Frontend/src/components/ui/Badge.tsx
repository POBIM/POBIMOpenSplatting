'use client';

import { ReactNode } from 'react';

type BadgeVariant =
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'pending'
  | 'live'
  | 'new'
  | 'recommended';

const bgMap: Record<BadgeVariant, string> = {
  processing: 'var(--processing-bg)',
  completed: 'var(--success-bg)',
  failed: 'var(--error-bg)',
  cancelled: 'var(--warning-bg)',
  pending: 'var(--paper-muted)',
  live: 'var(--success-bg)',
  new: 'var(--processing-bg)',
  recommended: 'var(--success-bg)',
};

const fgMap: Record<BadgeVariant, string> = {
  processing: 'var(--processing-text)',
  completed: 'var(--success-text)',
  failed: 'var(--error-text)',
  cancelled: 'var(--warning-text)',
  pending: 'var(--text-secondary)',
  live: 'var(--success-text)',
  new: 'var(--processing-text)',
  recommended: 'var(--success-text)',
};

const dotMap: Record<BadgeVariant, string> = {
  processing: 'var(--processing-icon)',
  completed: 'var(--success-icon)',
  failed: 'var(--error-icon)',
  cancelled: 'var(--warning-icon)',
  pending: 'var(--text-muted)',
  live: 'var(--success-icon)',
  new: 'var(--processing-icon)',
  recommended: 'var(--success-icon)',
};

interface BadgeProps {
  variant: BadgeVariant;
  children: ReactNode;
  pulse?: boolean;
  icon?: ReactNode;
}

export function Badge({ variant, children, pulse = false, icon }: BadgeProps) {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider"
      style={{
        background: bgMap[variant],
        color: fgMap[variant],
        border: 'var(--border-w) solid var(--ink)',
        boxShadow: '2px 2px 0 var(--ink)',
      }}
    >
      {pulse && (
        <span
          className="w-1.5 h-1.5 brutal-pulse"
          style={{ background: dotMap[variant] }}
        />
      )}
      {icon && <span className="inline-flex">{icon}</span>}
      {children}
    </span>
  );
}
