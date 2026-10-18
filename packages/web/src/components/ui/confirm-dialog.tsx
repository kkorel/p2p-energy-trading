'use client';

import React, { createContext, useContext, useState, useCallback } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './button';

interface ConfirmOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'primary';
}

interface ConfirmContextType {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextType | undefined>(undefined);

export function useConfirm() {
  const context = useContext(ConfirmContext);
  if (!context) {
    throw new Error('useConfirm must be used within a ConfirmProvider');
  }
  return context;
}

interface DialogState extends ConfirmOptions {
  isOpen: boolean;
  resolve: ((value: boolean) => void) | null;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [dialog, setDialog] = useState<DialogState>({
    isOpen: false,
    title: '',
    message: '',
    resolve: null,
  });

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      setDialog({
        isOpen: true,
        ...options,
        resolve,
      });
    });
  }, []);

  const handleClose = useCallback((result: boolean) => {
    dialog.resolve?.(result);
    setDialog((prev) => ({ ...prev, isOpen: false, resolve: null }));
  }, [dialog.resolve]);

  const variant = dialog.variant || 'danger';
  const variantStyles = {
    danger: {
      icon: 'bg-[var(--color-danger-light)] text-[var(--color-danger)]',
      button: 'danger' as const,
    },
    warning: {
      icon: 'bg-[var(--color-warning-light)] text-[var(--color-warning)]',
      button: 'primary' as const,
    },
    primary: {
      icon: 'bg-[var(--color-primary-light)] text-[var(--color-primary)]',
      button: 'primary' as const,
    },
  };

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      
      {/* Backdrop */}
      {dialog.isOpen && (
        <div 
          className="fixed inset-0 z-50 bg-black/50 animate-in fade-in duration-200"
          onClick={() => handleClose(false)}
        />
      )}
      
      {/* Dialog */}
      {dialog.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
          <div 
            className={cn(
              'w-full max-w-sm bg-white rounded-2xl shadow-xl pointer-events-auto',
              'animate-in zoom-in-95 slide-in-from-bottom-4 duration-200'
            )}
            style={{ backgroundColor: 'white' }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-start gap-3 p-4 pb-2">
              <div className={cn(
                'w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0',
                variantStyles[variant].icon
              )}>
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-semibold text-[var(--color-text)]">
                  {dialog.title}
                </h3>
              </div>
              <button
                onClick={() => handleClose(false)}
                className="p-1 -mr-1 -mt-1 rounded-lg hover:bg-[var(--color-surface)] transition-colors"
              >
                <X className="w-5 h-5 text-[var(--color-text-muted)]" />
              </button>
            </div>
            
            {/* Body */}
            <div className="px-4 pb-4">
              <p className="text-sm text-[var(--color-text-muted)] whitespace-pre-line">
                {dialog.message}
              </p>
            </div>
            
            {/* Footer */}
            <div className="flex gap-3 p-4 pt-2 border-t border-[var(--color-border)]">
              <Button
                variant="secondary"
                size="md"
                fullWidth
                onClick={() => handleClose(false)}
              >
                {dialog.cancelText || 'Cancel'}
              </Button>
              <Button
                variant={variantStyles[variant].button}
                size="md"
                fullWidth
                onClick={() => handleClose(true)}
              >
                {dialog.confirmText || 'Confirm'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
