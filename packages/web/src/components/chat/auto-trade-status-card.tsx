'use client';

import { Battery, ShoppingCart, Clock, TrendingUp, CloudSun } from 'lucide-react';
import type { AutoTradeStatusData } from '@/hooks/use-chat-engine';

interface AutoTradeStatusCardProps {
  data: AutoTradeStatusData;
  language?: string;
}

export function AutoTradeStatusCard({ data, language = 'en-IN' }: AutoTradeStatusCardProps) {
  const isHindi = language === 'hi-IN';

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString(language, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'success':
        return 'text-green-600 bg-green-50';
      case 'warning_oversell':
        return 'text-amber-600 bg-amber-50';
      case 'skipped':
        return 'text-gray-600 bg-gray-50';
      case 'error':
        return 'text-red-600 bg-red-50';
      default:
        return 'text-gray-600 bg-gray-50';
    }
  };

  const getStatusLabel = (status: string) => {
    const labels: Record<string, { en: string; hi: string }> = {
      success: { en: 'Success', hi: 'सफल' },
      warning_oversell: { en: 'Warning', hi: 'चेतावनी' },
      skipped: { en: 'Skipped', hi: 'छोड़ा' },
      error: { en: 'Error', hi: 'त्रुटि' },
      no_deals: { en: 'No deals', hi: 'कोई डील नहीं' },
      price_too_high: { en: 'Price high', hi: 'दाम ज़्यादा' },
    };
    return labels[status]?.[isHindi ? 'hi' : 'en'] || status;
  };

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      {/* Seller Status */}
      {data.seller && (
        <div className="p-4 border-b border-gray-100">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center">
              <Battery className="w-4 h-4 text-amber-600" />
            </div>
            <div>
              <h3 className="font-semibold text-gray-900">
                {isHindi ? 'ऑटो-सेल' : 'Auto-Sell'}
              </h3>
              <span className="text-xs text-green-600 font-medium">
                {isHindi ? 'चालू' : 'Active'}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="bg-gray-50 rounded-lg p-2.5">
              <p className="text-xs text-gray-500 mb-0.5">
                {isHindi ? 'क्षमता' : 'Capacity'}
              </p>
              <p className="font-semibold text-gray-900">
                {data.seller.capacityKwh} units
              </p>
            </div>
            <div className="bg-gray-50 rounded-lg p-2.5">
              <p className="text-xs text-gray-500 mb-0.5">
                {isHindi ? 'दाम' : 'Price'}
              </p>
              <p className="font-semibold text-gray-900">
                ₹{data.seller.pricePerKwh}/unit
              </p>
            </div>
          </div>

          {data.seller.lastRun && (
            <div className="mt-3 pt-3 border-t border-gray-100">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Clock className="w-3.5 h-3.5 text-gray-400" />
                  <span className="text-xs text-gray-500">
                    {formatDate(data.seller.lastRun.executedAt)}
                  </span>
                </div>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${getStatusColor(data.seller.lastRun.status)}`}>
                  {getStatusLabel(data.seller.lastRun.status)}
                </span>
              </div>
              <div className="flex items-center gap-4 mt-2">
                <div className="flex items-center gap-1.5">
                  <TrendingUp className="w-3.5 h-3.5 text-gray-400" />
                  <span className="text-sm text-gray-700">
                    {data.seller.lastRun.listedQuantity} units
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <CloudSun className="w-3.5 h-3.5 text-gray-400" />
                  <span className="text-sm text-gray-700">
                    {Math.round(data.seller.lastRun.weatherMultiplier * 100)}% {isHindi ? 'मौसम' : 'weather'}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Buyer Status */}
      {data.buyer && (
        <div className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-8 h-8 rounded-full bg-teal-100 flex items-center justify-center">
              <ShoppingCart className="w-4 h-4 text-teal-600" />
            </div>
            <div>
              <h3 className="font-semibold text-gray-900">
                {isHindi ? 'ऑटो-बाय' : 'Auto-Buy'}
              </h3>
              <span className="text-xs text-green-600 font-medium">
                {isHindi ? 'चालू' : 'Active'}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="bg-gray-50 rounded-lg p-2.5">
              <p className="text-xs text-gray-500 mb-0.5">
                {isHindi ? 'रोज़' : 'Daily'}
              </p>
              <p className="font-semibold text-gray-900">
                {data.buyer.targetQuantity} units
              </p>
            </div>
            <div className="bg-gray-50 rounded-lg p-2.5">
              <p className="text-xs text-gray-500 mb-0.5">
                {isHindi ? 'अधिकतम' : 'Max Price'}
              </p>
              <p className="font-semibold text-gray-900">
                ₹{data.buyer.maxPrice}/unit
              </p>
            </div>
          </div>

          {data.buyer.preferredTime && (
            <div className="mt-2 flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-gray-400" />
              <span className="text-xs text-gray-500">
                {isHindi ? 'पसंदीदा समय:' : 'Preferred:'}{' '}
                {data.buyer.preferredTime === 'morning'
                  ? (isHindi ? 'सुबह' : 'Morning')
                  : data.buyer.preferredTime === 'afternoon'
                    ? (isHindi ? 'दोपहर' : 'Afternoon')
                    : (isHindi ? 'ऑटो' : 'Auto')}
              </span>
            </div>
          )}

          {data.buyer.lastRun && (
            <div className="mt-3 pt-3 border-t border-gray-100">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Clock className="w-3.5 h-3.5 text-gray-400" />
                  <span className="text-xs text-gray-500">
                    {formatDate(data.buyer.lastRun.executedAt)}
                  </span>
                </div>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${getStatusColor(data.buyer.lastRun.status)}`}>
                  {getStatusLabel(data.buyer.lastRun.status)}
                </span>
              </div>
              {data.buyer.lastRun.status === 'success' && (
                <div className="flex items-center gap-4 mt-2">
                  <span className="text-sm text-gray-700">
                    {data.buyer.lastRun.quantityBought} units @ ₹{data.buyer.lastRun.pricePerUnit}
                  </span>
                  <span className="text-sm font-medium text-teal-600">
                    = ₹{data.buyer.lastRun.totalSpent.toFixed(0)}
                  </span>
                </div>
              )}
              {data.buyer.lastRun.status === 'error' && data.buyer.lastRun.error && (
                <p className="text-xs text-red-600 mt-2">
                  {data.buyer.lastRun.error}
                </p>
              )}
              {(data.buyer.lastRun.status === 'no_deals' || data.buyer.lastRun.status === 'price_too_high') && (
                <p className="text-xs text-amber-600 mt-2">
                  {isHindi
                    ? (data.buyer.lastRun.status === 'no_deals' ? 'कोई ऑफर उपलब्ध नहीं' : 'सभी ऑफर आपकी सीमा से महंगे')
                    : (data.buyer.lastRun.status === 'no_deals' ? 'No offers available' : 'All offers above your max price')}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
