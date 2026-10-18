'use client';

import { type DashboardData } from '@/hooks/use-chat-engine';
import { Wallet, TrendingUp, Zap, ShoppingBag, Info } from 'lucide-react';

interface DashboardCardProps {
  data: DashboardData;
  language?: string;
  onExplain?: (field: string) => void;
}

// Localized labels
const LABELS: Record<string, { en: string; hi: string }> = {
  balance: { en: 'Balance', hi: 'बैलेंस' },
  trust: { en: 'Trust', hi: 'भरोसा' },
  tradeLimit: { en: 'Trade Limit', hi: 'सीमा' },
  seller: { en: 'Selling', hi: 'बिक्री' },
  buyer: { en: 'Buying', hi: 'खरीदारी' },
  activeListings: { en: 'Listed', hi: 'लिस्टेड' },
  thisWeek: { en: 'This Week', hi: 'इस हफ्ते' },
  allTime: { en: 'Total', hi: 'कुल' },
  orders: { en: 'Orders', hi: 'ऑर्डर' },
  kWh: { en: 'units', hi: 'यूनिट' },
  totalSpent: { en: 'Spent', hi: 'खर्च' },
};

function getLabel(key: string, isHindi: boolean): string {
  const entry = LABELS[key];
  if (!entry) return key;
  return isHindi ? entry.hi : entry.en;
}

// Get trust tier color based on score
function getTrustColor(score: number): { bg: string; text: string; border: string } {
  if (score >= 0.9) return { bg: 'bg-purple-100', text: 'text-purple-700', border: 'border-purple-200' }; // Platinum
  if (score >= 0.7) return { bg: 'bg-amber-100', text: 'text-amber-700', border: 'border-amber-200' }; // Gold
  if (score >= 0.5) return { bg: 'bg-gray-200', text: 'text-gray-700', border: 'border-gray-300' }; // Silver
  if (score >= 0.3) return { bg: 'bg-orange-100', text: 'text-orange-700', border: 'border-orange-200' }; // Bronze
  return { bg: 'bg-green-100', text: 'text-green-700', border: 'border-green-200' }; // Starter
}

