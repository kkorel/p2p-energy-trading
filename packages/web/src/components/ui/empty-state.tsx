'use client';

import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center py-12 px-4',
        className
      )}
    >
      {icon && (
        <div className="mb-4 text-[var(--color-text-muted)]">{icon}</div>
      )}
      <h3 className="text-base font-medium text-[var(--color-text)] mb-1">
        {title}
      </h3>
      {description && (
        <p className="text-sm text-[var(--color-text-muted)] mb-4 max-w-[280px]">
          {description}
        </p>
      )}
      {action && (
        <Button variant="secondary" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
