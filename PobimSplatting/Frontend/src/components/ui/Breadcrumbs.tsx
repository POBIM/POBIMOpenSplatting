'use client';

import Link from 'next/link';
import { ChevronRight, Home } from 'lucide-react';

interface BreadcrumbItem {
  label: string;
  href?: string;
}

interface BreadcrumbsProps {
  items: BreadcrumbItem[];
}

export function Breadcrumbs({ items }: BreadcrumbsProps) {
  return (
    <nav className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider mb-4">
      <Link
        href="/"
        className="inline-flex items-center justify-center w-6 h-6 transition-all hover:-translate-x-0.5 hover:-translate-y-0.5"
        style={{
          background: 'var(--paper-card)',
          color: 'var(--ink)',
          border: 'var(--border-w) solid var(--ink)',
          boxShadow: '2px 2px 0 var(--ink)',
        }}
      >
        <Home className="h-3 w-3" />
      </Link>
      {items.map((item) => (
        <div key={`${item.label}-${item.href ?? 'current'}`} className="flex items-center gap-1.5">
          <ChevronRight className="h-3 w-3 text-[color:var(--text-muted)]" />
          {item.href ? (
            <Link
              href={item.href}
              className="px-1.5 py-0.5 text-[color:var(--text-secondary)] hover:text-[color:var(--ink)] hover:bg-[color:var(--paper-muted)] transition-colors"
            >
              {item.label}
            </Link>
          ) : (
            <span
              className="px-1.5 py-0.5"
              style={{
                background: 'var(--ink)',
                color: '#fff',
              }}
            >
              {item.label}
            </span>
          )}
        </div>
      ))}
    </nav>
  );
}
