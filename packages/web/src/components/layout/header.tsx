'use client';

import { useAuth } from '@/contexts/auth-context';
import { useBalance } from '@/contexts/balance-context';
import { useP2PStats } from '@/contexts/p2p-stats-context';
import { Zap, Wallet, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import { formatCurrency } from '@/lib/utils';

interface HeaderProps {
  title?: string;
}

export function Header({ title }: HeaderProps) {
  const { user } = useAuth();
  const { balance } = useBalance();
  const { totalValue, isLoading: statsLoading } = useP2PStats();

  return (
    <header className="sticky top-0 z-30 bg-[var(--color-bg)]/95 backdrop-blur-sm border-b border-[var(--color-border)]">
      <div className="flex items-center justify-between h-14 px-4">
        {/* Logo and title */}
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center w-8 h-8 bg-[var(--color-primary-light)] rounded-[10px]">
            <Zap className="h-4 w-4 text-[var(--color-primary)]" />
          </div>
          <span className="text-base font-semibold text-[var(--color-text)]">
            {title || 'EnergyTrade'}
          </span>
        </div>

        {/* Balance and Profile */}
        {user && (
          <div className="flex items-center gap-2">
            {/* P2P Value display */}
            {!statsLoading && (
              <Link
                href="/profile"
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full transition-colors ${
                  totalValue >= 0
                    ? 'bg-[var(--color-success-light)] hover:bg-[var(--color-success)]/20'
                    : 'bg-[var(--color-error)]/10 hover:bg-[var(--color-error)]/20'
                }`}
                title="P2P Trading Value"
              >
                <TrendingUp className={`h-3.5 w-3.5 ${
                  totalValue >= 0 ? 'text-[var(--color-success)]' : 'text-[var(--color-error)]'
                }`} />
                <span className={`text-xs font-semibold whitespace-nowrap ${
                  totalValue >= 0 ? 'text-[var(--color-success)]' : 'text-[var(--color-error)]'
                }`}>
                  {totalValue > 0 ? '+' : ''}{formatCurrency(totalValue)}
                </span>
              </Link>
            )}

            {/* Balance display */}
            <Link
              href="/profile"
              className="flex items-center gap-1.5 px-2.5 py-1.5 bg-[var(--color-surface)] rounded-full hover:bg-[var(--color-border-subtle)] transition-colors"
              title="Wallet Balance"
            >
              <Wallet className="h-3.5 w-3.5 text-[var(--color-primary)]" />
              <span className="text-sm font-semibold text-[var(--color-text)]">
                {formatCurrency(balance)}
              </span>
            </Link>

            {/* Profile avatar */}
            <Link
              href="/profile"
              className="flex items-center gap-2 rounded-full transition-opacity hover:opacity-80"
            >
              <div className="w-8 h-8 bg-[var(--color-primary-light)] rounded-full flex items-center justify-center">
                <span className="text-sm font-medium text-[var(--color-primary)]">
                  {user.name?.[0]?.toUpperCase() || '#'}
                </span>
              </div>
            </Link>
          </div>
        )}
      </div>
    </header>
  );
}
