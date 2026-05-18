import type { ReactNode } from 'react';
import { Sidebar } from './Sidebar';

interface LayoutProps {
  children: ReactNode;
}

// Thin shell — left nav, main content, no per-page chrome. Page
// components own their own panels.
export function Layout({ children }: LayoutProps) {
  return (
    <div className="min-h-screen flex bg-ink-900 text-ink-100">
      <Sidebar />
      <main className="flex-1 min-w-0 p-4 overflow-x-auto">
        {children}
      </main>
    </div>
  );
}
