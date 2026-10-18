'use client';

import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    { className, label, error, hint, leftIcon, rightIcon, id, ...props },
    ref
  ) => {
    const inputId = id || label?.toLowerCase().replace(/\s+/g, '-');

    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label
            htmlFor={inputId}
            className="text-sm font-medium text-[var(--color-text)]"
          >
            {label}
          </label>
        )}
        <div className="relative">
          {leftIcon && (
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]">
              {leftIcon}
            </div>
          )}
          <input
            ref={ref}
            id={inputId}
            className={cn(
              'h-11 w-full rounded-[12px] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-base text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] transition-all duration-[120ms] ease-out',
              'hover:border-[var(--color-text-muted)]',
              'focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:ring-offset-0 focus:border-transparent',
              'disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-[var(--color-surface)]',
              error && 'border-[var(--color-danger)] focus:ring-[var(--color-danger)]',
              leftIcon && 'pl-10',
              rightIcon && 'pr-10',
              className
            )}
            {...props}
          />
          {rightIcon && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]">
              {rightIcon}
            </div>
          )}
        </div>
        {error && (
          <p className="text-sm text-[var(--color-danger)]">{error}</p>
        )}
        {hint && !error && (
          <p className="text-sm text-[var(--color-text-muted)]">{hint}</p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';

export { Input };
