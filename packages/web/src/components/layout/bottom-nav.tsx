'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { ShoppingCart, Store, ShoppingBag, User } from 'lucide-react';
import { cn } from '@/lib/utils';

const navItems = [
  {
    href: '/buy',
    label: 'Buy',
    icon: ShoppingCart,
  },
  {
    href: '/sell',
    label: 'Sell',
    icon: Store,
  },
  {
    href: '/orders',
    label: 'Orders',
    icon: ShoppingBag,
  },
  {
    href: '/profile',
    label: 'Profile',
    icon: User,
  },
];

export function BottomNav() {
  const pathname = usePathname();

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 flex justify-center pb-[env(safe-area-inset-bottom)]">
      <nav className="w-full max-w-[480px] mx-4 mb-4 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-2xl shadow-lg">
        <div className="flex items-center justify-around h-16 px-4">
          {navItems.map((item) => {
            const isActive = pathname.startsWith(item.href);
            const Icon = item.icon;

            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex flex-col items-center justify-center gap-1 min-w-[64px] h-11 rounded-[12px] transition-all duration-[120ms] ease-out',
                  isActive
                    ? 'text-[var(--color-primary)]'
                    : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
                )}
              >
                <Icon
                  className={cn(
                    'h-5 w-5 transition-transform duration-[120ms]',
                    isActive && 'scale-110'
                  )}
                  strokeWidth={isActive ? 2.5 : 2}
                />
                <span className="text-[10px] font-medium">{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
