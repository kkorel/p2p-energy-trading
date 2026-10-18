'use client';

import { useState } from 'react';

// India only - no country selection needed
const INDIA = { code: 'IN', name: 'India', dialCode: '+91', flag: '🇮🇳' };

interface PhoneInputProps {
  value: string;
  onChange: (value: string, fullNumber: string) => void;
  onBlur?: () => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

export function PhoneInput({
  value,
  onChange,
  onBlur,
  disabled,
  placeholder = '98765 43210',
  className = '',
}: PhoneInputProps) {
  const [localValue, setLocalValue] = useState(value);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Only allow digits and spaces
    const newValue = e.target.value.replace(/[^\d\s]/g, '');
    setLocalValue(newValue);

    // Build full number with +91 prefix
    const cleaned = newValue.replace(/\s/g, '');
    const fullNumber = normalizeIndianPhone(cleaned);

    onChange(newValue, fullNumber);
  };

  return (
    <div className={`relative flex ${className}`}>
      {/* Fixed India country display */}
      <div className="h-[44px] px-3 rounded-l-[12px] bg-[var(--color-surface)] border border-r-0 border-[var(--color-border)] flex items-center gap-1.5">
        <span className="text-lg">{INDIA.flag}</span>
        <span className="text-sm text-[var(--color-text-muted)] select-none whitespace-nowrap">
          {INDIA.dialCode}
        </span>
      </div>

      {/* Phone input */}
      <input
        type="tel"
        value={localValue}
        onChange={handleInputChange}
        onBlur={onBlur}
        placeholder={placeholder}
        disabled={disabled}
        className="flex-1 h-[44px] px-3 rounded-r-[12px] bg-[var(--color-surface)] border border-l-0 border-[var(--color-border)] text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent disabled:opacity-50"
      />
    </div>
  );
}

/**
 * Normalize an Indian phone number to +91 format
 * Handles: "9876543210", "91 9876543210", "+91 9876543210", "09876543210"
 */
export function normalizeIndianPhone(phone: string): string {
  // Remove all non-digits
  let cleaned = phone.replace(/\D/g, '');

  // Remove leading 0 if present
  if (cleaned.startsWith('0')) {
    cleaned = cleaned.slice(1);
  }

  // Remove 91 prefix if present (to avoid +9191...)
  if (cleaned.startsWith('91') && cleaned.length > 10) {
    cleaned = cleaned.slice(2);
  }

  // Take last 10 digits if still longer
  if (cleaned.length > 10) {
    cleaned = cleaned.slice(-10);
  }

  // Add +91 prefix
  return '+91' + cleaned;
}

/**
 * Utility to format phone for API (India only)
 */
export function formatPhoneForAPI(phone: string): string {
  return normalizeIndianPhone(phone);
}
