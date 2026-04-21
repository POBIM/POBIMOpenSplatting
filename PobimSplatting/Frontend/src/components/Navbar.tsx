'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, Upload, FolderOpen, Settings, Activity, QrCode } from 'lucide-react';

const navItems = [
  { href: '/', label: 'Dashboard', icon: Home },
  { href: '/upload', label: 'Upload', icon: Upload },
  { href: '/projects', label: 'Projects', icon: FolderOpen },
  { href: '/markers', label: 'Markers', icon: QrCode },
  { href: '/viewer', label: 'Viewer', icon: Activity },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export default function Navbar() {
  const pathname = usePathname();

  return (
    <nav
      className="sticky top-0 z-50 flex items-center"
      style={{
        height: 'var(--navbar-height)',
        background: 'var(--paper-card)',
        borderBottom: 'var(--border-w) solid var(--ink)',
      }}
    >
      <div className="brutal-container flex items-center justify-between px-4 md:px-6 w-full">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2 group">
            <span
              className="inline-flex items-center justify-center w-7 h-7 text-[13px] font-black uppercase"
              style={{
                background: 'var(--ink)',
                color: '#fff',
                border: 'var(--border-w) solid var(--ink)',
                boxShadow: '2px 2px 0 var(--ink-shadow-soft)',
                transform: 'rotate(-3deg)',
              }}
            >
              P
            </span>
            <span className="text-sm font-black uppercase tracking-wider text-[color:var(--ink)]">
              POBIM<span className="text-[color:var(--text-muted)]">/SPLAT</span>
            </span>
          </Link>

          <div className="hidden md:flex items-center gap-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = pathname === item.href || (item.href !== '/' && pathname?.startsWith(item.href));
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="group relative inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider transition-colors"
                  style={{
                    color: isActive ? '#fff' : 'var(--text-secondary)',
                    background: isActive ? 'var(--ink)' : 'transparent',
                    border: `var(--border-w) solid ${isActive ? 'var(--ink)' : 'transparent'}`,
                    boxShadow: isActive ? '2px 2px 0 var(--ink)' : 'none',
                  }}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <StatusIndicator />
        </div>
      </div>
    </nav>
  );
}

function StatusIndicator() {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
      style={{
        background: 'var(--success-bg)',
        color: 'var(--success-text)',
        border: 'var(--border-w) solid var(--ink)',
        boxShadow: '2px 2px 0 var(--ink)',
      }}
    >
      <span
        className="w-1.5 h-1.5 brutal-pulse"
        style={{ background: 'var(--success-icon)' }}
      />
      Online
    </span>
  );
}
