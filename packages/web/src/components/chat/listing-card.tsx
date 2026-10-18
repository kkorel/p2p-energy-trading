'use client';

import { Zap, Clock, TrendingUp } from 'lucide-react';

interface ListingData {
  id: string;
  quantity: number;
  pricePerKwh: number;
  startTime: string;
  endTime: string;
  energyType: string;
}

interface ListingsCardData {
  listings: ListingData[];
  totalListed: number;
  totalSold: number;
  userName: string;
}

interface ListingCardProps {
  data: ListingsCardData;
  language?: string;
}

// Localized labels
const LABELS = {
  title: { en: 'Your Listings', hi: 'आपकी लिस्टिंग' },
  active: { en: 'active', hi: 'चालू' },
  listed: { en: 'listed', hi: 'लिस्टेड' },
  sold: { en: 'Sold', hi: 'बिका' },
  unit: { en: 'units', hi: 'यूनिट' },
  perUnit: { en: '/unit', hi: '/यूनिट' },
  footer: { en: 'Buyers can see your energy', hi: 'खरीदार आपकी बिजली देख सकते हैं' },
};

function getLabel(key: keyof typeof LABELS, isHindi: boolean): string {
  return isHindi ? LABELS[key].hi : LABELS[key].en;
}

// Energy type icons
const ENERGY_EMOJI: Record<string, string> = {
  SOLAR: '☀️',
  WIND: '💨',
  HYDRO: '💧',
  MIXED: '⚡',
};

function formatTimeWindow(startIso: string, endIso: string, isHindi: boolean): string {
  const start = new Date(startIso);
  const end = new Date(endIso);

  // Format: "5 Feb, 10:00 - 18:00" or "5 फ़रवरी, 10:00 - 18:00"
  const day = start.getDate();
  const monthNames = isHindi
    ? ['जनवरी', 'फ़रवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर']
    : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = monthNames[start.getMonth()];

  const startTime = start.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const endTime = end.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });

  return `${day} ${month}, ${startTime} - ${endTime}`;
}

export function ListingCard({ data, language }: ListingCardProps) {
  console.log(`[ListingCard] language prop = "${language}", isHindi = ${language === 'hi-IN'}`);
  const isHindi = language === 'hi-IN';

  return (
    <div className="bg-gradient-to-br from-teal-50 to-white rounded-2xl border border-teal-200 shadow-sm overflow-hidden my-2">
      {/* Header - teal to match dashboard */}
      <div className="bg-gradient-to-r from-teal-600 to-teal-500 px-4 py-3 text-white">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center">
              <Zap className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-semibold text-base">{getLabel('title', isHindi)}</h3>
              <p className="text-teal-100 text-xs">
                {data.listings.length} {getLabel('active', isHindi)}
              </p>
            </div>
          </div>
          <div className="text-right">
            <div className="text-lg font-bold">{data.totalListed}</div>
            <div className="text-teal-100 text-xs">{getLabel('unit', isHindi)} {getLabel('listed', isHindi)}</div>
          </div>
        </div>
      </div>

      {/* Summary Stats */}
      <div className="px-4 py-2 bg-teal-100/50 flex justify-between text-sm">
        <div className="flex items-center gap-1">
          <TrendingUp className="w-3.5 h-3.5 text-green-600" />
          <span className="text-gray-700">
            {getLabel('sold', isHindi)}: <span className="font-semibold text-green-600">{data.totalSold} {getLabel('unit', isHindi)}</span>
          </span>
        </div>
      </div>

      {/* Listings */}
      <div className="p-3 space-y-2">
        {data.listings.map((listing) => {
          const emoji = ENERGY_EMOJI[listing.energyType] || ENERGY_EMOJI.SOLAR;
          return (
            <div
              key={listing.id}
              className="p-3 rounded-xl border bg-white border-teal-100 hover:border-teal-300 transition-colors"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-lg">{emoji}</span>
                  <span className="font-semibold text-gray-900">
                    {listing.quantity} {getLabel('unit', isHindi)}
                  </span>
                </div>
                <div className="text-right">
                  <span className="font-bold text-green-600">₹{listing.pricePerKwh}</span>
                  <span className="text-gray-500 text-xs">{getLabel('perUnit', isHindi)}</span>
                </div>
              </div>
              <div className="flex items-center gap-1 text-xs text-gray-500">
                <Clock className="w-3 h-3" />
                <span>
                  {formatTimeWindow(listing.startTime, listing.endTime, isHindi)}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer hint */}
      <div className="px-3 pb-3 text-center">
        <p className="text-[10px] text-gray-400">
          {getLabel('footer', isHindi)}
        </p>
      </div>
    </div>
  );
}
