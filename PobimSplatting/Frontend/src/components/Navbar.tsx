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
    <nav className="sticky top-0 z-50 h-16 bg-white border-b border-gray-200 shadow-sm">
      <div className="max-w-7xl mx-auto px-8">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <h1 className="text-xl font-bold text-black">
                PobimSplatting
              </h1>
            </div>
            <div className="ml-12 flex items-baseline space-x-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                      isActive
                        ? 'bg-black text-white'
                        : 'text-gray-600 hover:bg-gray-50 hover:text-black'
                    }`}
                  >
                    <Icon className="w-4 h-4 mr-2" />
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </div>
          <div className="flex items-center space-x-4">
            <StatusIndicator />
          </div>
        </div>
      </div>
    </nav>
  );
}

function StatusIndicator() {
  return (
    <div className="flex items-center space-x-2 px-3 py-1.5 rounded-full" style={{
      backgroundColor: 'var(--success-bg)',
      border: '1px solid var(--success-border)'
    }}>
      <div className="w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: 'var(--success-icon)' }}></div>
      <span className="text-xs font-medium" style={{ color: 'var(--success-text)' }}>Online</span>
    </div>
  );
}
