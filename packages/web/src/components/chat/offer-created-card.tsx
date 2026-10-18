'use client';

import { Zap, Clock, CheckCircle } from 'lucide-react';

interface OfferCreatedData {
  quantity: number;
  pricePerKwh: number;
  startTime: string;
  endTime: string;
  energyType?: string;
}

interface OfferCreatedCardProps {
  data: OfferCreatedData;
  language?: string;
}

// Localized labels
const LABELS = {
  title: { en: 'Offer Created!', hi: 'ऑफर बन गया!' },
  subtitle: { en: 'Your energy is now on sale', hi: 'आपकी बिजली बिक्री के लिए तैयार' },
  quantity: { en: 'Quantity', hi: 'मात्रा' },
  price: { en: 'Price', hi: 'दाम' },
  time: { en: 'Time', hi: 'समय' },
  unit: { en: 'unit', hi: 'यूनिट' },
  kWh: { en: 'units', hi: 'यूनिट' },
  perUnit: { en: '/unit', hi: '/यूनिट' },
  buyersCanSee: { en: 'Buyers can now see and purchase your energy!', hi: 'खरीदार अब आपकी बिजली देख और खरीद सकते हैं!' },
};

function getLabel(key: keyof typeof LABELS, isHindi: boolean): string {
  return isHindi ? LABELS[key].hi : LABELS[key].en;
}

function formatTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// Energy type emojis
const ENERGY_EMOJI: Record<string, string> = {
  SOLAR: '☀️',
  WIND: '💨',
  HYDRO: '💧',
  MIXED: '⚡',
};

export function OfferCreatedCard({ data, language }: OfferCreatedCardProps) {
  const isHindi = language === 'hi-IN';
  const emoji = ENERGY_EMOJI[data.energyType || 'SOLAR'] || '☀️';

  return (
    <div className="bg-gradient-to-br from-teal-50 to-white rounded-2xl border border-teal-200 shadow-sm overflow-hidden my-2">
      {/* Header with success indicator */}
      <div className="bg-gradient-to-r from-teal-600 to-teal-500 px-4 py-3 text-white">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center">
            <CheckCircle className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-semibold text-base">{getLabel('title', isHindi)}</h3>
            <p className="text-teal-100 text-xs">{getLabel('subtitle', isHindi)}</p>
          </div>
        </div>
      </div>

      {/* Offer details */}
      <div className="p-4">
        <div className="bg-white rounded-xl border border-teal-100 p-4 space-y-3">
          {/* Quantity */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-lg">{emoji}</span>
              <span className="text-sm text-gray-600">{getLabel('quantity', isHindi)}</span>
            </div>
            <span className="text-lg font-bold text-gray-900">
              {data.quantity} {getLabel('kWh', isHindi)}
            </span>
          </div>

          {/* Price */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-lg">💰</span>
              <span className="text-sm text-gray-600">{getLabel('price', isHindi)}</span>
            </div>
            <span className="text-lg font-bold text-green-600">
              ₹{data.pricePerKwh}{getLabel('perUnit', isHindi)}
            </span>
          </div>

          {/* Time window */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-gray-500" />
              <span className="text-sm text-gray-600">{getLabel('time', isHindi)}</span>
            </div>
            <div className="text-right">
              <div className="text-sm font-medium text-gray-700">
                {(() => {
                  const start = new Date(data.startTime);
                  const day = start.getDate();
                  const monthNames = isHindi
                    ? ['जनवरी', 'फ़रवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर']
                    : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                  return `${day} ${monthNames[start.getMonth()]}`;
                })()}
              </div>
              <div className="text-xs text-gray-500">
                {formatTime(data.startTime)} – {formatTime(data.endTime)}
              </div>
            </div>
          </div>
        </div>

        {/* Footer message */}
        <p className="text-center text-xs text-gray-500 mt-3">
          {getLabel('buyersCanSee', isHindi)}
        </p>
      </div>
    </div>
  );
}
