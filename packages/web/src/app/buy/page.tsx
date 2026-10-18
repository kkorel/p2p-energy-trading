'use client';

import { useState, useCallback } from 'react';
import { Zap, Package, ChevronDown, ArrowLeft } from 'lucide-react';
import { AppShell } from '@/components/layout/app-shell';
import { DiscoverForm } from '@/components/buy/discover-form';
import { OfferCard } from '@/components/buy/offer-card';
import { OrderSheet } from '@/components/buy/order-sheet';
import { SmartOrderSheet } from '@/components/buy/smart-order-sheet';
import { EmptyState, SkeletonList, Badge, Button } from '@/components/ui';
import { buyerApi, type Offer, type TransactionState, type SmartBuyResponse } from '@/lib/api';
import { useP2PStats } from '@/contexts/p2p-stats-context';

interface DiscoveredOffer {
  offer: Offer;
  providerId: string;
  providerName: string;
  sourceType: string;
  availableQty: number;
  score?: number;
  matchesFilters?: boolean;
  filterReasons?: string[];
  scoreBreakdown?: {
    priceScore: number;
    trustScore: number;
    timeWindowFitScore: number;
  };
}

// Pagination settings
const ITEMS_PER_PAGE = 10;

export default function BuyPage() {
  const { refresh: refreshStats } = useP2PStats();
  const [isLoading, setIsLoading] = useState(false);
  const [transaction, setTransaction] = useState<TransactionState | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);

  // Smart buy state
  const [smartSelection, setSmartSelection] = useState<SmartBuyResponse | null>(null);
  const [smartOrderSheetOpen, setSmartOrderSheetOpen] = useState(false);

  // Browse mode state (manual offer selection)
  const [browseMode, setBrowseMode] = useState(false);
  const [offers, setOffers] = useState<DiscoveredOffer[]>([]);
  const [selectedOffer, setSelectedOffer] = useState<DiscoveredOffer | null>(null);
  const [orderSheetOpen, setOrderSheetOpen] = useState(false);
  const [requestedQuantity, setRequestedQuantity] = useState(10);
  const [visibleCount, setVisibleCount] = useState(ITEMS_PER_PAGE);
  const [browseTimeWindow, setBrowseTimeWindow] = useState<{ startTime: string; endTime: string } | null>(null);

  // Main smart buy handler
  const handleSmartBuy = useCallback(async (params: {
    sourceType?: string;
    quantity: number;
    timeWindow: { startTime: string; endTime: string };
  }) => {
    setIsLoading(true);
    setDiscoveryError(null);
    setSmartSelection(null);
    setBrowseMode(false);
    setOffers([]);

    try {
      // First run discovery to get the catalog
      const discoverResult = await buyerApi.discover({
        sourceType: params.sourceType,
        minQuantity: 1, // Get all offers
        timeWindow: params.timeWindow,
      });

      // Wait for catalog
      let attempts = 0;
      const maxAttempts = 30;
      let catalogReceived = false;

      while (attempts < maxAttempts) {
        await new Promise(r => setTimeout(r, 500));

        const txState = await buyerApi.getTransaction(discoverResult.transaction_id);
        setTransaction(txState);

        if (txState.error) {
          setDiscoveryError(txState.error);
          return;
        }

        if (txState.catalog) {
          catalogReceived = true;
          break;
        }

        attempts++;
      }

      if (!catalogReceived) {
        setDiscoveryError('Discovery timed out. Please try again.');
        return;
      }

      // Run smart buy selection
      const smartResult = await buyerApi.smartBuy({
        transaction_id: discoverResult.transaction_id,
        smartBuy: true,
        quantity: params.quantity,
        requestedTimeWindow: params.timeWindow,
      });

      console.log('Smart buy result:', smartResult);

      // Handle "no eligible offers" response
      if (smartResult.status === 'no_eligible_offers' || smartResult.selectedOffers?.length === 0) {
        let message = smartResult.error || 'No matching offers found.';
        // Add suggestion about available time windows
        if (smartResult.availableWindows && smartResult.availableWindows.length > 0) {
          const windowStrs = smartResult.availableWindows.slice(0, 3).map(tw => {
            const s = new Date(tw.startTime);
            const e = new Date(tw.endTime);
            return `${s.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} ${s.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}-${e.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
          });
          message += ` Available windows: ${windowStrs.join(', ')}`;
        } else if (smartResult.offersAvailable && smartResult.offersAvailable > 0) {
          message += ` ${smartResult.offersAvailable} offers exist but none match your time window.`;
        }
        setDiscoveryError(message);
        return;
      }

      setSmartSelection(smartResult);
      setSmartOrderSheetOpen(true);
    } catch (error: any) {
      console.error('Smart buy failed:', error);
      setDiscoveryError(error?.message || 'Failed to find offers');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Browse mode: discover all offers for manual selection
  const handleBrowse = useCallback(async (params: {
    sourceType?: string;
    timeWindow: { startTime: string; endTime: string };
  }) => {
    // Use the time window from the form
    const timeWindow = params.timeWindow;

    setIsLoading(true);
    setBrowseMode(true);
    setOffers([]);
    setSelectedOffer(null);
    setVisibleCount(ITEMS_PER_PAGE);
    setDiscoveryError(null);
    setBrowseTimeWindow(timeWindow);

    try {
      const result = await buyerApi.discover({
        sourceType: params.sourceType,
        minQuantity: 1,
        timeWindow,
      });

      let attempts = 0;
      const maxAttempts = 30;
      let catalogReceived = false;

      while (attempts < maxAttempts) {
        await new Promise(r => setTimeout(r, 500));

        const txState = await buyerApi.getTransaction(result.transaction_id);
        setTransaction(txState);

        if (txState.error) {
          setDiscoveryError(txState.error);
          break;
        }

        if (txState.catalog) {
          catalogReceived = true;

          if (txState.catalog.providers && txState.catalog.providers.length > 0) {
            const discoveredOffers: DiscoveredOffer[] = [];

            for (const provider of txState.catalog.providers) {
              if (!provider.items) continue;

              for (const item of provider.items) {
                if (!item.offers) continue;

                for (const offer of item.offers) {
                  const matchedOffer = txState.matchingResults?.allOffers?.find(
                    m => m.offer.id === offer.id
                  );

                  discoveredOffers.push({
                    offer,
                    providerId: provider.id,
                    providerName: provider.descriptor?.name || 'Provider',
                    sourceType: item.itemAttributes?.sourceType || 'MIXED',
                    availableQty: offer.maxQuantity || item.itemAttributes?.availableQuantity || 0,
                    score: matchedOffer?.score,
                    matchesFilters: matchedOffer?.matchesFilters ?? true,
                    filterReasons: matchedOffer?.filterReasons,
                    scoreBreakdown: matchedOffer?.breakdown,
                  });
                }
              }
            }

            discoveredOffers.sort((a, b) => {
              if (a.score !== undefined && b.score !== undefined) {
                return b.score - a.score;
              }
              return a.offer.price.value - b.offer.price.value;
            });

            setOffers(discoveredOffers);
          } else {
            setOffers([]);
          }
          break;
        }

        attempts++;
      }

      if (!catalogReceived && attempts >= maxAttempts) {
        setDiscoveryError('Discovery timed out. Please try again.');
      }
    } catch (error) {
      console.error('Browse failed:', error);
      setDiscoveryError(error instanceof Error ? error.message : 'Discovery failed');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Exit browse mode
  const handleExitBrowse = () => {
    setBrowseMode(false);
    setOffers([]);
    setSelectedOffer(null);
    setTransaction(null);
    setDiscoveryError(null);
  };

  const handleSelectOffer = (offer: DiscoveredOffer) => {
    setSelectedOffer(offer);
    setRequestedQuantity(Math.min(offer.availableQty, 50)); // Default to min of available or 50
    setOrderSheetOpen(true);
  };

  // Manual order confirmation (browse mode)
  const handleConfirmOrder = async (quantity: number) => {
    if (!selectedOffer || !transaction) return null;

    try {
      const txId = transaction.transaction_id;

      await buyerApi.select({
        transaction_id: txId,
        offer_id: selectedOffer.offer.id,
        quantity,
      });

      await new Promise(r => setTimeout(r, 500));
      await buyerApi.init(txId);
      await new Promise(r => setTimeout(r, 500));

      let txState = await buyerApi.getTransaction(txId);
      const previousOrderId = txState.order?.id;
      let attempts = 0;

      while (attempts < 10) {
        await new Promise(r => setTimeout(r, 500));
        txState = await buyerApi.getTransaction(txId);

        if (txState.error) break;
        if (txState.order && txState.order.id !== previousOrderId) break;
        attempts++;
      }

      if (txState.error) {
        throw new Error(txState.error);
      }

      if (!txState.order) {
        throw new Error('Order creation failed. Please try again.');
      }

      await buyerApi.confirm(txId, txState.order.id);
      await new Promise(r => setTimeout(r, 500));
      txState = await buyerApi.getTransaction(txId);

      if (txState.order) {
        setOffers(prevOffers => prevOffers.map(o => {
          if (o.offer.id === selectedOffer.offer.id) {
            const newAvailableQty = Math.max(0, o.availableQty - quantity);
            return {
              ...o,
              availableQty: newAvailableQty,
              offer: {
                ...o.offer,
                maxQuantity: Math.max(0, o.offer.maxQuantity - quantity),
              },
            };
          }
          return o;
        }).filter(o => o.availableQty > 0));

        setTransaction(null);
        refreshStats();
      }

      return txState.order || null;
    } catch (error) {
      console.error('Order failed:', error);
      throw error;
    }
  };

  // Smart order confirmation
  const handleSmartConfirm = async () => {
    if (!transaction || !smartSelection) return null;

    try {
      const txId = transaction.transaction_id;

      await buyerApi.init(txId);
      await new Promise(r => setTimeout(r, 500));

      let txState = await buyerApi.getTransaction(txId);
      const previousOrderId = txState.order?.id;
      let attempts = 0;

      while (attempts < 10) {
        await new Promise(r => setTimeout(r, 500));
        txState = await buyerApi.getTransaction(txId);

        if (txState.error) break;
        if (txState.order && txState.order.id !== previousOrderId) break;
        attempts++;
      }

      if (txState.error) {
        throw new Error(txState.error);
      }

      if (!txState.order) {
        throw new Error('Order creation failed. Please try again.');
      }

      await buyerApi.confirm(txId, txState.order.id);
      await new Promise(r => setTimeout(r, 500));
      txState = await buyerApi.getTransaction(txId);

      if (txState.order) {
        setTransaction(null);
        setSmartSelection(null);
        refreshStats();
      }

      return txState.order || null;
    } catch (error) {
      console.error('Order failed:', error);
      throw error;
    }
  };

  return (
    <AppShell title="Buy Energy">
      <div className="flex flex-col gap-4">
        {/* Browse mode header */}
        {browseMode && (
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={handleExitBrowse}>
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back
            </Button>
            <span className="text-sm text-[var(--color-text-muted)]">
              Browsing all offers
            </span>
          </div>
        )}

        {/* Discover Form - hidden in browse mode */}
        {!browseMode && (
          <DiscoverForm
            onSmartBuy={handleSmartBuy}
            onBrowse={handleBrowse}
            isLoading={isLoading}
          />
        )}

        {/* Results section */}
        <div>
          {isLoading ? (
            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-base font-semibold text-[var(--color-text)]">
                  {browseMode ? 'Loading Offers...' : 'Finding Best Deal...'}
                </h2>
              </div>
              <SkeletonList count={3} />
            </div>
          ) : discoveryError ? (
            <EmptyState
              icon={<Package className="h-12 w-12" />}
              title="No Offers Found"
              description={discoveryError}
            />
          ) : browseMode && offers.length > 0 ? (
            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-base font-semibold text-[var(--color-text)]">
                  Available Offers
                </h2>
                <Badge variant="primary">{offers.length} found</Badge>
              </div>
              <div className="flex flex-col gap-3">
                {offers.slice(0, visibleCount).map((item) => {
                  // Use composite key to handle same offer ID across different providers
                  const uniqueKey = `${item.providerId}-${item.offer.id}`;
                  const selectedKey = selectedOffer ? `${selectedOffer.providerId}-${selectedOffer.offer.id}` : null;
                  return (
                    <OfferCard
                      key={uniqueKey}
                      offer={item.offer}
                      providerName={item.providerName}
                      sourceType={item.sourceType}
                      availableQty={item.availableQty}
                      score={item.score}
                      matchesFilters={item.matchesFilters}
                      filterReasons={item.filterReasons}
                      scoreBreakdown={item.scoreBreakdown}
                      isSelected={uniqueKey === selectedKey}
                      onSelect={() => handleSelectOffer(item)}
                    />
                  );
                })}
              </div>

              {offers.length > visibleCount && (
                <Button
                  variant="secondary"
                  className="w-full mt-4"
                  onClick={() => setVisibleCount(prev => prev + ITEMS_PER_PAGE)}
                >
                  <ChevronDown className="h-4 w-4 mr-2" />
                  Load More ({offers.length - visibleCount} remaining)
                </Button>
              )}
            </div>
          ) : browseMode ? (
            <EmptyState
              icon={<Package className="h-12 w-12" />}
              title="No offers found"
              description="No energy offers available at the moment"
            />
          ) : (
            <EmptyState
              icon={<Zap className="h-12 w-12" />}
              title="Buy Energy"
              description="Enter the amount you need and we'll find the best deal for you"
            />
          )}
        </div>

        {/* Smart Order Sheet (unified single/multi) */}
        <SmartOrderSheet
          open={smartOrderSheetOpen}
          onClose={() => setSmartOrderSheetOpen(false)}
          selection={smartSelection}
          onConfirm={handleSmartConfirm}
          trustWarning={transaction?.trustWarning}
        />

        {/* Manual Order Sheet (browse mode) */}
        <OrderSheet
          open={orderSheetOpen}
          onClose={() => setOrderSheetOpen(false)}
          offer={selectedOffer?.offer || null}
          providerId={selectedOffer?.providerId}
          providerName={selectedOffer?.providerName || ''}
          initialQuantity={requestedQuantity}
          onConfirm={handleConfirmOrder}
          trustWarning={transaction?.trustWarning}
        />
      </div>
    </AppShell>
  );
}
