'use client';

import { Zap, TrendingDown } from 'lucide-react';
import { OfferCard, type OfferData } from './offer-card';

interface OfferListProps {
    offers: OfferData[];
    onSelectOffer: (offerId: string) => void;
    language?: string;
}

export function OfferList({ offers, onSelectOffer, language = 'en-IN' }: OfferListProps) {
    const isHindi = language === 'hi-IN';

    if (offers.length === 0) {
        return (
            <div className="rounded-xl border-2 border-dashed border-gray-200 bg-gray-50 p-6 text-center">
                <Zap className="mx-auto mb-2 text-gray-400" size={32} />
                <p className="text-gray-500">
                    {isHindi ? 'कोई ऑफर उपलब्ध नहीं' : 'No offers available right now'}
                </p>
            </div>
        );
    }

    // Mark the first (best) offer
    const offersWithBestDeal = offers.map((offer, index) => ({
        ...offer,
        isBestDeal: index === 0,
    }));

    // Calculate potential savings for the best deal
    const bestOffer = offersWithBestDeal[0];
    const potentialSavings = bestOffer.quantityKWh * (bestOffer.discomRate - bestOffer.pricePerKwh);

    return (
        <div className="space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <div className="rounded-lg bg-gradient-to-r from-teal-500 to-emerald-500 p-2 text-white">
                        <Zap size={20} />
                    </div>
                    <h3 className="font-semibold text-gray-900">
                        {isHindi ? 'उपलब्ध ऊर्जा ऑफर' : 'Available Energy Offers'}
                    </h3>
                </div>
                {potentialSavings > 0 && (
                    <div className="flex items-center gap-1 rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-700">
                        <TrendingDown size={12} />
                        {isHindi
                            ? `₹${potentialSavings.toFixed(0)} बचाओ`
                            : `Save ₹${potentialSavings.toFixed(0)}`
                        }
                    </div>
                )}
            </div>

            {/* Offer cards */}
            <div className="space-y-3">
                {offersWithBestDeal.map((offer) => (
                    <OfferCard
                        key={offer.id}
                        offer={offer}
                        onSelect={onSelectOffer}
                        language={language}
                    />
                ))}
            </div>

            {/* Footer hint */}
            <p className="text-center text-xs text-gray-400">
                {isHindi
                    ? 'DISCOM दर से कीमतों की तुलना करें'
                    : 'Prices compared to DISCOM rates'
                }
            </p>
        </div>
    );
}