export function DashboardCard({ data, language, onExplain }: DashboardCardProps) {
  console.log(`[DashboardCard] language prop = "${language}", isHindi = ${language === 'hi-IN'}`);
  const isHindi = language === 'hi-IN';
  const trustColor = getTrustColor(data.trustScore);

  const handleFieldClick = (field: string) => {
    onExplain?.(field);
  };

  return (
    <div className="bg-gradient-to-br from-teal-50 to-white rounded-2xl border border-teal-200 shadow-sm overflow-hidden my-2">
      {/* Header */}
      <div className="bg-gradient-to-r from-teal-600 to-teal-500 px-4 py-3 text-white">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center">
            <span className="text-sm font-bold">{data.userName[0]?.toUpperCase() || 'U'}</span>
          </div>
          <div>
            <h3 className="font-semibold text-base">{data.userName}</h3>
            <p className="text-teal-100 text-xs">{isHindi ? 'ऊर्जा डैशबोर्ड' : 'Oorja Dashboard'}</p>
          </div>
        </div>
      </div>

      {/* Main Stats */}
      <div className="p-3 grid grid-cols-3 gap-2">
        {/* Balance */}
        <button
          onClick={() => handleFieldClick('balance')}
          className="bg-white rounded-xl p-3 border border-gray-100 hover:border-teal-300 hover:shadow-md transition-all text-center group flex flex-col items-center justify-between"
        >
          <div className="flex items-center justify-center gap-1 mb-1 whitespace-nowrap">
            <Wallet className="w-3.5 h-3.5 text-teal-600 shrink-0" />
            <span className="text-[10px] text-gray-500 uppercase tracking-wide">{getLabel('balance', isHindi)}</span>
            <Info className="w-3 h-3 text-gray-300 group-hover:text-teal-500 shrink-0" />
          </div>
          <div className="text-base font-bold text-gray-900">₹{data.balance.toLocaleString('en-IN')}</div>
        </button>

        {/* Trust Score - Color coded */}
        <button
          onClick={() => handleFieldClick('trust')}
          className={`rounded-xl p-3 border hover:shadow-md transition-all text-center group flex flex-col items-center justify-between ${trustColor.bg} ${trustColor.border}`}
        >
          <div className="flex items-center justify-center gap-1 mb-1 whitespace-nowrap">
            <span className="text-[10px] text-gray-600 uppercase tracking-wide">{getLabel('trust', isHindi)}</span>
            <Info className={`w-3 h-3 opacity-50 group-hover:opacity-100 shrink-0 ${trustColor.text}`} />
          </div>
          <div className={`text-base font-bold ${trustColor.text}`}>{(data.trustScore * 100).toFixed(0)}%</div>
        </button>

        {/* Trade Limit */}
        <button
          onClick={() => handleFieldClick('tradelimit')}
          className="bg-white rounded-xl p-3 border border-gray-100 hover:border-teal-300 hover:shadow-md transition-all text-center group flex flex-col items-center justify-between"
        >
          <div className="flex items-center justify-center gap-1 mb-1 whitespace-nowrap">
            <TrendingUp className="w-3.5 h-3.5 text-green-600 shrink-0" />
            <span className="text-[10px] text-gray-500 uppercase tracking-wide">{getLabel('tradeLimit', isHindi)}</span>
            <Info className="w-3 h-3 text-gray-300 group-hover:text-teal-500 shrink-0" />
          </div>
          <div className="text-base font-bold text-gray-900">{data.tradeLimit}%</div>
        </button>
      </div>

      {/* Seller Stats */}
      {data.seller && (
        <button
          onClick={() => handleFieldClick('seller')}
          className="mx-3 mb-2 p-3 bg-amber-50 rounded-xl border border-amber-100 hover:border-amber-300 hover:shadow-md transition-all text-left w-[calc(100%-1.5rem)] group"
        >
          <div className="flex items-center gap-1.5 mb-2">
            <Zap className="w-4 h-4 text-amber-600" />
            <span className="text-xs font-semibold text-amber-800">{getLabel('seller', isHindi)}</span>
            <Info className="w-3 h-3 text-amber-300 group-hover:text-amber-600 ml-auto" />
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="text-sm font-bold text-gray-900">{data.seller.activeListings}</div>
              <div className="text-[10px] text-gray-500">{getLabel('activeListings', isHindi)}</div>
              <div className="text-[10px] text-gray-400">({data.seller.totalListedKwh} {getLabel('kWh', isHindi)})</div>
            </div>
            <div>
              <div className="text-sm font-bold text-green-600">₹{data.seller.weeklyEarnings.toLocaleString('en-IN')}</div>
              <div className="text-[10px] text-gray-500">{getLabel('thisWeek', isHindi)}</div>
              <div className="text-[10px] text-gray-400">{data.seller.weeklyKwh.toFixed(1)} {getLabel('kWh', isHindi)}</div>
            </div>
            <div>
              <div className="text-sm font-bold text-gray-900">₹{data.seller.totalEarnings.toLocaleString('en-IN')}</div>
              <div className="text-[10px] text-gray-500">{getLabel('allTime', isHindi)}</div>
              <div className="text-[10px] text-gray-400">{data.seller.totalKwh.toFixed(1)} {getLabel('kWh', isHindi)}</div>
            </div>
          </div>
        </button>
      )}

      {/* Buyer Stats */}
      {data.buyer && (
        <button
          onClick={() => handleFieldClick('buyer')}
          className="mx-3 mb-3 p-3 bg-blue-50 rounded-xl border border-blue-100 hover:border-blue-300 hover:shadow-md transition-all text-left w-[calc(100%-1.5rem)] group"
        >
          <div className="flex items-center gap-1.5 mb-2">
            <ShoppingBag className="w-4 h-4 text-blue-600" />
            <span className="text-xs font-semibold text-blue-800">{getLabel('buyer', isHindi)}</span>
            <Info className="w-3 h-3 text-blue-300 group-hover:text-blue-600 ml-auto" />
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="text-sm font-bold text-gray-900">{data.buyer.totalOrders}</div>
              <div className="text-[10px] text-gray-500">{getLabel('orders', isHindi)}</div>
            </div>
            <div>
              <div className="text-sm font-bold text-gray-900">{data.buyer.totalBoughtKwh.toFixed(1)}</div>
              <div className="text-[10px] text-gray-500">{getLabel('kWh', isHindi)}</div>
            </div>
            <div>
              <div className="text-sm font-bold text-red-600">₹{data.buyer.totalSpent.toLocaleString('en-IN')}</div>
              <div className="text-[10px] text-gray-500">{getLabel('totalSpent', isHindi)}</div>
            </div>
          </div>
        </button>
      )}

      {/* Tap hint */}
      <div className="px-3 pb-3 text-center">
        <p className="text-[10px] text-gray-400">
          {isHindi ? '👆 जानने के लिए टैप करो' : '👆 Tap to learn more'}
        </p>
      </div>
    </div>
  );
}
