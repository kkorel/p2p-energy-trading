'use client';

import { TrendingUp, Wallet, Zap, ShoppingBag, Sparkles } from 'lucide-react';

export interface EarningsCardData {
  userName: string;
  hasStartedSelling: boolean;
  totalOrders: number;
  totalEnergySold: number;
  totalEarnings: number;
  walletBalance: number;
}

interface EarningsCardProps {
  data: EarningsCardData;
  language?: string;
}

// Localized labels
const LABELS = {
  title: { en: 'Your Earnings', hi: 'आपकी कमाई' },
  noSalesTitle: { en: 'Start Earning!', hi: 'कमाई शुरू करो!' },
  noSalesYet: { en: 'No sales yet', hi: 'अभी कोई बिक्री नहीं' },
  offersLive: { en: 'Your offers are live and waiting for buyers!', hi: 'आपके ऑफर लाइव हैं, खरीदारों का इंतज़ार है!' },
  notStarted: { en: 'You haven\'t started selling yet', hi: 'आपने अभी बेचना शुरू नहीं किया' },
  startSelling: { en: 'Create a listing to start earning', hi: 'कमाई शुरू करने के लिए listing बनाओ' },
  orders: { en: 'Orders', hi: 'ऑर्डर' },
  energySold: { en: 'Energy Sold', hi: 'बेची गई बिजली' },
  earnings: { en: 'Earnings', hi: 'कमाई' },
  wallet: { en: 'Wallet', hi: 'वॉलेट' },
  unit: { en: 'units', hi: 'यूनिट' },
};

function getLabel(key: keyof typeof LABELS, isHindi: boolean): string {
  return isHindi ? LABELS[key].hi : LABELS[key].en;
}

export function EarningsCard({ data, language }: EarningsCardProps) {
  const isHindi = language === 'hi-IN';

  // Not started selling yet
  if (!data.hasStartedSelling) {
    return (
      <div className="bg-gradient-to-br from-amber-50 to-white rounded-2xl border border-amber-200 shadow-sm overflow-hidden my-2">
        <div className="bg-gradient-to-r from-amber-500 to-amber-400 px-4 py-3 text-white">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-semibold text-base">{getLabel('noSalesTitle', isHindi)}</h3>
              <p className="text-amber-100 text-xs">{data.userName}</p>
            </div>
          </div>
        </div>
        <div className="p-4 text-center">
          <p className="text-gray-600 mb-2">{getLabel('notStarted', isHindi)}</p>
          <p className="text-sm text-gray-500">{getLabel('startSelling', isHindi)}</p>
        </div>
      </div>
    );
  }

  // No sales yet but has started
  if (data.totalOrders === 0) {
    return (
      <div className="bg-gradient-to-br from-teal-50 to-white rounded-2xl border border-teal-200 shadow-sm overflow-hidden my-2">
        <div className="bg-gradient-to-r from-teal-600 to-teal-500 px-4 py-3 text-white">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center">
              <TrendingUp className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-semibold text-base">{getLabel('title', isHindi)}</h3>
              <p className="text-teal-100 text-xs">{data.userName}</p>
            </div>
          </div>
        </div>
        <div className="p-4">
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-3">
            <p className="text-amber-700 font-medium">{getLabel('noSalesYet', isHindi)}</p>
            <p className="text-amber-600 text-sm">{getLabel('offersLive', isHindi)}</p>
          </div>
          <div className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
            <div className="flex items-center gap-2">
              <Wallet className="w-4 h-4 text-gray-500" />
              <span className="text-gray-600">{getLabel('wallet', isHindi)}</span>
            </div>
            <span className="font-bold text-gray-900">₹{data.walletBalance.toFixed(2)}</span>
          </div>
        </div>
      </div>
    );
  }

  // Has sales - show full earnings
  return (
    <div className="bg-gradient-to-br from-teal-50 to-white rounded-2xl border border-teal-200 shadow-sm overflow-hidden my-2">
      {/* Header */}
      <div className="bg-gradient-to-r from-teal-600 to-teal-500 px-4 py-3 text-white">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center">
              <TrendingUp className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-semibold text-base">{getLabel('title', isHindi)}</h3>
              <p className="text-teal-100 text-xs">{data.userName}</p>
            </div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold">₹{Math.round(data.totalEarnings)}</div>
            <div className="text-teal-100 text-xs">{getLabel('earnings', isHindi)}</div>
          </div>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="p-3 grid grid-cols-2 gap-2">
        {/* Orders */}
        <div className="p-3 rounded-xl border bg-white border-teal-100">
          <div className="flex items-center gap-2 mb-1">
            <ShoppingBag className="w-4 h-4 text-teal-600" />
            <span className="text-xs text-gray-500">{getLabel('orders', isHindi)}</span>
          </div>
          <div className="text-xl font-bold text-gray-900">{data.totalOrders}</div>
        </div>

        {/* Energy Sold */}
        <div className="p-3 rounded-xl border bg-white border-teal-100">
          <div className="flex items-center gap-2 mb-1">
            <Zap className="w-4 h-4 text-amber-500" />
            <span className="text-xs text-gray-500">{getLabel('energySold', isHindi)}</span>
          </div>
          <div className="text-xl font-bold text-gray-900">
            {data.totalEnergySold.toFixed(1)} <span className="text-sm font-normal text-gray-500">{getLabel('unit', isHindi)}</span>
          </div>
        </div>
      </div>

      {/* Wallet Balance */}
      <div className="px-3 pb-3">
        <div className="flex items-center justify-between p-3 bg-green-50 border border-green-200 rounded-xl">
          <div className="flex items-center gap-2">
            <Wallet className="w-4 h-4 text-green-600" />
            <span className="text-green-700 font-medium">{getLabel('wallet', isHindi)}</span>
          </div>
          <span className="text-xl font-bold text-green-600">₹{data.walletBalance.toFixed(2)}</span>
        </div>
      </div>
    </div>
  );
}
