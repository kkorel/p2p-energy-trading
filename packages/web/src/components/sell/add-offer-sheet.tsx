'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { BottomSheet, Button, Input, Select } from '@/components/ui';

type OfferFormInput = {
  source_type: string;
  price_per_kwh: string;
  max_qty: string;
  startTime: string;
  endTime: string;
};

interface AddOfferSheetProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: {
    source_type: string;
    price_per_kwh: number;
    max_qty: number;
    time_window: { startTime: string; endTime: string };
  }) => Promise<void>;
}

const sourceTypeOptions = [
  { value: 'SOLAR', label: 'Solar Energy' },
  { value: 'WIND', label: 'Wind Energy' },
  { value: 'HYDRO', label: 'Hydro Energy' },
];

export function AddOfferSheet({ open, onClose, onSubmit }: AddOfferSheetProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<OfferFormInput>({
    defaultValues: {
      source_type: 'SOLAR',
      price_per_kwh: '6',
      max_qty: '30',
      startTime: getDefaultStartTime(),
      endTime: getDefaultEndTime(),
    },
  });

  const handleFormSubmit = async (data: OfferFormInput) => {
    setIsLoading(true);
    setError(null);
    
    try {
      const startTime = new Date(data.startTime);
      const endTime = new Date(data.endTime);
      
      // Validate that end time is after start time
      if (endTime <= startTime) {
        setError('"Available Until" must be after "Available From"');
        setIsLoading(false);
        return;
      }
      
      await onSubmit({
        source_type: data.source_type,
        price_per_kwh: parseFloat(data.price_per_kwh),
        max_qty: parseInt(data.max_qty, 10),
        time_window: {
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
        },
      });
      reset();
      onClose();
    } catch (err: any) {
      console.error('Failed to add offer:', err);
      setError(err.message || 'Failed to create offer');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <BottomSheet open={open} onClose={onClose} title="Create Offer">
      <form onSubmit={handleSubmit(handleFormSubmit)} className="flex flex-col gap-4">
        {error && (
          <div className="p-3 rounded-[12px] bg-[var(--color-danger-light)] text-sm text-[var(--color-danger)]">
            {error}
          </div>
        )}

        {/* Energy Type */}
        <Select
          label="Energy Type"
          options={sourceTypeOptions}
          {...register('source_type', { required: 'Select energy type' })}
          error={errors.source_type?.message}
        />

        {/* Price */}
        <Input
          label="Price per kWh (₹)"
          type="number"
          step="0.50"
          min={1}
          max={50}
          leftIcon={<span className="text-sm">₹</span>}
          {...register('price_per_kwh', { required: 'Required', min: { value: 1, message: 'Min ₹1' }, max: { value: 50, message: 'Max ₹50' } })}
          error={errors.price_per_kwh?.message}
        />

        {/* Quantity */}
        <Input
          label="Quantity (kWh)"
          type="number"
          min={1}
          max={10000}
          {...register('max_qty', { required: 'Required', min: { value: 1, message: 'Min 1 kWh' } })}
          error={errors.max_qty?.message}
          hint="How much energy you want to sell"
        />

        {/* Time Window */}
        <div className="flex flex-col gap-3">
          <Input
            label="Available From"
            type="datetime-local"
            {...register('startTime', { required: 'Required' })}
            error={errors.startTime?.message}
          />
          <Input
            label="Available Until"
            type="datetime-local"
            {...register('endTime', { required: 'Required' })}
            error={errors.endTime?.message}
          />
        </div>

        {/* Submit */}
        <Button type="submit" fullWidth loading={isLoading}>
          Create Offer
        </Button>
      </form>
    </BottomSheet>
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
