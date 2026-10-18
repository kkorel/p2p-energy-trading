'use client';

import { useEffect, useRef, useMemo } from 'react';
import { User, Check } from 'lucide-react';
import type { ChatMessageData } from '@/hooks/use-chat-engine';
import { InlineSpeakerButton } from './speaker-button';
import { OfferList } from './offer-list';
import { DashboardCard } from './dashboard-card';
import { ListingCard } from './listing-card';
import { OfferCreatedCard } from './offer-created-card';
import { TopDealsCard } from './top-deals-card';
import { MatchedOffersCard } from './matched-offers-card';
import { OrderConfirmationCard } from './order-confirmation-card';
import { EarningsCard } from './earnings-card';
import { SliderInput } from '../ui/slider-input';
import { AutoTradeStatusCard } from './auto-trade-status-card';

export type { ChatMessageData };

interface MessageListProps {
  messages: ChatMessageData[];
  onButtonClick?: (callbackData: string, displayText: string) => void;
  onSelectOffer?: (offerId: string) => void;
  isLoading?: boolean;
  /** Language code for TTS (e.g., 'hi-IN', 'en-IN'). Defaults to 'en-IN' */
  responseLanguage?: string;
  /** Whether to show speaker buttons on agent messages */
  showSpeaker?: boolean;
}

/** Check if a button is a voice preference button */
function isVoicePrefButton(callbackData?: string): boolean {
  return callbackData === 'voice_pref:yes' || callbackData === 'voice_pref:no';
}

