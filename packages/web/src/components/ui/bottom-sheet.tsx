'use client';

import { useEffect, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { X } from 'lucide-react';

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
}

export function BottomSheet({
  open,
  onClose,
  title,
  children,
  className,
}: BottomSheetProps) {
  // Prevent body scroll when open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  // Close on escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (open) {
      document.addEventListener('keydown', handleEscape);
    }
    return () => document.removeEventListener('keydown', handleEscape);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 animate-fade-in"
        onClick={onClose}
      />

      {/* Sheet - constrained to mobile width */}
      <div
        className={cn(
          'relative w-full max-w-[480px] bg-[var(--color-bg)] rounded-t-[20px] animate-slide-up max-h-[90vh] overflow-hidden flex flex-col',
          className
        )}
      >
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-2">
          <div className="w-10 h-1 bg-[var(--color-border)] rounded-full" />
        </div>

        {/* Header */}
        {title && (
          <div className="flex items-center justify-between px-4 pb-3 border-b border-[var(--color-border)]">
            <h2 className="text-lg font-semibold text-[var(--color-text)]">
              {title}
            </h2>
            <button
              onClick={onClose}
              className="p-2 -mr-2 text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors rounded-full hover:bg-[var(--color-surface)]"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 py-4">{children}</div>
      </div>
    </div>
  );
}
