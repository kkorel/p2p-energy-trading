'use client';

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { X, CheckCircle, AlertCircle, AlertTriangle, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration?: number;
}

interface ToastContextType {
  toasts: Toast[];
  showToast: (toast: Omit<Toast, 'id'>) => void;
  hideToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}

const toastIcons = {
  success: CheckCircle,
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
};

const toastStyles = {
  success: {
    bg: 'bg-[var(--color-success-light)]',
    border: 'border-[var(--color-success)]',
    icon: 'text-[var(--color-success)]',
    title: 'text-[var(--color-success)]',
  },
  error: {
    bg: 'bg-[var(--color-danger-light)]',
    border: 'border-[var(--color-danger)]',
    icon: 'text-[var(--color-danger)]',
    title: 'text-[var(--color-danger)]',
  },
  warning: {
    bg: 'bg-[var(--color-warning-light)]',
    border: 'border-[var(--color-warning)]',
    icon: 'text-[var(--color-warning)]',
    title: 'text-[var(--color-warning)]',
  },
  info: {
    bg: 'bg-[var(--color-primary-light)]',
    border: 'border-[var(--color-primary)]',
    icon: 'text-[var(--color-primary)]',
    title: 'text-[var(--color-primary)]',
  },
};

function ToastItem({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const Icon = toastIcons[toast.type];
  const styles = toastStyles[toast.type];

  useEffect(() => {
    const duration = toast.duration ?? 5000;
    if (duration > 0) {
      const timer = setTimeout(onClose, duration);
      return () => clearTimeout(timer);
    }
  }, [toast.duration, onClose]);

  return (
    <div
      className={cn(
        'flex items-start gap-3 p-4 rounded-xl border shadow-lg',
        'animate-in slide-in-from-top-2 fade-in duration-200',
        styles.bg,
        styles.border
      )}
    >
      <Icon className={cn('h-5 w-5 flex-shrink-0 mt-0.5', styles.icon)} />
      <div className="flex-1 min-w-0">
        <p className={cn('text-sm font-medium', styles.title)}>{toast.title}</p>
        {toast.message && (
          <p className="text-xs text-[var(--color-text-muted)] mt-1">{toast.message}</p>
        )}
      </div>
      <button
        onClick={onClose}
        className="flex-shrink-0 p-1 -mr-1 -mt-1 rounded-lg hover:bg-black/5 transition-colors"
      >
        <X className="h-4 w-4 text-[var(--color-text-muted)]" />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { ...toast, id }]);
  }, []);

  const hideToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toasts, showToast, hideToast }}>
      {children}
      {/* Toast container - fixed at top, centered with max width */}
      <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 w-full max-w-sm px-4 flex flex-col gap-2 pointer-events-none">
        {toasts.map((toast) => (
          <div key={toast.id} className="pointer-events-auto">
            <ToastItem toast={toast} onClose={() => hideToast(toast.id)} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
