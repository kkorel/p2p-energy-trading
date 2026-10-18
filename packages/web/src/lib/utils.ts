import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(value: number, currency = 'INR'): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatNumber(value: number, decimals = 1): string {
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  }).format(value);
}

export function formatTime(isoString: string | null | undefined): string {
  if (!isoString) return 'N/A';
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return 'N/A';
  return date.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString('en-IN', {
    month: 'short',
    day: 'numeric',
  });
}

export function formatDateTime(isoString: string): string {
  return new Date(isoString).toLocaleString('en-IN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function truncateId(id: string, length = 8): string {
  if (id.length <= length) return id;
  return `${id.slice(0, length)}...`;
}
