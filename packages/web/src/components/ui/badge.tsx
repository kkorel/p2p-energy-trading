'use client';

import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'success' | 'danger' | 'warning' | 'primary';
  size?: 'sm' | 'md';
}

const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant = 'default', size = 'sm', children, ...props }, ref) => {
    const variants = {
      default: 'bg-[var(--color-surface)] text-[var(--color-text-secondary)]',
      primary: 'bg-[var(--color-primary-light)] text-[var(--color-primary)]',
      success: 'bg-[var(--color-success-light)] text-[var(--color-success)]',
      danger: 'bg-[var(--color-danger-light)] text-[var(--color-danger)]',
      warning: 'bg-[var(--color-warning-light)] text-[var(--color-warning)]',
    };

    const sizes = {
      sm: 'px-2 py-0.5 text-xs',
      md: 'px-2.5 py-1 text-sm',
    };

    return (
      <span
        ref={ref}
        className={cn(
          'inline-flex items-center font-medium rounded-full whitespace-nowrap',
          variants[variant],
          sizes[size],
          className
        )}
        {...props}
      >
        {children}
      </span>
    );
  }
);

Badge.displayName = 'Badge';

export { Badge };
