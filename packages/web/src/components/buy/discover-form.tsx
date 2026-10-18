'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Zap, Sun, Wind, Droplets, Sparkles, List } from 'lucide-react';
import { Button, Input, Card } from '@/components/ui';
import { cn } from '@/lib/utils';

const sourceTypes = [
  { value: '', label: 'Any', icon: Sparkles },
  { value: 'SOLAR', label: 'Solar', icon: Sun },
  { value: 'WIND', label: 'Wind', icon: Wind },
  { value: 'HYDRO', label: 'Hydro', icon: Droplets },
];

type DiscoverFormInput = {
  quantity: string;
  startTime: string;
  endTime: string;
};

interface DiscoverFormProps {
  onSmartBuy: (data: {
    sourceType?: string;
    quantity: number;
    timeWindow: { startTime: string; endTime: string };
  }) => Promise<void>;
  onBrowse?: (data: {
    sourceType?: string;
    timeWindow: { startTime: string; endTime: string };
  }) => void;
  isLoading: boolean;
}

export function DiscoverForm({
  onSmartBuy,
  onBrowse,
  isLoading,
}: DiscoverFormProps) {
  const [sourceType, setSourceType] = useState('');

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<DiscoverFormInput>({
    defaultValues: {
      quantity: '50',
      startTime: getDefaultStartTime(),
      endTime: getDefaultEndTime(),
    },
  });

  // Watch startTime to validate endTime
  const startTimeValue = watch('startTime');

  const onSubmit = async (data: DiscoverFormInput) => {
    const qty = parseInt(data.quantity, 10);
    if (isNaN(qty) || qty < 1) return;

    // datetime-local gives value like "2026-02-05T14:00" (no timezone)
    // Treat user's input as the intended UTC time to avoid timezone confusion
    // Append :00.000Z to make it a proper ISO string in UTC
    const startTimeUTC = data.startTime + ':00.000Z';
    const endTimeUTC = data.endTime + ':00.000Z';

    console.log('[DEBUG] Time conversion:', {
      rawStart: data.startTime,
      rawEnd: data.endTime,
      startTimeUTC,
      endTimeUTC,
      browserTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });

    await onSmartBuy({
      sourceType: sourceType || undefined,
      quantity: qty,
      timeWindow: {
        startTime: startTimeUTC,
        endTime: endTimeUTC,
      },
    });
  };

  return (
    <Card>
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
        {/* Source Type Pills */}
        <div>
          <label className="text-sm font-medium text-[var(--color-text)] mb-2 block">
            Energy Source
          </label>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {sourceTypes.map((type) => {
              const Icon = type.icon;
              const isSelected = sourceType === type.value;
              return (
                <button
                  key={type.value}
                  type="button"
                  onClick={() => setSourceType(type.value)}
                  className={cn(
                    'flex items-center gap-1.5 px-3 h-9 rounded-full text-sm font-medium whitespace-nowrap transition-all duration-[120ms]',
                    isSelected
                      ? 'bg-[var(--color-primary)] text-white'
                      : 'bg-[var(--color-surface)] text-[var(--color-text-secondary)] border border-[var(--color-border)] hover:border-[var(--color-text-muted)]'
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {type.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Quantity */}
        <Input
          label="Quantity (kWh)"
          type="number"
          min={1}
          max={5000}
          {...register('quantity', {
            required: 'Required',
            min: { value: 1, message: 'Min 1 kWh' },
          })}
          error={errors.quantity?.message}
          hint="We'll find the best offer(s) to fulfill your order"
        />

        {/* Time Window */}
        <div className="flex flex-col gap-3">
          <Input
            label="Start Time"
            type="datetime-local"
            {...register('startTime', { required: 'Required' })}
            error={errors.startTime?.message}
          />
          <Input
            label="End Time"
            type="datetime-local"
            {...register('endTime', {
              required: 'Required',
              validate: (value) => {
                if (!startTimeValue || !value) return true;
                const start = new Date(startTimeValue);
                const end = new Date(value);
                if (end <= start) {
                  return 'End time must be after start time';
                }
                return true;
              },
            })}
            error={errors.endTime?.message}
          />
        </div>

        {/* Submit */}
        <Button type="submit" fullWidth loading={isLoading}>
          <Zap className="h-4 w-4" />
          Find Best Deal
        </Button>

        {/* Browse option */}
        {onBrowse && (
          <button
            type="button"
            onClick={() => {
              const startTimeUTC = startTimeValue + ':00.000Z';
              const endTimeUTC = watch('endTime') + ':00.000Z';
              onBrowse({
                sourceType: sourceType || undefined,
                timeWindow: { startTime: startTimeUTC, endTime: endTimeUTC },
              });
            }}
            disabled={isLoading}
            className="flex items-center justify-center gap-1.5 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-primary)] transition-colors"
          >
            <List className="h-4 w-4" />
            Or browse all offers manually
          </button>
        )}
      </form>
    </Card>
  );
}

function getDefaultStartTime(): string {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  now.setHours(now.getHours() + 5); // T+5 hours (rounded up)
  return toLocalISOString(now);
}

function getDefaultEndTime(): string {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  now.setHours(now.getHours() + 9); // T+9 hours
  return toLocalISOString(now);
}

function toLocalISOString(date: Date): string {
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}
