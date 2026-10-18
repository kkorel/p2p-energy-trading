'use client';

import { useState } from 'react';
import { Flame, Star, TrendingDown, Zap } from 'lucide-react';
import type { TopDealsCardData } from '@/hooks/use-chat-engine';

interface TopDealsCardProps {
  data: TopDealsCardData;
  language?: string;
  onQuickBuy?: (offerId: string, quantity: number) => void;
  onCustomAmount?: () => void;
}

// Localized labels
const LABELS = {
  title: { en: 'Top Deals Today', hi: 'आज की सबसे अच्छी डील' },
  saveUpTo: { en: 'Save up to', hi: 'बचाओ' },
  vsDiscom: { en: 'vs DISCOM rate', hi: 'DISCOM से' },
  seller: { en: 'Seller', hi: 'विक्रेता' },
  save: { en: 'Save', hi: 'बचत' },
  total: { en: 'Total', hi: 'कुल' },
  unit: { en: 'units', hi: 'यूनिट' },
  perUnit: { en: '/unit', hi: '/यूनिट' },
  quickBuy: { en: 'Quick Buy', hi: 'जल्दी खरीदो' },
  customAmount: { en: 'Custom Amount', hi: 'अपनी मर्ज़ी से' },
  best: { en: 'Best', hi: 'बेस्ट' },
};

function getLabel(key: keyof typeof LABELS, isHindi: boolean): string {
  return isHindi ? LABELS[key].hi : LABELS[key].en;
}

// Energy type emoji mapping
const ENERGY_EMOJI: Record<string, string> = {
  SOLAR: '☀️',
  WIND: '💨',
  HYDRO: '💧',
  MIXED: '⚡',
  GRID: '🔌',
};

export function TopDealsCard({ data, language, onQuickBuy, onCustomAmount }: TopDealsCardProps) {
  const isHindi = language === 'hi-IN';
  const maxSavings = data.deals.length > 0 ? Math.max(...data.deals.map(d => d.savingsPercent)) : 0;

  // Don't render if no deals
  if (data.deals.length === 0) {
    return null;
  }

  return (
    <div className="bg-gradient-to-br from-teal-50 to-white rounded-2xl border border-teal-200 shadow-sm overflow-hidden my-2">
      {/* Header */}
      <div className="bg-gradient-to-r from-teal-600 to-teal-500 px-4 py-3 text-white">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center">
              <Flame className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-semibold text-base">{getLabel('title', isHindi)}</h3>
              <p className="text-teal-100 text-xs">
                {getLabel('saveUpTo', isHindi)} {maxSavings}% {getLabel('vsDiscom', isHindi)}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Deals List */}
      <div className="p-3 space-y-2">
        {data.deals.map((deal, index) => {
          const emoji = ENERGY_EMOJI[deal.energyType] || ENERGY_EMOJI.SOLAR;
          const totalPrice = Math.round(deal.quantity * deal.pricePerKwh);
          const trustStars = Math.round(deal.trustScore * 5);

          return (
            <div
              key={deal.offerId}
              className="p-3 rounded-xl border bg-white border-teal-100 hover:border-teal-300 hover:shadow-md transition-all"
            >
              {/* Top row: Energy type + quantity + price */}
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-lg">{emoji}</span>
                  <span className="font-semibold text-gray-900">
                    {deal.quantity} {getLabel('unit', isHindi)}
                  </span>
                  <span className="text-gray-500">@</span>
                  <span className="font-bold text-green-600">
                    ₹{deal.pricePerKwh}{getLabel('perUnit', isHindi)}
                  </span>
                </div>
                {index === 0 && (
                  <span className="px-2 py-0.5 bg-amber-100 text-amber-700 text-xs font-medium rounded-full">
                    {getLabel('best', isHindi)}
                  </span>
                )}
              </div>

              {/* Middle row: Seller + trust */}
              <div className="flex items-center gap-2 mb-2 text-sm text-gray-600">
                <span>{getLabel('seller', isHindi)}: {deal.providerName}</span>
                <div className="flex items-center gap-0.5">
                  <Star className="w-3 h-3 text-amber-500 fill-amber-500" />
                  <span className="text-amber-600">{(deal.trustScore * 5).toFixed(1)}</span>
                </div>
              </div>

              {/* Bottom row: Savings + Total + Quick Buy button */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 text-sm">
                  <div className="flex items-center gap-1 text-green-600">
                    <TrendingDown className="w-3.5 h-3.5" />
                    <span>{getLabel('save', isHindi)} {deal.savingsPercent}%</span>
                  </div>
                  <span className="text-gray-500">|</span>
                  <span className="text-gray-700">
                    {getLabel('total', isHindi)}: <span className="font-semibold">₹{totalPrice}</span>
                  </span>
                </div>
                <button
                  onClick={() => onQuickBuy?.(deal.offerId, deal.quantity)}
                  className="px-2.5 py-1 bg-teal-600 hover:bg-teal-700 text-white text-xs font-medium rounded-md transition-colors"
                >
                  {getLabel('quickBuy', isHindi)}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Custom Amount Button */}
      <div className="px-3 pb-3">
        <button
          onClick={onCustomAmount}
          className="w-full py-2.5 border-2 border-dashed border-teal-300 hover:border-teal-500 text-teal-700 hover:text-teal-800 font-medium rounded-xl transition-colors flex items-center justify-center gap-2"
        >
          <Zap className="w-4 h-4" />
          {getLabel('customAmount', isHindi)}
        </button>
      </div>
    </div>
  );
}
