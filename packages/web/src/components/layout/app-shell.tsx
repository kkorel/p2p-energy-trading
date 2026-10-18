'use client';

import { type ReactNode, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';
import { Header } from './header';
import { BottomNav } from './bottom-nav';
import { LoginScreen } from '@/components/auth/login-screen';
import { Skeleton } from '@/components/ui';

interface AppShellProps {
  children: ReactNode;
  title?: string;
  hideNav?: boolean;
}

export function AppShell({ children, title, hideNav = false }: AppShellProps) {
  const { isLoading, isAuthenticated, user } = useAuth();
  const router = useRouter();

  // Redirect to credentials page if profile not complete
  useEffect(() => {
    if (!isLoading && isAuthenticated && user && !user.profileComplete) {
      // Store userId for the credentials page
      sessionStorage.setItem('pendingUserId', user.id);
      router.push('/onboarding/credentials');
    }
  }, [isLoading, isAuthenticated, user, router]);

  // Loading state
  if (isLoading) {
    return (
      <div className="min-h-screen bg-[var(--color-bg)] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-[14px] bg-[var(--color-primary-light)] flex items-center justify-center">
            <Skeleton className="w-6 h-6 rounded-full" />
          </div>
          <Skeleton className="w-24 h-4" />
        </div>
      </div>
    );
  }

  // Not authenticated - show login
  if (!isAuthenticated) {
    return <LoginScreen />;
  }

  // Profile not complete - show loading while redirecting
  if (!user?.profileComplete) {
    return (
      <div className="min-h-screen bg-[var(--color-bg)] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-[14px] bg-[var(--color-primary-light)] flex items-center justify-center">
            <Skeleton className="w-6 h-6 rounded-full" />
          </div>
          <Skeleton className="w-24 h-4" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--color-surface)]">
      {/* Mobile canvas container */}
      <div className="max-w-[480px] mx-auto min-h-screen bg-[var(--color-bg)] shadow-[var(--shadow-sm)]">
        <Header title={title} />

        {/* Main content with padding for bottom nav */}
        <main className={hideNav ? '' : 'pb-20'}>
          <div className="px-4 py-4">{children}</div>
        </main>

        {!hideNav && <BottomNav />}
      </div>
    </div>
  );
}
