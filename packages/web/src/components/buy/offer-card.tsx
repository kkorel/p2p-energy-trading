'use client';

import { Sun, Wind, Droplets, Sparkles, Clock, Zap } from 'lucide-react';
import { Card, Badge } from '@/components/ui';
import { formatCurrency, formatDateTime, cn } from '@/lib/utils';
import type { Offer } from '@/lib/api';

const sourceIcons: Record<string, typeof Sun> = {
  SOLAR: Sun,
  WIND: Wind,
  HYDRO: Droplets,
  MIXED: Sparkles,
};

const sourceColors: Record<string, string> = {
  SOLAR: 'bg-amber-50 text-amber-600',
  WIND: 'bg-sky-50 text-sky-600',
  HYDRO: 'bg-blue-50 text-blue-600',
  MIXED: 'bg-purple-50 text-purple-600',
};

interface OfferCardProps {
  offer: Offer;
  providerName: string;
  sourceType: string;
  availableQty: number;
  score?: number;
  matchesFilters?: boolean;
  filterReasons?: string[];
  scoreBreakdown?: {
    priceScore: number;
    trustScore: number;
    timeWindowFitScore: number;
  };
  isSelected?: boolean;
  onSelect: () => void;
}

export function OfferCard({
  offer,
  providerName,
  sourceType,
  availableQty,
  score,
  matchesFilters = true,
  filterReasons,
  scoreBreakdown,
  isSelected,
  onSelect,
}: OfferCardProps) {
  const Icon = sourceIcons[sourceType] || Sparkles;
  const colorClass = sourceColors[sourceType] || sourceColors.MIXED;

  return (
    <Card
      interactive
      onClick={onSelect}
      className={cn(
        'transition-all duration-[120ms]',
        isSelected && 'ring-2 ring-[var(--color-primary)] border-transparent'
      )}
    >
      {/* Header - Side by side like skeleton */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className={cn('w-9 h-9 rounded-[10px] flex items-center justify-center', colorClass)}>
            <Icon className="h-4 w-4" />
          </div>
          <p className="text-sm font-medium text-[var(--color-text)]">
            {providerName}
          </p>
        </div>

        <div className="text-right">
          <p className="text-base font-semibold text-[var(--color-primary)]">
            {formatCurrency(offer.price.value)}
          </p>
          <p className="text-xs text-[var(--color-text-muted)]">per kWh</p>
        </div>
      </div>

      {/* Time window */}
      <div className="flex items-center gap-1.5 mb-3 text-xs text-[var(--color-text-secondary)]">
        <Clock className="h-3.5 w-3.5" />
        <span>
          {offer.timeWindow
            ? `${formatDateTime(offer.timeWindow.startTime)} - ${formatDateTime(offer.timeWindow.endTime)}`
            : 'Flexible timing'
          }
        </span>
      </div>

      {/* Footer badges */}
      <div className="flex items-center flex-wrap gap-2">
        <Badge variant="default">{sourceType}</Badge>
        <Badge variant="success">{availableQty} kWh available</Badge>
        {score !== undefined && (
          <Badge variant={matchesFilters ? 'primary' : 'warning'}>
            {Math.round(score * 100)}% match
          </Badge>
        )}
      </div>

      {/* Filter warning if not matching */}
      {!matchesFilters && filterReasons && filterReasons.length > 0 && (
        <div className="mt-2 p-2 bg-amber-50 rounded-lg">
          <p className="text-xs text-amber-700 font-medium">Does not match your criteria:</p>
          <ul className="mt-1 text-xs text-amber-600 list-disc list-inside">
            {filterReasons.map((reason, idx) => (
              <li key={idx}>{reason}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Score breakdown - show if available */}
      {scoreBreakdown && score !== undefined && (
        <div className="mt-3 pt-3 border-t border-[var(--color-border)]">
          <p className="text-xs font-medium text-[var(--color-text-muted)] mb-2">Match Score Breakdown</p>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-[var(--color-text-muted)]">Price</span>
              <div className="flex items-center gap-2">
                <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-[var(--color-primary)]" 
                    style={{ width: `${Math.round(scoreBreakdown.priceScore * 100)}%` }}
                  />
                </div>
                <span className="font-medium text-[var(--color-text)] w-8 text-right">{Math.round(scoreBreakdown.priceScore * 100)}%</span>
              </div>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-[var(--color-text-muted)]">Trust</span>
              <div className="flex items-center gap-2">
                <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-[var(--color-success)]" 
                    style={{ width: `${Math.round(scoreBreakdown.trustScore * 100)}%` }}
                  />
                </div>
                <span className="font-medium text-[var(--color-text)] w-8 text-right">{Math.round(scoreBreakdown.trustScore * 100)}%</span>
              </div>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-[var(--color-text-muted)]">Time Fit</span>
              <div className="flex items-center gap-2">
                <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-[var(--color-warning)]" 
                    style={{ width: `${Math.round(scoreBreakdown.timeWindowFitScore * 100)}%` }}
                  />
                </div>
                <span className="font-medium text-[var(--color-text)] w-8 text-right">{Math.round(scoreBreakdown.timeWindowFitScore * 100)}%</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