export function MessageList({
  messages,
  onButtonClick,
  onSelectOffer,
  isLoading,
  responseLanguage = 'en-IN',
  showSpeaker = true,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Debug: log language on every render
  console.log(`[MessageList] responseLanguage = "${responseLanguage}"`);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  // Find which voice preference was selected (if any) by looking at user messages
  const selectedVoicePref = useMemo(() => {
    for (const msg of messages) {
      if (msg.role === 'user') {
        if (msg.content.includes('Yes, speak') || msg.content.includes('Haan, bolo')) {
          return 'voice_pref:yes';
        }
        if (msg.content.includes('No, text only') || msg.content.includes('Nahi, sirf text')) {
          return 'voice_pref:no';
        }
      }
    }
    return null;
  }, [messages]);

  return (
    <div className="flex flex-col gap-2 p-3">
      {messages.map((msg, i) => (
        <div
          key={i}
          className={`flex items-end gap-2 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}
        >
          {/* Avatar */}
          {msg.role === 'agent' ? (
            <img src="/oorja-logo.png" alt="Oorja" className="flex-shrink-0 w-7 h-7 rounded-full object-cover" />
          ) : (
            <div className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center bg-blue-100 text-blue-600">
              <User size={16} />
            </div>
          )}

          {/* Bubble */}
          <div className="max-w-[80%] flex flex-col gap-1.5">
            {/* Hide text bubble when premium UI cards are present (topDeals, matchedOffers, orderConfirmation, earnings, offerCreated) */}
            {!(msg.role === 'agent' && (msg.topDeals || msg.matchedOffers || msg.orderConfirmation || msg.earnings || msg.offerCreated)) && (
              <div
                className={`relative px-3.5 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap ${msg.role === 'agent'
                    ? 'bg-gray-100 text-gray-900 rounded-2xl rounded-bl-md'
                    : 'bg-teal-600 text-white rounded-2xl rounded-br-md'
                  }`}
              >
                {msg.content}

                {/* Speaker button for agent messages */}
                {msg.role === 'agent' && showSpeaker && msg.content.length > 0 && (
                  <span className="inline-block ml-1.5 align-middle">
                    <InlineSpeakerButton
                      text={msg.content}
                      languageCode={responseLanguage}
                    />
                  </span>
                )}
              </div>
            )}

            {/* Dashboard card */}
            {msg.role === 'agent' && msg.dashboard && (
              <DashboardCard
                data={msg.dashboard}
                language={responseLanguage}
                onExplain={(field) => {
                  // Localized field names for display
                  const fieldNames: Record<string, { en: string; hi: string }> = {
                    balance: { en: 'Balance', hi: 'बैलेंस' },
                    trust: { en: 'Trust', hi: 'भरोसा' },
                    tradelimit: { en: 'Trade Limit', hi: 'बेचने की सीमा' },
                    seller: { en: 'Selling', hi: 'बिक्री' },
                    buyer: { en: 'Buying', hi: 'खरीदारी' },
                  };
                  const isHindi = responseLanguage === 'hi-IN';
                  const name = fieldNames[field] || { en: field, hi: field };
                  const displayText = isHindi ? `${name.hi} क्या है?` : `What is ${name.en}?`;
                  onButtonClick?.(`explain:${field}`, displayText);
                }}
              />
            )}

            {/* Listings card for seller view */}
            {msg.role === 'agent' && msg.listings && msg.listings.listings.length > 0 && (
              <ListingCard
                data={msg.listings}
                language={responseLanguage}
              />
            )}

            {/* Offer created card for new listing */}
            {msg.role === 'agent' && msg.offerCreated && (
              <OfferCreatedCard
                data={msg.offerCreated}
                language={responseLanguage}
              />
            )}

            {/* Top deals card for buyer flow */}
            {msg.role === 'agent' && msg.topDeals && (
              <TopDealsCard
                data={msg.topDeals}
                language={responseLanguage}
                onQuickBuy={(offerId, qty) => onButtonClick?.(
                  `buy_deal:${offerId}:${qty}`,
                  responseLanguage === 'hi-IN' ? `${qty} यूनिट खरीदो` : `Buy ${qty} units`
                )}
                onCustomAmount={() => onButtonClick?.(
                  'buy_custom',
                  responseLanguage === 'hi-IN' ? 'अपनी मात्रा' : 'Custom amount'
                )}
              />
            )}

            {/* Matched offers card for buyer flow */}
            {msg.role === 'agent' && msg.matchedOffers && (
              <MatchedOffersCard
                data={msg.matchedOffers}
                language={responseLanguage}
                onAccept={() => onButtonClick?.(
                  'purchase_offer_confirm:yes',
                  responseLanguage === 'hi-IN' ? 'मंज़ूर' : 'Accept'
                )}
                onCancel={() => onButtonClick?.(
                  'purchase_offer_confirm:no',
                  responseLanguage === 'hi-IN' ? 'रद्द करो' : 'Cancel'
                )}
              />
            )}

            {/* Order confirmation card for buyer flow */}
            {msg.role === 'agent' && msg.orderConfirmation && (
              <OrderConfirmationCard
                data={msg.orderConfirmation}
                language={responseLanguage}
              />
            )}

            {/* Earnings card */}
            {msg.role === 'agent' && msg.earnings && (
              <EarningsCard
                data={msg.earnings}
                language={responseLanguage}
              />
            )}

            {/* Auto-trade status card */}
            {msg.role === 'agent' && msg.autoTradeStatus && (
              <AutoTradeStatusCard
                data={msg.autoTradeStatus}
                language={responseLanguage}
              />
            )}

            {/* Slider input for quantity/price selection */}
            {msg.role === 'agent' && msg.slider && (
              <SliderInput
                type={msg.slider.type}
                min={msg.slider.min}
                max={msg.slider.max}
                step={msg.slider.step}
                defaultValue={msg.slider.defaultValue}
                unit={msg.slider.unit}
                callbackPrefix={msg.slider.callbackPrefix}
                language={responseLanguage}
                onSelect={(callbackData) => onButtonClick?.(callbackData, '')}
              />
            )}

            {/* Offer cards for buy flow */}
            {msg.role === 'agent' && msg.offers && msg.offers.length > 0 && (
              <div className="mt-2">
                <OfferList
                  offers={msg.offers}
                  onSelectOffer={(id) => onSelectOffer?.(id)}
                  language={responseLanguage}
                />
              </div>
            )}

            {/* Inline buttons - hide when premium UI cards are present (they have their own buttons) */}
            {msg.role === 'agent' && msg.buttons && msg.buttons.length > 0 && !(msg.topDeals || msg.matchedOffers) && (
              <div className="flex flex-wrap gap-1.5 ml-1">
                {msg.buttons.map((btn, j) => {
                  const isVoiceBtn = isVoicePrefButton(btn.callbackData);
                  const isSelected = isVoiceBtn && btn.callbackData === selectedVoicePref;
                  const isVoiceDisabled = isVoiceBtn && selectedVoicePref !== null;

                  if (isVoiceBtn) {
                    // Voice preference buttons - show locked state with selection indicator
                    return (
                      <div
                        key={j}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${isSelected
                            ? 'bg-teal-600 text-white'
                            : isVoiceDisabled
                              ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                              : 'text-teal-700 bg-teal-50 border border-teal-200'
                          }`}
                        title={isVoiceDisabled ? 'Voice setting now controlled from header' : undefined}
                      >
                        {isSelected && <Check size={12} className="shrink-0" />}
                        {btn.text}
                      </div>
                    );
                  }

                  // Regular buttons
                  return (
                    <button
                      key={j}
                      onClick={() => onButtonClick?.(btn.callbackData || btn.text, btn.text)}
                      className="px-3 py-1.5 text-xs font-medium text-teal-700 bg-teal-50 border border-teal-200 rounded-full hover:bg-teal-100 transition-colors"
                    >
                      {btn.text}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ))}

      {/* Typing indicator */}
      {isLoading && (
        <div className="flex items-end gap-2">
          <img src="/oorja-logo.png" alt="Oorja" className="flex-shrink-0 w-7 h-7 rounded-full object-cover" />
          <div className="bg-gray-100 rounded-2xl rounded-bl-md px-4 py-3">
            <div className="flex gap-1">
              <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
