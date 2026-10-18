'use client';

import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { ChevronDown } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  options: SelectOption[];
  placeholder?: string;
}

const Select = forwardRef<HTMLSelectElement, SelectProps>(
  (
    { className, label, error, options, placeholder, id, ...props },
    ref
  ) => {
    const selectId = id || label?.toLowerCase().replace(/\s+/g, '-');

    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label
            htmlFor={selectId}
            className="text-sm font-medium text-[var(--color-text)]"
          >
            {label}
          </label>
        )}
        <div className="relative">
          <select
            ref={ref}
            id={selectId}
            className={cn(
              'h-11 w-full appearance-none rounded-[12px] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 pr-10 text-base text-[var(--color-text)] transition-all duration-[120ms] ease-out cursor-pointer',
              'hover:border-[var(--color-text-muted)]',
              'focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:ring-offset-0 focus:border-transparent',
              'disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-[var(--color-surface)]',
              error && 'border-[var(--color-danger)] focus:ring-[var(--color-danger)]',
              className
            )}
            {...props}
          >
            {placeholder && (
              <option value="" disabled>
                {placeholder}
              </option>
            )}
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-text-muted)] pointer-events-none" />
        </div>
        {error && (
          <p className="text-sm text-[var(--color-danger)]">{error}</p>
        )}
      </div>
    );
  }
);

Select.displayName = 'Select';

export { Select };
