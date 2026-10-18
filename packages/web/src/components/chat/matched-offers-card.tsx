'use client';

import { useState } from 'react';
import { CheckCircle, Target, ChevronDown, ChevronUp, Star, X } from 'lucide-react';
import type { MatchedOffersCardData } from '@/hooks/use-chat-engine';

interface MatchedOffersCardProps {
  data: MatchedOffersCardData;
  language?: string;
  onAccept?: () => void;
  onCancel?: () => void;
}

// Localized labels
const LABELS = {
  matchFound: { en: 'Match Found!', hi: 'मैच मिल गया!' },
  bestDeals: { en: 'Best Deals Found!', hi: 'बेस्ट डील मिली!' },
  bestDeal: { en: 'Best deal for your request', hi: 'आपकी मांग के लिए सबसे अच्छी डील' },
  combinedFrom: { en: 'Combined from', hi: '' },
  sellers: { en: 'sellers', hi: 'विक्रेता' },
  sellersFrom: { en: 'sellers', hi: 'विक्रेताओं से' },
  quantity: { en: 'Qty', hi: 'मात्रा' },
  price: { en: 'Price', hi: 'दाम' },
  total: { en: 'Total', hi: 'कुल' },
  time: { en: 'Time', hi: 'समय' },
  avgPrice: { en: 'Avg Price', hi: 'औसत दाम' },
  unit: { en: 'units', hi: 'यूनिट' },
  perUnit: { en: '/unit', hi: '/यूनिट' },
  viewSellers: { en: 'View', hi: 'देखो' },
  hideSellers: { en: 'Hide', hi: 'छुपाओ' },
  buyNow: { en: 'Buy Now', hi: 'अभी खरीदो' },
  acceptAll: { en: 'Accept All', hi: 'सब मंज़ूर' },
  cancel: { en: 'Cancel', hi: 'रद्द करो' },
  from: { en: 'from', hi: 'से' },
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

/**
 * Format raw timeWindow string like "13 Feb 06:00 am-06:00 pm"
 * into a cleaner display: { date: "13 Feb", time: "6 AM – 6 PM" }
 */
function formatTimeWindow(raw: string, isHindi: boolean): { date: string; time: string } {
  if (!raw || raw === 'Flexible') {
    return { date: '', time: isHindi ? 'लचीला' : 'Flexible' };
  }

  // Try to parse "DD Mon HH:MM am-HH:MM pm" pattern
  const match = raw.match(/^(\d{1,2}\s+\w+)\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*-\s*(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (match) {
    const datePart = match[1]; // "13 Feb"
    const startH = parseInt(match[2], 10);
    const startAmPm = match[4].toUpperCase();
    const endH = parseInt(match[5], 10);
    const endAmPm = match[7].toUpperCase();

    // Clean up "06" → "6", drop :00 minutes
    const startMin = match[3] === '00' ? '' : `:${match[3]}`;
    const endMin = match[6] === '00' ? '' : `:${match[6]}`;

    const startStr = `${startH}${startMin} ${startAmPm}`;
    const endStr = `${endH}${endMin} ${endAmPm}`;

    return { date: datePart, time: `${startStr} – ${endStr}` };
  }

  // Fallback: return raw string
  return { date: '', time: raw };
}

export function MatchedOffersCard({ data, language, onAccept, onCancel }: MatchedOffersCardProps) {
  const isHindi = language === 'hi-IN';
  const [expanded, setExpanded] = useState(false);
  const isSingle = data.selectionType === 'single';
  const singleOffer = isSingle ? data.offers[0] : null;

  return (
    <div className="bg-gradient-to-br from-teal-50 to-white rounded-2xl border border-teal-200 shadow-sm overflow-hidden my-2">
      {/* Header */}
      <div className="bg-gradient-to-r from-teal-600 to-teal-500 px-4 py-3 text-white">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center">
            {isSingle ? <CheckCircle className="w-4 h-4" /> : <Target className="w-4 h-4" />}
          </div>
          <div>
            <h3 className="font-semibold text-base">
              {isSingle ? getLabel('matchFound', isHindi) : getLabel('bestDeals', isHindi)}
            </h3>
            <p className="text-teal-100 text-xs">
              {isSingle
                ? getLabel('bestDeal', isHindi)
                : isHindi
                  ? `${data.summary.offersUsed} ${getLabel('sellersFrom', isHindi)}`
                  : `${getLabel('combinedFrom', isHindi)} ${data.summary.offersUsed} ${getLabel('sellers', isHindi)}`
              }
            </p>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="p-3">
        {isSingle && singleOffer ? (
          /* ─── Single Offer View ─── */
          <div className="rounded-xl border bg-white border-gray-100 overflow-hidden">
            {/* Seller row */}
            <div className="flex items-center gap-2.5 px-3.5 py-2.5 border-b border-gray-100">
              <span className="text-xl leading-none">{ENERGY_EMOJI[singleOffer.energyType] || ENERGY_EMOJI.SOLAR}</span>
              <span className="font-semibold text-gray-900 flex-1">{singleOffer.providerName}</span>
              <div className="flex items-center gap-1 bg-amber-50 px-2 py-0.5 rounded-full">
                <Star className="w-3 h-3 text-amber-500 fill-amber-500" />
                <span className="text-xs font-semibold text-amber-600">{(singleOffer.trustScore * 5).toFixed(1)}</span>
              </div>
            </div>

            {/* Quantity + Price row */}
            <div className="grid grid-cols-2 divide-x divide-gray-100">
              <div className="px-3.5 py-2.5 text-center">
                <div className="text-[10px] uppercase tracking-wider text-gray-400 mb-0.5">{getLabel('quantity', isHindi)}</div>
                <div className="text-lg font-bold text-gray-900">
                  {singleOffer.quantity}
                  <span className="text-xs font-normal text-gray-500 ml-1">{getLabel('unit', isHindi)}</span>
                </div>
              </div>
              <div className="px-3.5 py-2.5 text-center">
                <div className="text-[10px] uppercase tracking-wider text-gray-400 mb-0.5">{getLabel('price', isHindi)}</div>
                <div className="text-lg font-bold text-teal-600">
                  ₹{singleOffer.pricePerKwh}
                  <span className="text-xs font-normal text-gray-500">{getLabel('perUnit', isHindi)}</span>
                </div>
              </div>
            </div>

            {/* Total + Time row */}
            <div className="grid grid-cols-2 divide-x divide-gray-100 border-t border-gray-100 bg-gray-50/60">
              <div className="px-3.5 py-2.5 text-center">
                <div className="text-[10px] uppercase tracking-wider text-gray-400 mb-0.5">{getLabel('total', isHindi)}</div>
                <div className="text-lg font-extrabold text-gray-900">₹{Math.round(singleOffer.subtotal)}</div>
              </div>
              <div className="px-3.5 py-2.5 text-center">
                <div className="text-[10px] uppercase tracking-wider text-gray-400 mb-0.5">{getLabel('time', isHindi)}</div>
                {(() => {
                  const tw = formatTimeWindow(data.timeWindow, isHindi);
                  return (
                    <div>
                      {tw.date && <div className="text-xs font-medium text-gray-700">{tw.date}</div>}
                      <div className="text-xs font-medium text-gray-500">{tw.time}</div>
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        ) : (
          /* ─── Multiple Offers View ─── */
          <>
            {/* Summary */}
            <div className="rounded-xl border bg-white border-gray-100 overflow-hidden mb-2">
              <div className="grid grid-cols-2 divide-x divide-gray-100">
                <div className="px-3.5 py-2.5 text-center">
                  <div className="text-[10px] uppercase tracking-wider text-gray-400 mb-0.5">{getLabel('total', isHindi)} {getLabel('quantity', isHindi)}</div>
                  <div className="text-lg font-bold text-gray-900">
                    {data.summary.totalQuantity}
                    <span className="text-xs font-normal text-gray-500 ml-1">{getLabel('unit', isHindi)}</span>
                  </div>
                  <div className="text-[10px] text-gray-400">
                    {getLabel('from', isHindi)} {data.summary.offersUsed} {getLabel('sellers', isHindi)}
                  </div>
                </div>
                <div className="px-3.5 py-2.5 text-center">
                  <div className="text-[10px] uppercase tracking-wider text-gray-400 mb-0.5">{getLabel('avgPrice', isHindi)}</div>
                  <div className="text-lg font-bold text-teal-600">
                    ₹{data.summary.averagePrice.toFixed(1)}
                    <span className="text-xs font-normal text-gray-500">{getLabel('perUnit', isHindi)}</span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 divide-x divide-gray-100 border-t border-gray-100 bg-gray-50/60">
                <div className="px-3.5 py-2.5 text-center">
                  <div className="text-[10px] uppercase tracking-wider text-gray-400 mb-0.5">{getLabel('total', isHindi)} {getLabel('price', isHindi)}</div>
                  <div className="text-lg font-extrabold text-gray-900">₹{Math.round(data.summary.totalPrice)}</div>
                </div>
                <div className="px-3.5 py-2.5 text-center">
                  <div className="text-[10px] uppercase tracking-wider text-gray-400 mb-0.5">{getLabel('time', isHindi)}</div>
                  {(() => {
                    const tw = formatTimeWindow(data.timeWindow, isHindi);
                    return (
                      <div>
                        {tw.date && <div className="text-xs font-medium text-gray-700">{tw.date}</div>}
                        <div className="text-xs font-medium text-gray-500">{tw.time}</div>
                      </div>
                    );
                  })()}
                </div>
              </div>
            </div>

            {/* Expand/Collapse Toggle */}
            <button
              onClick={() => setExpanded(!expanded)}
              className="w-full flex items-center justify-center gap-1 py-2 text-teal-600 hover:text-teal-700 text-sm font-medium transition-colors"
            >
              {expanded ? (
                <>
                  <ChevronUp className="w-4 h-4" />
                  {getLabel('hideSellers', isHindi)}
                </>
              ) : (
                <>
                  <ChevronDown className="w-4 h-4" />
                  {getLabel('viewSellers', isHindi)} {data.offers.length} {getLabel('sellers', isHindi)}
                </>
              )}
            </button>

            {/* Expanded Seller List */}
            {expanded && (
              <div className="space-y-2 mt-2">
                {data.offers.map((offer, index) => (
                  <div
                    key={offer.offerId}
                    className="p-2.5 rounded-lg border bg-gray-50 border-gray-200"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-gray-400 text-sm">{index + 1}.</span>
                        <span className="text-lg">{ENERGY_EMOJI[offer.energyType] || ENERGY_EMOJI.SOLAR}</span>
                        <span className="font-medium text-gray-900">{offer.providerName}</span>
                        <div className="flex items-center gap-0.5">
                          <Star className="w-3 h-3 text-amber-500 fill-amber-500" />
                          <span className="text-xs text-amber-600">{(offer.trustScore * 5).toFixed(1)}</span>
                        </div>
                      </div>
                    </div>
                    <div className="mt-1 text-sm text-gray-600 pl-6">
                      {offer.quantity} {getLabel('unit', isHindi)} × ₹{offer.pricePerKwh} = <span className="font-semibold text-gray-900">₹{Math.round(offer.subtotal)}</span>
                    </div>
                  </div>
                ))}

                {/* Total line */}
                <div className="flex justify-end items-center gap-2 pt-2 border-t border-gray-200 text-sm">
                  <span className="text-gray-500">{getLabel('total', isHindi)}:</span>
                  <span className="font-bold text-gray-900">
                    {data.summary.totalQuantity} {getLabel('unit', isHindi)} | ₹{Math.round(data.summary.totalPrice)}
                  </span>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Action Buttons */}
      <div className="px-3 pb-3 flex gap-2">
        <button
          onClick={onCancel}
          className="flex-1 px-3 py-2.5 border border-gray-200 hover:border-gray-300 text-gray-600 text-sm font-medium rounded-xl transition-colors flex items-center justify-center gap-1.5"
        >
          <X className="w-3.5 h-3.5" />
          {getLabel('cancel', isHindi)}
        </button>
        <button
          onClick={onAccept}
          className="flex-[2] px-4 py-2.5 bg-teal-600 hover:bg-teal-700 text-white text-sm font-semibold rounded-xl transition-colors flex items-center justify-center gap-1.5 shadow-sm"
        >
          <CheckCircle className="w-4 h-4" />
          {isSingle ? getLabel('buyNow', isHindi) : getLabel('acceptAll', isHindi)}
        </button>
      </div>
    </div>
  );
}
