'use client';

import { Sun, Zap, Wind, Droplets, Star, Trophy, Clock } from 'lucide-react';

export interface OfferData {
    id: string;
    sellerId: string;
    sellerName: string;
    trustScore: number;
    energyType: 'SOLAR' | 'WIND' | 'HYDRO' | 'MIXED';
    quantityKWh: number;
    pricePerKwh: number;
    discomRate: number;
    startTime: string;
    endTime: string;
    isBestDeal?: boolean;
}

interface OfferCardProps {
    offer: OfferData;
    onSelect: (offerId: string) => void;
    language?: string;
}

const ENERGY_ICONS = {
    SOLAR: Sun,
    WIND: Wind,
    HYDRO: Droplets,
    MIXED: Zap,
};

const ENERGY_COLORS = {
    SOLAR: 'bg-amber-100 text-amber-700',
    WIND: 'bg-sky-100 text-sky-700',
    HYDRO: 'bg-blue-100 text-blue-700',
    MIXED: 'bg-purple-100 text-purple-700',
};

function formatTime(isoString: string): string {
    const date = new Date(isoString);
    return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function formatDate(isoString: string): string {
    const date = new Date(isoString);
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    if (date.toDateString() === today.toDateString()) {
        return 'Today';
    } else if (date.toDateString() === tomorrow.toDateString()) {
        return 'Tomorrow';
    }
    return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function TrustStars({ score }: { score: number }) {
    const fullStars = Math.floor(score / 20);
    return (
        <div className="flex items-center gap-0.5">
            {Array.from({ length: 5 }).map((_, i) => (
                <Star
                    key={i}
                    size={12}
                    className={i < fullStars ? 'text-yellow-500 fill-yellow-500' : 'text-gray-300'}
                />
            ))}
        </div>
    );
}

export function OfferCard({ offer, onSelect, language = 'en-IN' }: OfferCardProps) {
    const isHindi = language === 'hi-IN';
    const EnergyIcon = ENERGY_ICONS[offer.energyType] || Zap;
    const savingsPercent = Math.round(((offer.discomRate - offer.pricePerKwh) / offer.discomRate) * 100);
    const totalCost = offer.quantityKWh * offer.pricePerKwh;

    return (
        <div
            className={`relative rounded-xl border-2 p-4 transition-all hover:shadow-lg ${offer.isBestDeal
                    ? 'border-emerald-400 bg-gradient-to-br from-emerald-50 to-teal-50 shadow-md'
                    : 'border-gray-200 bg-white hover:border-teal-300'
                }`}
        >
            {/* Best Deal Badge */}
            {offer.isBestDeal && (
                <div className="absolute -top-3 left-4 flex items-center gap-1 rounded-full bg-emerald-500 px-3 py-1 text-xs font-bold text-white shadow-sm">
                    <Trophy size={12} />
                    {isHindi ? 'सबसे अच्छा' : 'BEST DEAL'}
                </div>
            )}

            <div className="flex items-start justify-between gap-3">
                {/* Left: Energy type & quantity */}
                <div className="flex items-center gap-3">
                    <div className={`rounded-lg p-2 ${ENERGY_COLORS[offer.energyType]}`}>
                        <EnergyIcon size={24} />
                    </div>
                    <div>
                        <div className="font-semibold text-gray-900">
                            {offer.quantityKWh} units
                        </div>
                        <div className="text-xs text-gray-500">
                            {offer.energyType.charAt(0) + offer.energyType.slice(1).toLowerCase()}
                        </div>
                    </div>
                </div>

                {/* Right: Price & savings */}
                <div className="text-right">
                    <div className="text-lg font-bold text-gray-900">
                        ₹{offer.pricePerKwh.toFixed(2)}<span className="text-xs font-normal text-gray-500">/unit</span>
                    </div>
                    {savingsPercent > 0 && (
                        <div className="inline-block rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
                            {isHindi ? `${savingsPercent}% बचत` : `Save ${savingsPercent}%`}
                        </div>
                    )}
                </div>
            </div>

            {/* Seller info */}
            <div className="mt-3 flex items-center justify-between border-t border-gray-100 pt-3">
                <div className="flex items-center gap-2">
                    <div className="h-7 w-7 rounded-full bg-teal-100 flex items-center justify-center text-teal-700 font-medium text-xs">
                        {offer.sellerName.charAt(0).toUpperCase()}
                    </div>
                    <div>
                        <div className="text-sm font-medium text-gray-800">{offer.sellerName}</div>
                        <TrustStars score={offer.trustScore} />
                    </div>
                </div>

                {/* Time window */}
                <div className="flex items-center gap-1 text-xs text-gray-500">
                    <Clock size={12} />
                    <span>{formatDate(offer.startTime)} {formatTime(offer.startTime)}-{formatTime(offer.endTime)}</span>
                </div>
            </div>

            {/* Total & Select button */}
            <div className="mt-3 flex items-center justify-between">
                <div className="text-sm text-gray-600">
                    {isHindi ? 'कुल:' : 'Total:'}{' '}
                    <span className="font-semibold text-gray-900">₹{totalCost.toFixed(0)}</span>
                </div>
                <button
                    onClick={() => onSelect(offer.id)}
                    className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${offer.isBestDeal
                            ? 'bg-emerald-500 text-white hover:bg-emerald-600'
                            : 'bg-teal-500 text-white hover:bg-teal-600'
                        }`}
                >
                    {isHindi ? 'ये लो' : 'Select'}
                </button>
            </div>
        </div>
    );
}
