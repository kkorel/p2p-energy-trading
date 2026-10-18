'use client';

import { useState, useEffect, useCallback } from 'react';
import { Plus, Package, Tag, ShoppingBag, Sun, Wind, Droplets, Trash2, Clock, AlertCircle, CheckCircle, XCircle, AlertTriangle, CloudSun } from 'lucide-react';
import Link from 'next/link';
import { AppShell } from '@/components/layout/app-shell';
import { AddOfferSheet } from '@/components/sell/add-offer-sheet';
import { Card, Button, Badge, EmptyState, SkeletonList, useToast, useConfirm } from '@/components/ui';
import { sellerApi, type Offer, type Order, type Provider, type WeatherCapacityResponse } from '@/lib/api';
import { useAuth } from '@/contexts/auth-context';
import { useDataUpdate, useDataUpdateActions } from '@/contexts/data-update-context';
import { formatCurrency, formatTime, formatDateTime, truncateId, cn } from '@/lib/utils';

const sourceIcons: Record<string, typeof Sun> = {
  SOLAR: Sun,
  WIND: Wind,
  HYDRO: Droplets,
};

type Tab = 'offers' | 'orders';

export default function SellPage() {
  const { user, refreshUser } = useAuth();
  const { showToast } = useToast();
  const { confirm } = useConfirm();
  const { ordersVersion, offersVersion } = useDataUpdate();
  const { triggerOfferUpdate, triggerOrderUpdate } = useDataUpdateActions();
  const [activeTab, setActiveTab] = useState<Tab>('offers');
  const [isLoading, setIsLoading] = useState(true);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [cancellingOrderId, setCancellingOrderId] = useState<string | null>(null);

  const [showAddOffer, setShowAddOffer] = useState(false);
  const [quotaStats, setQuotaStats] = useState<{
    totalSold: number;
    totalUnsoldInOffers: number;
    totalCommitted: number;
  } | null>(null);
  const [weatherData, setWeatherData] = useState<WeatherCapacityResponse | null>(null);
  const [isLoadingWeather, setIsLoadingWeather] = useState(false);

  // Check if user has set production capacity
  const hasProductionCapacity = user?.productionCapacity && user.productionCapacity > 0;

  // Calculate trade limit
  const tradeLimit = hasProductionCapacity
    ? (user.productionCapacity! * (user.allowedTradeLimit ?? 10)) / 100
    : 0;

  // Use quota stats from backend (tracks sold orders permanently)
  // totalCommitted = sold (from orders) + unsold (in active offers)
  const totalCommitted = quotaStats?.totalCommitted ?? 0;
  const totalSold = quotaStats?.totalSold ?? 0;
  const totalUnsoldInOffers = quotaStats?.totalUnsoldInOffers ?? 0;

  // Remaining capacity
  const remainingCapacity = Math.max(0, tradeLimit - totalCommitted);

  const handleCreateOffer = () => {
    if (!hasProductionCapacity) {
      showToast({
        type: 'warning',
        title: 'Set Production Capacity',
        message: 'Please set your production capacity in Profile before creating offers.',
      });
      return;
    }
    if (remainingCapacity <= 0) {
      showToast({
        type: 'error',
        title: 'Trade Limit Reached',
        message: `You've reached your trade limit of ${tradeLimit.toFixed(1)} kWh. Delete an offer or increase your trust score.`,
      });
      return;
    }
    setShowAddOffer(true);
  };

  const loadData = useCallback(async () => {
    try {
      setIsLoading(true);
      const [profileData, ordersData] = await Promise.all([
        sellerApi.getMyProfile(),
        sellerApi.getMyOrders(),
      ]);

      setProvider(profileData.provider);
      setOffers(profileData.offers);
      setOrders(ordersData.orders);
      if (profileData.quotaStats) {
        setQuotaStats(profileData.quotaStats);
      }
    } catch (error) {
      console.error('Failed to load seller data:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Fetch weather capacity data
  const loadWeather = useCallback(async () => {
    if (!hasProductionCapacity) return;
    setIsLoadingWeather(true);
    try {
      const data = await sellerApi.getWeatherCapacity();
      setWeatherData(data);
    } catch (error) {
      console.error('Failed to load weather data:', error);
      // Silent fail - weather is enhancement, not critical
    } finally {
      setIsLoadingWeather(false);
    }
  }, [hasProductionCapacity]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Load weather data when user has production capacity
  useEffect(() => {
    if (hasProductionCapacity) {
      loadWeather();
    }
  }, [hasProductionCapacity, loadWeather]);

  // Refresh data when triggered by other components (e.g., buyer accepts an offer)
  useEffect(() => {
    // Skip on initial mount (version starts at 0)
    if (ordersVersion > 0 || offersVersion > 0) {
      loadData();
    }
  }, [ordersVersion, offersVersion, loadData]);

  const handleAddOffer = async (data: {
    source_type: string;
    price_per_kwh: number;
    max_qty: number;
    time_window: { startTime: string; endTime: string };
  }) => {
    try {
      await sellerApi.addOfferDirect(data);
      await loadData();
      // Switch to offers tab so user can see their new offer
      setActiveTab('offers');
      showToast({ type: 'success', title: 'Offer created successfully!' });
      // Notify other components (e.g., buy page) that offers have changed
      triggerOfferUpdate();
    } catch (error: any) {
      // Extract error message from API response
      const message = error.message || 'Failed to create offer';
      showToast({ type: 'error', title: message });
      throw error; // Re-throw so the sheet knows it failed
    }
  };

  const handleDeleteOffer = async (offerId: string) => {
    const confirmed = await confirm({
      title: 'Delete Offer?',
      message: 'Are you sure you want to delete this offer? This cannot be undone.',
      confirmText: 'Delete',
      cancelText: 'Keep',
      variant: 'danger',
    });

    if (!confirmed) return;

    try {
      await sellerApi.deleteOffer(offerId);
      await loadData();
      showToast({ type: 'success', title: 'Offer deleted successfully' });
      // Notify other components that offers have changed
      triggerOfferUpdate();
    } catch (error: any) {
      showToast({ type: 'error', title: error.message || 'Failed to delete offer' });
    }
  };

  const handleCancelOrder = async (order: Order) => {
    if (cancellingOrderId) return;

    const quantity = order.itemInfo?.sold_quantity || order.quote?.totalQuantity || 0;
    const confirmed = await confirm({
      title: 'Cancel Order as Seller?',
      message: `Cancelling this order will refund the buyer in full and charge you a 5% platform penalty.\n\nOrder: ${quantity} kWh\nPenalty: 5% of the order total`,
      confirmText: 'Cancel Order',
      cancelText: 'Keep Order',
      variant: 'danger',
    });

    if (!confirmed) return;

    setCancellingOrderId(order.id);
    try {
      const result = await sellerApi.cancelOrder(order.id, 'Seller requested cancellation');
      const refundTotal = result.refundTotal ?? 0;
      const sellerPenalty = result.sellerPenalty ?? 0;

      showToast({
        type: 'success',
        title: 'Order Cancelled',
        message: refundTotal > 0 || sellerPenalty > 0
          ? `Buyer refunded ${formatCurrency(refundTotal)}. Penalty charged: ${formatCurrency(sellerPenalty)}.`
          : 'Order cancelled successfully.',
        duration: 6000,
      });

      await Promise.all([loadData(), refreshUser()]);
      // Notify other components (e.g., buyer's orders page) that orders have changed
      triggerOrderUpdate();
    } catch (error: any) {
      showToast({ type: 'error', title: error.message || 'Failed to cancel order' });
    } finally {
      setCancellingOrderId(null);
    }
  };

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: 'offers', label: 'My Offers', count: offers.length },
    { id: 'orders', label: 'Incoming Orders', count: orders.length },
  ];

  if (isLoading) {
    return (
      <AppShell title="Sell Energy">
        <SkeletonList count={3} />
      </AppShell>
    );
  }

  return (
    <AppShell title="Sell Energy">
      <div className="flex flex-col gap-4">
        {/* Stats - only show when production capacity is set */}
        {provider && hasProductionCapacity && (
          <div className="grid grid-cols-2 gap-3">
            <Card padding="sm" className="text-center">
              <p className="text-xl font-semibold text-[var(--color-primary)]">{offers.length}</p>
              <p className="text-xs text-[var(--color-text-muted)]">Active Offers</p>
            </Card>
            <Card padding="sm" className="text-center">
              <p className="text-xl font-semibold text-[var(--color-success)]">
                {Math.round((user?.trustScore ?? 0.3) * 100)}%
              </p>
              <p className="text-xs text-[var(--color-text-muted)]">Trust Score</p>
            </Card>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-2 overflow-x-auto pb-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex items-center gap-1.5 px-3 h-9 rounded-full text-sm font-medium whitespace-nowrap transition-all duration-[120ms]',
                activeTab === tab.id
                  ? 'bg-[var(--color-text)] text-white'
                  : 'bg-[var(--color-surface)] text-[var(--color-text-secondary)] border border-[var(--color-border)]'
              )}
            >
              {tab.label}
              <span className={cn(
                'px-1.5 py-0.5 rounded-full text-xs',
                activeTab === tab.id
                  ? 'bg-white/20'
                  : 'bg-[var(--color-border)]'
              )}>
                {tab.count}
              </span>
            </button>
          ))}
        </div>

        {/* Production Capacity Warning */}
        {!hasProductionCapacity && (
          <Card className="border-[var(--color-warning)] bg-[var(--color-warning-light)]">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-[var(--color-warning)] flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-medium text-[var(--color-text)]">
                  Set your production capacity
                </p>
                <p className="text-xs text-[var(--color-text-muted)] mt-1">
                  You need to set how much energy you produce monthly before creating offers.
                </p>
                <Link href="/profile">
                  <Button size="sm" className="mt-2">
                    Go to Profile
                  </Button>
                </Link>
              </div>
            </div>
          </Card>
        )}

        {/* Weather Conditions Card */}
        {hasProductionCapacity && weatherData && (
          <Card padding="sm" className="bg-gradient-to-r from-[var(--color-bg-subtle)] to-[var(--color-surface)] border-[var(--color-border)]">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-[var(--color-primary-light)] flex items-center justify-center">
                  <CloudSun className="h-5 w-5 text-[var(--color-primary)]" />
                </div>
                <div>
                  <p className="text-sm text-[var(--color-text-muted)]">Today's Conditions</p>
                  <p className="text-base font-semibold text-[var(--color-text)]">
                    {weatherData.condition}
                  </p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-xs text-[var(--color-text-muted)]">Effective Capacity</p>
                <p className="text-lg font-bold text-[var(--color-primary)]">
                  {weatherData.effectiveCapacity.toFixed(1)} kWh
                </p>
              </div>
            </div>
            {weatherData.bestWindow && (
              <div className="mt-3 pt-3 border-t border-[var(--color-border)]">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-[var(--color-text-muted)]">Best time to sell:</span>
                  <span className="font-medium text-[var(--color-success)]">
                    {weatherData.bestWindow.start} - {weatherData.bestWindow.end}
                  </span>
                </div>
              </div>
            )}
          </Card>
        )}

        {/* Weather loading state */}
        {hasProductionCapacity && isLoadingWeather && !weatherData && (
          <Card padding="sm" className="animate-pulse">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-[var(--color-border)]" />
              <div className="flex-1 space-y-2">
                <div className="h-4 bg-[var(--color-border)] rounded w-32" />
                <div className="h-5 bg-[var(--color-border)] rounded w-40" />
              </div>
            </div>
          </Card>
        )}

        {/* Trade Limit - Simplified Visual */}
        {hasProductionCapacity && (
          <Card padding="sm">
            <div className="space-y-3">
              {/* Advisory Guidance */}
              <div className="flex justify-between items-center">
                <span className="text-sm text-[var(--color-text-muted)]">Recommended to offer:</span>
                <span className={`text-lg font-bold ${remainingCapacity > 0 ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}`}>
                  up to {remainingCapacity.toFixed(0)} kWh
                </span>
              </div>

              {/* Segmented Progress Bar - More visible gray tube */}
              <div className="h-3 bg-gray-200 rounded-full overflow-hidden flex">
                {/* Sold (green) */}
                {totalSold > 0 && (
                  <div
                    className="h-full bg-[var(--color-success)]"
                    style={{ width: `${(totalSold / tradeLimit) * 100}%` }}
                    title={`Sold: ${totalSold.toFixed(0)} kWh`}
                  />
                )}
                {/* Unsold in offers (amber) */}
                {totalUnsoldInOffers > 0 && (
                  <div
                    className="h-full bg-[var(--color-warning)]"
                    style={{ width: `${(totalUnsoldInOffers / tradeLimit) * 100}%` }}
                    title={`In offers: ${totalUnsoldInOffers.toFixed(0)} kWh`}
                  />
                )}
                {/* Remaining is implicit (gray background) */}
              </div>

              {/* Minimal Legend - Only colors, no text */}
              <div className="flex items-center justify-center gap-4 text-xs text-[var(--color-text-muted)]">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-[var(--color-success)]" /> Sold
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-[var(--color-warning)]" /> Listed
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-[var(--color-bg-subtle)] border border-[var(--color-border)]" /> Available
                </span>
              </div>
            </div>
          </Card>
        )}

        {/* Content */}
        {activeTab === 'offers' && (
          <div className="flex flex-col gap-3">
            {offers.length === 0 ? (
              <EmptyState
                icon={<Tag className="h-12 w-12" />}
                title="No offers yet"
                description={hasProductionCapacity
                  ? "Create your first offer to start selling energy"
                  : "Set your production capacity in Profile to create offers"
                }
                action={hasProductionCapacity ? {
                  label: 'Create Offer',
                  onClick: handleCreateOffer,
                } : undefined}
              />
            ) : (
              <>
                {offers.map((offer) => {
                  const sourceType = offer.source_type || 'SOLAR';
                  const SourceIcon = sourceIcons[sourceType] || Package;

                  return (
                    <Card key={offer.id}>
                      <div className="flex items-start justify-between mb-2">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-[10px] bg-[var(--color-primary-light)] flex items-center justify-center">
                            <SourceIcon className="h-5 w-5 text-[var(--color-primary)]" />
                          </div>
                          <div>
                            <p className="text-sm font-medium text-[var(--color-text)]">
                              {sourceType} Energy
                            </p>
                            <p className="text-base font-semibold text-[var(--color-primary)]">
                              {formatCurrency(offer.price.value)}/kWh
                            </p>
                          </div>
                        </div>
                        <button
                          onClick={() => handleDeleteOffer(offer.id)}
                          className="p-2 -mr-2 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition-colors"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)] mb-2">
                        <Clock className="h-3.5 w-3.5" />
                        <span>
                          {offer.timeWindow
                            ? `${formatDateTime(offer.timeWindow.startTime)} - ${formatTime(offer.timeWindow.endTime)}`
                            : 'Flexible timing'
                          }
                        </span>
                      </div>
                      {offer.blockStats && (
                        <Badge variant="success">{offer.blockStats.available} kWh available</Badge>
                      )}
                    </Card>
                  );
                })}
                <Button
                  variant="secondary"
                  fullWidth
                  onClick={handleCreateOffer}
                  disabled={!hasProductionCapacity}
                >
                  <Plus className="h-4 w-4" />
                  Create Offer
                </Button>
              </>
            )}
          </div>
        )}

        {activeTab === 'orders' && (
          <div className="flex flex-col gap-3">
            {orders.length === 0 ? (
              <EmptyState
                icon={<ShoppingBag className="h-12 w-12" />}
                title="No incoming orders yet"
                description="Orders will appear here when buyers purchase your energy"
              />
            ) : (
              orders.map((order) => {
                const SourceIcon = order.itemInfo?.source_type ? sourceIcons[order.itemInfo.source_type] || Package : Package;
                return (
                  <Card key={order.id}>
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-[10px] bg-[var(--color-primary-light)] flex items-center justify-center">
                          <SourceIcon className="h-5 w-5 text-[var(--color-primary)]" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-[var(--color-text)]">
                            {order.itemInfo?.source_type || 'Energy'} Purchase
                          </p>
                          <p className="text-xs text-[var(--color-text-muted)]">
                            {formatDateTime(order.created_at)}
                          </p>
                        </div>
                      </div>
                      <Badge
                        variant={
                          order.status === 'ACTIVE' ? 'success' :
                            order.status === 'PENDING' ? 'warning' : 'default'
                        }
                      >
                        {order.status}
                      </Badge>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <p className="text-xs text-[var(--color-text-muted)]">Quantity</p>
                        <p className="font-medium text-[var(--color-text)]">
                          {order.itemInfo?.sold_quantity || order.quote?.totalQuantity || 0} kWh
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-[var(--color-text-muted)]">Rate</p>
                        <p className="font-medium text-[var(--color-text)]">
                          {formatCurrency(order.itemInfo?.price_per_kwh || 0)}/kWh
                        </p>
                      </div>
                    </div>

                    {/* Delivery Time */}
                    {(order as any).deliveryTime && (
                      <div className="flex items-center gap-2 mt-2 p-2 bg-[var(--color-surface)] rounded-lg">
                        <Clock className="h-4 w-4 text-[var(--color-text-muted)]" />
                        <span className="text-xs text-[var(--color-text-muted)]">
                          Delivery: {formatDateTime((order as any).deliveryTime.start)}
                          {(order as any).deliveryTime.end && ` - ${formatTime((order as any).deliveryTime.end)}`}
                        </span>
                      </div>
                    )}
                    {/* Payment Info - Differs by status */}
                    <div className="flex justify-between items-center mt-3 pt-3 border-t border-[var(--color-border)]">
                      {order.status === 'CANCELLED' && (order as any).cancellation ? (
                        // Cancelled - show compensation (buyer cancel) or penalty (seller cancel)
                        (String((order as any).cancellation.cancelledBy || '').startsWith('SELLER:') ? (
                          <>
                            <span className="text-sm text-[var(--color-text-muted)]">Penalty (5%)</span>
                            <span className="text-base font-semibold text-[var(--color-danger)]">
                              -{formatCurrency((order as any).cancellation.penalty || 0)}
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="text-sm text-[var(--color-text-muted)]">Compensation (5%)</span>
                            <span className="text-base font-semibold text-[var(--color-success)]">
                              +{formatCurrency((order as any).cancellation.compensation || 0)}
                            </span>
                          </>
                        ))
                      ) : (order as any).paymentStatus === 'RELEASED' ? (
                        // Payment released after delivery
                        <>
                          <span className="text-sm text-[var(--color-text-muted)]">Received</span>
                          <span className="text-base font-semibold text-[var(--color-success)]">
                            +{formatCurrency(order.quote?.price?.value || 0)}
                          </span>
                        </>
                      ) : order.quote ? (
                        // Payment in escrow
                        <>
                          <span className="text-sm text-[var(--color-text-muted)]">In Escrow</span>
                          <span className="text-base font-semibold text-[var(--color-warning)]">
                            {formatCurrency(order.quote.price.value)}
                          </span>
                        </>
                      ) : null}
                    </div>

                    {/* Seller Cancel Button */}
                    {(() => {
                      const isCancelableStatus = order.status === 'ACTIVE' || order.status === 'PENDING';
                      if (!isCancelableStatus) return null;

                      const deliveryStart = (order as any).deliveryTime?.start
                        ? new Date((order as any).deliveryTime.start)
                        : null;
                      const now = new Date();
                      const minCancelBuffer = 30 * 60 * 1000;
                      const canCancel = !deliveryStart || (deliveryStart.getTime() - now.getTime() >= minCancelBuffer);
                      const minutesRemaining = deliveryStart
                        ? Math.max(0, Math.floor((deliveryStart.getTime() - now.getTime()) / 60000))
                        : null;

                      if (!canCancel) {
                        return (
                          <div className="mt-3 p-2 bg-[var(--color-warning-light)] rounded-lg">
                            <p className="text-xs text-[var(--color-warning)] text-center">
                              Cannot cancel within 30 min of delivery ({minutesRemaining} min remaining)
                            </p>
                          </div>
                        );
                      }

                      return (
                        <div className="mt-3">
                          <Button
                            variant="danger"
                            size="sm"
                            fullWidth
                            onClick={() => handleCancelOrder(order)}
                            loading={cancellingOrderId === order.id}
                            disabled={!!cancellingOrderId}
                          >
                            Cancel Order
                          </Button>
                        </div>
                      );
                    })()}

                    {/* Fulfillment Status (DISCOM Verification) */}
                    {order.fulfillment && (
                      <div className={`mt-3 p-3 rounded-lg ${order.fulfillment.status === 'FULL'
                        ? 'bg-[var(--color-success-light)]'
                        : order.fulfillment.status === 'PARTIAL'
                          ? 'bg-[var(--color-warning-light)]'
                          : 'bg-[var(--color-danger-light)]'
                        }`}>
                        <div className="flex items-center gap-2 mb-2">
                          {order.fulfillment.status === 'FULL' ? (
                            <CheckCircle className="h-4 w-4 text-[var(--color-success)]" />
                          ) : order.fulfillment.status === 'PARTIAL' ? (
                            <AlertTriangle className="h-4 w-4 text-[var(--color-warning)]" />
                          ) : (
                            <XCircle className="h-4 w-4 text-[var(--color-danger)]" />
                          )}
                          <span className={`text-sm font-medium ${order.fulfillment.status === 'FULL'
                            ? 'text-[var(--color-success)]'
                            : order.fulfillment.status === 'PARTIAL'
                              ? 'text-[var(--color-warning)]'
                              : 'text-[var(--color-danger)]'
                            }`}>
                            {order.fulfillment.status === 'FULL'
                              ? 'Fully Delivered'
                              : order.fulfillment.status === 'PARTIAL'
                                ? 'Partially Delivered'
                                : 'Delivery Failed'}
                          </span>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div>
                            <span className="text-[var(--color-text-muted)]">Delivered: </span>
                            <span className="font-medium text-[var(--color-text)]">
                              {order.fulfillment.deliveredQty} / {order.fulfillment.expectedQty} kWh
                            </span>
                          </div>
                          <div>
                            <span className="text-[var(--color-text-muted)]">Ratio: </span>
                            <span className="font-medium text-[var(--color-text)]">
                              {(order.fulfillment.deliveryRatio * 100).toFixed(0)}%
                            </span>
                          </div>
                        </div>
                        <div className="mt-2 pt-2 border-t border-[var(--color-border)] text-xs">
                          <span className="text-[var(--color-text-muted)]">Trust Impact: </span>
                          <span className={`font-medium ${order.fulfillment.trustImpact >= 0
                            ? 'text-[var(--color-success)]'
                            : 'text-[var(--color-danger)]'
                            }`}>
                            {order.fulfillment.trustImpact >= 0 ? '+' : ''}{(order.fulfillment.trustImpact * 100).toFixed(1)}%
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Pending verification indicator */}
                    {order.status === 'COMPLETED' && !order.fulfillment && (
                      <div className="mt-3 p-2 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)]">
                        <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                          <Clock className="h-3.5 w-3.5 animate-pulse" />
                          <span>Awaiting DISCOM verification...</span>
                        </div>
                      </div>
                    )}

                    <p className="text-xs text-[var(--color-text-muted)] mt-2">
                      Order ID: {truncateId(order.id)}
                    </p>
                  </Card>
                );
              })
            )}
          </div>
        )}

        {/* Add Offer Sheet */}
        <AddOfferSheet
          open={showAddOffer}
          onClose={() => setShowAddOffer(false)}
          onSubmit={handleAddOffer}
        />
      </div>
    </AppShell>
  );
}
