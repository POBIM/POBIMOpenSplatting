'use client';

import { ReactNode } from 'react';

type BadgeVariant = 'processing' | 'completed' | 'failed' | 'cancelled' | 'pending' | 'live' | 'new' | 'recommended';

const variants: Record<BadgeVariant, string> = {
  processing: 'bg-blue-100 text-blue-700 border-blue-200',
  completed: 'bg-green-100 text-green-700 border-green-200',
  failed: 'bg-red-100 text-red-700 border-red-200',
  cancelled: 'bg-amber-100 text-amber-700 border-amber-200',
  pending: 'bg-gray-100 text-gray-600 border-gray-200',
  live: 'bg-green-100 text-green-700 border-green-200',
  new: 'bg-purple-100 text-purple-700 border-purple-200',
  recommended: 'bg-emerald-100 text-emerald-700 border-emerald-200',
};

interface BadgeProps {
  variant: BadgeVariant;
  children: ReactNode;
  pulse?: boolean;
  icon?: ReactNode;
}

export function Badge({ variant, children, pulse = false, icon }: BadgeProps) {
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${variants[variant]}`}>
      {pulse && (
        <span className={`w-1.5 h-1.5 rounded-full mr-1.5 animate-pulse ${
          variant === 'live' ? 'bg-green-500' : 
          variant === 'processing' ? 'bg-blue-500' : 
          'bg-current'
        }`} />
      )}
      {icon && <span className="mr-1">{icon}</span>}
      {children}
    </span>
  );
}
