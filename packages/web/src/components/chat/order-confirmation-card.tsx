'use client';

import { PartyPopper, Lock, Zap, Clock, CheckCircle } from 'lucide-react';
import type { OrderConfirmationCardData } from '@/hooks/use-chat-engine';

interface OrderConfirmationCardProps {
  data: OrderConfirmationCardData;
  language?: string;
}

// Localized labels
const LABELS = {
  title: { en: 'Order Confirmed!', hi: 'ऑर्डर पक्का हो गया!' },
  subtitle: { en: 'Your purchase is complete', hi: 'आपकी खरीदारी पूरी हो गई' },
  orderDetails: { en: 'Order Details', hi: 'ऑर्डर की जानकारी' },
  total: { en: 'Total', hi: 'कुल' },
  amount: { en: 'Amount', hi: 'राशि' },
  time: { en: 'Time', hi: 'समय' },
  orders: { en: 'Orders', hi: 'ऑर्डर' },
  confirmed: { en: 'confirmed', hi: 'पक्के हुए' },
  unit: { en: 'units', hi: 'यूनिट' },
  paymentSecured: { en: 'Payment secured with platform', hi: 'पैसा प्लेटफॉर्म पे सुरक्षित है' },
  energyViaGrid: { en: 'Energy delivered via grid', hi: 'बिजली ग्रिड से आएगी' },
};

function getLabel(key: keyof typeof LABELS, isHindi: boolean): string {
  return isHindi ? LABELS[key].hi : LABELS[key].en;
}

/**
 * Split time window into date and time range.
 * Input: "Feb 14, 06:00 AM-06:00 PM" or "14 Feb, 06:00 am - 06:00 pm"
 */
function splitTimeWindow(tw: string): { date: string; time: string } {
  if (!tw) return { date: '', time: '' };
  const commaIdx = tw.indexOf(',');
  if (commaIdx > 0) {
    return { date: tw.slice(0, commaIdx).trim(), time: tw.slice(commaIdx + 1).trim() };
  }
  // Try splitting on space before time pattern (e.g. "14 Feb 06:00")
  const timeMatch = tw.match(/^(.+?)\s+(\d{1,2}:\d{2}.*)$/);
  if (timeMatch) {
    return { date: timeMatch[1], time: timeMatch[2] };
  }
  return { date: '', time: tw };
}

export function OrderConfirmationCard({ data, language }: OrderConfirmationCardProps) {
  const isHindi = language === 'hi-IN';

  return (
    <div className="bg-gradient-to-br from-teal-50 to-white rounded-2xl border border-teal-200 shadow-sm overflow-hidden my-2">
      {/* Header */}
      <div className="bg-gradient-to-r from-teal-600 to-teal-500 px-4 py-3 text-white">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center">
            <PartyPopper className="w-4 h-4" />
          </div>
          <div>
            <h3 className="font-semibold text-base">{getLabel('title', isHindi)}</h3>
            <p className="text-teal-100 text-xs">{getLabel('subtitle', isHindi)}</p>
          </div>
        </div>
      </div>

      {/* Order Details */}
      <div className="p-3">
        {/* Seller breakdown */}
        {data.offers.length > 0 && (
          <div className="space-y-2 mb-3">
            {data.offers.map((offer, index) => (
              <div
                key={index}
                className="p-2 rounded-lg border bg-white border-teal-100 flex items-center justify-between"
              >
                <div className="flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 text-green-500" />
                  <span className="font-medium text-gray-900">{offer.providerName}</span>
                </div>
                <div className="text-sm text-gray-600">
                  {offer.quantity} {getLabel('unit', isHindi)} × ₹{offer.pricePerKwh} = <span className="font-semibold text-gray-900">₹{Math.round(offer.subtotal)}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Summary */}
        <div className="p-3 rounded-xl border bg-gray-50 border-gray-200">
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">{getLabel('total', isHindi)}:</span>
              <span className="font-bold text-gray-900">{data.summary.totalQuantity} {getLabel('unit', isHindi)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">{getLabel('amount', isHindi)}:</span>
              <span className="font-bold text-green-600">₹{Math.round(data.summary.totalPrice)}</span>
            </div>
            <div className="col-span-2 flex items-start gap-1.5">
              <span className="text-gray-500 mt-px">{getLabel('time', isHindi)}:</span>
              <Clock className="w-3 h-3 text-gray-400 mt-1" />
              {(() => {
                const { date, time } = splitTimeWindow(data.timeWindow);
                return date ? (
                  <span className="font-medium leading-tight">
                    <span className="block">{date}</span>
                    <span className="block whitespace-nowrap">{time}</span>
                  </span>
                ) : (
                  <span className="font-medium whitespace-nowrap">{data.timeWindow}</span>
                );
              })()}
            </div>
            {data.summary.ordersConfirmed > 1 && (
              <div className="flex justify-between">
                <span className="text-gray-500">{getLabel('orders', isHindi)}:</span>
                <span className="font-medium">{data.summary.ordersConfirmed} {getLabel('confirmed', isHindi)}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Footer hints */}
      <div className="px-3 pb-3 space-y-1">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Lock className="w-3 h-3" />
          <span>{getLabel('paymentSecured', isHindi)}</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Zap className="w-3 h-3" />
          <span>{getLabel('energyViaGrid', isHindi)}</span>
        </div>
      </div>
    </div>
  );
}
