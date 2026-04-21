'use client';

import { useState, ReactNode } from 'react';
import { Plus, Minus } from 'lucide-react';

interface AccordionProps {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  icon?: ReactNode;
  badge?: string;
  badgeColor?: string;
}

export function Accordion({
  title,
  children,
  defaultOpen = false,
  icon,
  badge,
}: AccordionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div
      style={{
        background: isOpen ? 'var(--paper-card)' : 'var(--paper-muted)',
        border: 'var(--border-w) solid var(--ink)',
        boxShadow: '3px 3px 0 var(--ink)',
      }}
    >
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-3 py-2 flex items-center justify-between transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          {icon && (
            <span
              className="inline-flex items-center justify-center w-6 h-6 shrink-0"
              style={{
                background: 'var(--ink)',
                color: '#fff',
                border: 'var(--border-w) solid var(--ink)',
              }}
            >
              {icon}
            </span>
          )}
          <span className="text-sm font-black uppercase tracking-wide text-[color:var(--ink)] truncate">
            {title}
          </span>
          {badge && (
            <span
              className="text-[10px] px-1.5 py-0.5 font-bold uppercase tracking-wider"
              style={{
                background: 'var(--ink)',
                color: '#fff',
                border: 'var(--border-w) solid var(--ink)',
              }}
            >
              {badge}
            </span>
          )}
        </div>
        {isOpen ? (
          <Minus className="h-4 w-4 text-[color:var(--ink)]" />
        ) : (
          <Plus className="h-4 w-4 text-[color:var(--ink)]" />
        )}
      </button>
      <div
        className={`transition-all duration-200 ease-in-out ${
          isOpen ? 'max-h-[3000px] opacity-100' : 'max-h-0 opacity-0 overflow-hidden'
        }`}
      >
        <div
          className="p-3"
          style={{ borderTop: 'var(--border-w) solid var(--ink)' }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
