'use client';

import { useState, useEffect, useCallback } from 'react';
import { ShoppingBag, Sun, Wind, Droplets, Package, ArrowDownLeft, ArrowUpRight, X, Clock, Zap, AlertTriangle } from 'lucide-react';
import { AppShell } from '@/components/layout/app-shell';
import { Card, Badge, EmptyState, SkeletonList, Button, useToast, useConfirm } from '@/components/ui';
import { buyerApi, sellerApi, ApiError } from '@/lib/api';
import { formatCurrency, formatDateTime, formatTime, truncateId } from '@/lib/utils';
import { useAuth } from '@/contexts/auth-context';
import { useDataUpdate, useDataUpdateActions } from '@/contexts/data-update-context';

const sourceIcons: Record<string, typeof Sun> = {
  SOLAR: Sun,
  WIND: Wind,
  HYDRO: Droplets,
};

type OrderType = 'bought' | 'sold';

interface UnifiedOrder {
  id: string;
  transactionId: string;
  type: OrderType;
  status: string;
  paymentStatus: string;
  sourceType: string;
  providerName?: string;
  quantity: number;
  pricePerKwh: number;
  totalPrice: number;
  createdAt: string;
  deliveryTime?: {
    start: string;
    end?: string;
  };
  // For cancelled orders
  cancellation?: {
    cancelledAt?: string;
    cancelledBy?: string;
    reason?: string;
    penalty?: number | null;
    refund?: number | null;
    compensation?: number | null; // 5% seller gets when buyer cancels
  };
  // Trust impact
  trustImpact?: {
    previousScore: number;
    newScore: number;
    change: number;
    reason: string;
  };
  // DISCOM verification / delivery status
  fulfillment?: {
    verified: boolean;
    deliveredQty: number;
    expectedQty: number;
    deliveryRatio: number;
    status: 'FULL' | 'PARTIAL' | 'FAILED';
    trustImpact: number;
    verifiedAt: string;
    sellerPayment?: number;
    discomPenalty?: number;
  };
  // Bulk order info
  isBulkOrder?: boolean;
  isPartOfBulkPurchase?: boolean; // This order is one of multiple from bulk buy
  bulkGroupId?: string; // Links orders from same bulk purchase
  totalItemCount?: number;
  totalProviderCount?: number;
  providers?: Array<{ id: string; name: string }>;
}

export default function OrdersPage() {
  const { isAuthenticated, isLoading: authLoading, user, refreshUser } = useAuth();
  const { showToast } = useToast();
  const { confirm } = useConfirm();
  const { ordersVersion } = useDataUpdate();
  const { triggerOrderUpdate } = useDataUpdateActions();
  const [isLoading, setIsLoading] = useState(true);
  const [orders, setOrders] = useState<UnifiedOrder[]>([]);
  const [filter, setFilter] = useState<'all' | 'bought' | 'sold'>('all');
  const [cancellingOrderId, setCancellingOrderId] = useState<string | null>(null);

  const loadOrders = useCallback(async () => {
    if (!isAuthenticated) {
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      const allOrders: UnifiedOrder[] = [];

      // Fetch bought orders
      try {
        const buyerData = await buyerApi.getMyOrders();
        for (const order of buyerData.orders) {
          const o = order as any;
          const quantity = order.itemInfo?.quantity || order.quote?.totalQuantity || 0;
          const totalPrice = order.quote?.price?.value || 0;
          // Calculate pricePerKwh: prefer itemInfo, fallback to totalPrice/quantity
          const pricePerKwh = order.itemInfo?.price_per_kwh || (quantity > 0 ? totalPrice / quantity : 0);

          // Bulk order data
          const isBulkOrder = o.isBulkOrder || false;
          const isPartOfBulkPurchase = o.isPartOfBulkPurchase || false;
          const bulkGroupId = o.bulkGroupId || undefined;
          const totalItemCount = o.totalItemCount || 1;
          const totalProviderCount = o.totalProviderCount || 1;
          const providers = o.providers || (order.provider ? [order.provider] : []);

          // For bulk orders, show combined provider names
          let providerName = order.provider?.name || 'Provider';
          if (isBulkOrder && providers.length > 1) {
            providerName = `${providers.length} sellers`;
          }

          allOrders.push({
            id: order.id,
            transactionId: o.transaction_id || order.id,
            type: 'bought',
            status: order.status,
            paymentStatus: o.paymentStatus || 'PENDING',
            sourceType: order.itemInfo?.source_type || 'MIXED',
            providerName,
            quantity,
            pricePerKwh,
            totalPrice,
            createdAt: order.created_at,
            deliveryTime: o.deliveryTime ? {
              start: o.deliveryTime.start,
              end: o.deliveryTime.end,
            } : undefined,
            cancellation: o.cancellation,
            trustImpact: o.trustImpact,
            fulfillment: o.fulfillment,
            // Bulk order fields
            isBulkOrder,
            isPartOfBulkPurchase,
            bulkGroupId,
            totalItemCount: isBulkOrder ? totalItemCount : undefined,
            totalProviderCount: isBulkOrder ? totalProviderCount : undefined,
            providers: isBulkOrder ? providers : undefined,
          });
        }
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 401)) {
          console.error('Failed to load buyer orders:', err);
        }
      }

      // Fetch sold orders (only if user has a provider profile)
      if (user?.providerId) {
        try {
          const sellerData = await sellerApi.getMyOrders();
          for (const order of sellerData.orders) {
            // Avoid duplicates (in case user bought from themselves)
            if (!allOrders.find(o => o.id === order.id)) {
              const o = order as any;
              const itemInfo = o.itemInfo;
              const quantity = itemInfo?.sold_quantity || order.quote?.totalQuantity || 0;
              const totalPrice = order.quote?.price?.value || 0;
              // Calculate pricePerKwh: prefer itemInfo, fallback to totalPrice/quantity
              const pricePerKwh = itemInfo?.price_per_kwh || (quantity > 0 ? totalPrice / quantity : 0);
              allOrders.push({
                id: order.id,
                transactionId: o.transaction_id || order.id,
                type: 'sold',
                status: order.status,
                paymentStatus: o.paymentStatus || 'PENDING',
                sourceType: itemInfo?.source_type || 'MIXED',
                providerName: undefined, // It's the user's own listing
                quantity,
                pricePerKwh,
                totalPrice,
                createdAt: order.created_at,
                deliveryTime: o.deliveryTime ? {
                  start: o.deliveryTime.start,
                  end: o.deliveryTime.end,
                } : undefined,
                cancellation: o.cancellation,
                trustImpact: o.fulfillment ? {
                  previousScore: 0,
                  newScore: 0,
                  change: o.fulfillment.trustImpact || 0,
                  reason: 'DELIVERY',
                } : undefined,
                fulfillment: o.fulfillment,
              });
            }
          }
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 401)) {
            console.error('Failed to load seller orders:', err);
          }
        }
      }

      // Sort by date (newest first)
      allOrders.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setOrders(allOrders);
    } finally {
      setIsLoading(false);
    }
  }, [isAuthenticated, user?.providerId]);

  useEffect(() => {
    if (!authLoading) {
      loadOrders();
    }
  }, [loadOrders, authLoading]);

  // Refresh orders when triggered by other components (e.g., seller cancels an order)
  useEffect(() => {
    // Skip on initial mount (version starts at 0)
    if (ordersVersion > 0) {
      loadOrders();
    }
  }, [ordersVersion, loadOrders]);

  const filteredOrders = orders.filter(order => {
    if (filter === 'all') return true;
    return order.type === filter;
  });

  const boughtCount = orders.filter(o => o.type === 'bought').length;
  const soldCount = orders.filter(o => o.type === 'sold').length;

  // Calculate total energy stats
  const totalBoughtKwh = orders
    .filter(o => o.type === 'bought' && o.status !== 'CANCELLED')
    .reduce((sum, o) => sum + o.quantity, 0);
  const totalSoldKwh = orders
    .filter(o => o.type === 'sold' && o.status !== 'CANCELLED')
    .reduce((sum, o) => sum + o.quantity, 0);

  const getStatusBadgeVariant = (status: string) => {
    switch (status) {
      case 'ACTIVE': return 'success';
      case 'PENDING': return 'warning';
      case 'COMPLETED': return 'primary';
      case 'CANCELLED': return 'danger';
      default: return 'default';
    }
  };

  const handleCancelOrder = async (order: UnifiedOrder) => {
    if (cancellingOrderId) return;

    const confirmed = await confirm({
      title: 'Cancel Order?',
      message: `Are you sure you want to cancel this order for ${order.quantity} kWh?\n\nA 10% cancellation fee will be charged:\n• 5% goes to the seller\n• 5% goes to the platform\n• You receive 90% refund`,
      confirmText: 'Cancel Order',
      cancelText: 'Keep Order',
      variant: 'danger',
    });

    if (!confirmed) return;

    setCancellingOrderId(order.id);
    try {
      const result = await buyerApi.cancelOrder({
        transaction_id: order.transactionId,
        order_id: order.id,
        reason: 'User requested cancellation',
      });

      // Show success toast with financial details
      const financials = (result as any).financials;
      if (financials) {
        showToast({
          type: 'success',
          title: 'Order Cancelled',
          message: `Refunded ₹${financials.refundAmount.toFixed(2)} (10% penalty: ₹${financials.penaltyAmount.toFixed(2)})`,
          duration: 6000,
        });
      } else {
        showToast({
          type: 'success',
          title: 'Order Cancelled',
          message: 'Your order has been cancelled successfully.',
        });
      }

      // Reload orders and refresh user balance
      await Promise.all([loadOrders(), refreshUser()]);
      // Notify other components (e.g., seller's page) that orders have changed
      triggerOrderUpdate();
    } catch (err: any) {
      showToast({
        type: 'error',
        title: 'Cancellation Failed',
        message: err.message || 'Failed to cancel order. Please try again.',
      });
    } finally {
      setCancellingOrderId(null);
    }
  };

  const handleSellerCancelOrder = async (order: UnifiedOrder) => {
    if (cancellingOrderId) return;

    const confirmed = await confirm({
      title: 'Cancel Order as Seller?',
      message: `Cancelling this order will refund the buyer in full and charge you a 5% platform penalty.\n\nOrder: ${order.quantity} kWh\nPenalty: 5% of the order total`,
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

      await Promise.all([loadOrders(), refreshUser()]);
      // Notify other components (e.g., buyer's page) that orders have changed
      triggerOrderUpdate();
    } catch (err: any) {
      showToast({
        type: 'error',
        title: 'Cancellation Failed',
        message: err.message || 'Failed to cancel order. Please try again.',
      });
    } finally {
      setCancellingOrderId(null);
    }
  };

  if (isLoading || authLoading) {
    return (
      <AppShell title="My Orders">
        <SkeletonList count={3} />
      </AppShell>
    );
  }

  return (
    <AppShell title="My Orders">
      <div className="flex flex-col gap-4">
        {/* Energy Summary Card */}
        {orders.length > 0 && (
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-[var(--color-primary-light)] rounded-[14px] p-3">
              <div className="flex items-center gap-2 mb-1">
                <ArrowDownLeft className="w-4 h-4 text-[var(--color-primary)]" />
                <span className="text-xs text-[var(--color-primary)]">Energy Bought</span>
              </div>
              <p className="text-xl font-bold text-[var(--color-primary)]">
                {totalBoughtKwh.toLocaleString()} kWh
              </p>
            </div>
            <div className="bg-[var(--color-success-light)] rounded-[14px] p-3">
              <div className="flex items-center gap-2 mb-1">
                <ArrowUpRight className="w-4 h-4 text-[var(--color-success)]" />
                <span className="text-xs text-[var(--color-success)]">Energy Sold</span>
              </div>
              <p className="text-xl font-bold text-[var(--color-success)]">
                {totalSoldKwh.toLocaleString()} kWh
              </p>
            </div>
          </div>
        )}

        {/* Filter Tabs */}
        <div className="flex gap-2">
          <button
            onClick={() => setFilter('all')}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${filter === 'all'
              ? 'bg-[var(--color-primary)] text-white'
              : 'bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:bg-[var(--color-border-subtle)]'
              }`}
          >
            All ({orders.length})
          </button>
          <button
            onClick={() => setFilter('bought')}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors flex items-center gap-1 ${filter === 'bought'
              ? 'bg-[var(--color-primary)] text-white'
              : 'bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:bg-[var(--color-border-subtle)]'
              }`}
          >
            <ArrowDownLeft className="w-3 h-3" />
            Bought ({boughtCount})
          </button>
          <button
            onClick={() => setFilter('sold')}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors flex items-center gap-1 ${filter === 'sold'
              ? 'bg-[var(--color-primary)] text-white'
              : 'bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:bg-[var(--color-border-subtle)]'
              }`}
          >
            <ArrowUpRight className="w-3 h-3" />
            Sold ({soldCount})
          </button>
        </div>

        {filteredOrders.length === 0 ? (
          <EmptyState
            icon={<ShoppingBag className="h-12 w-12" />}
            title={filter === 'all' ? 'No orders yet' : `No ${filter} orders`}
            description={
              filter === 'bought'
                ? 'Energy you purchase will appear here'
                : filter === 'sold'
                  ? 'Orders for your listings will appear here'
                  : 'Your energy transactions will appear here'
            }
          />
        ) : (
          <div className="flex flex-col gap-3">
            {filteredOrders.map((order) => {
              const SourceIcon = sourceIcons[order.sourceType] || Package;
              const isBought = order.type === 'bought';
              const fee = Math.round(order.totalPrice * 0.025 * 100) / 100;

              return (
                <Card key={order.id}>
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-[10px] flex items-center justify-center ${isBought
                        ? 'bg-[var(--color-primary-light)]'
                        : 'bg-[var(--color-success-light)]'
                        }`}>
                        <SourceIcon className={`h-5 w-5 ${isBought
                          ? 'text-[var(--color-primary)]'
                          : 'text-[var(--color-success)]'
                          }`} />
                      </div>
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-medium text-[var(--color-text)]">
                            {order.sourceType} Energy
                          </p>
                          <Badge
                            variant={isBought ? 'primary' : 'success'}
                            size="sm"
                          >
                            {isBought ? (
                              <span className="flex items-center gap-0.5">
                                <ArrowDownLeft className="w-2.5 h-2.5" />
                                Bought
                              </span>
                            ) : (
                              <span className="flex items-center gap-0.5">
                                <ArrowUpRight className="w-2.5 h-2.5" />
                                Sold
                              </span>
                            )}
                          </Badge>
                          {(order.isBulkOrder || order.isPartOfBulkPurchase) && (
                            <Badge variant="default" size="sm">
                              <span className="flex items-center gap-0.5">
                                <Package className="w-2.5 h-2.5" />
                                Bulk
                              </span>
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-[var(--color-text-muted)]">
                          {isBought ? `from ${order.providerName}` : 'Your listing'}
                        </p>
                      </div>
                    </div>
                    <Badge variant={getStatusBadgeVariant(order.status)}>
                      {order.status}
                    </Badge>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-sm mb-3">
                    <div>
                      <p className="text-xs text-[var(--color-text-muted)]">Quantity</p>
                      <p className="font-medium text-[var(--color-text)]">
                        {order.quantity} kWh
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-[var(--color-text-muted)]">
                        {order.isBulkOrder ? 'Avg. Rate' : 'Rate'}
                      </p>
                      <p className="font-medium text-[var(--color-text)]">
                        {formatCurrency(order.pricePerKwh)}/kWh
                      </p>
                    </div>
                  </div>

                  {/* Bulk Order Details */}
                  {order.isBulkOrder && order.providers && order.providers.length > 0 && (
                    <div className="mb-3 p-2 bg-[var(--color-surface)] rounded-lg">
                      <div className="flex items-center gap-2 mb-2">
                        <Package className="w-4 h-4 text-[var(--color-primary)]" />
                        <p className="text-xs font-medium text-[var(--color-text)]">
                          {order.totalItemCount} offers from {order.totalProviderCount} seller{order.totalProviderCount !== 1 ? 's' : ''}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {order.providers.slice(0, 5).map((provider) => (
                          <span
                            key={provider.id}
                            className="text-xs px-2 py-0.5 bg-[var(--color-border-subtle)] rounded-full text-[var(--color-text-muted)]"
                          >
                            {provider.name}
                          </span>
                        ))}
                        {order.providers.length > 5 && (
                          <span className="text-xs px-2 py-0.5 bg-[var(--color-border-subtle)] rounded-full text-[var(--color-text-muted)]">
                            +{order.providers.length - 5} more
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Delivery Time */}
                  {order.deliveryTime && (
                    <div className="flex items-center gap-2 mb-3 p-2 bg-[var(--color-surface)] rounded-lg">
                      <Clock className="w-4 h-4 text-[var(--color-text-muted)]" />
                      <div>
                        <p className="text-xs text-[var(--color-text-muted)]">Delivery Time</p>
                        <p className="text-sm font-medium text-[var(--color-text)]">
                          {formatDateTime(order.deliveryTime.start)}
                          {order.deliveryTime.end && ` - ${formatTime(order.deliveryTime.end)}`}
                        </p>
                      </div>
                    </div>
                  )}

                  <div className="pt-3 border-t border-[var(--color-border)]">
                    {isBought ? (
                      // Buyer view
                      order.status === 'CANCELLED' && order.cancellation ? (
                        // Cancelled order - show refund info
                        <>
                          <div className="flex justify-between items-center text-sm mb-1">
                            <span className="text-[var(--color-text-muted)]">Original Amount</span>
                            <span className="text-[var(--color-text)] line-through">
                              {formatCurrency(order.totalPrice + fee)}
                            </span>
                          </div>
                          {typeof order.cancellation.penalty === 'number' && (
                            <div className="flex justify-between items-center text-sm mb-1">
                              <span className="text-[var(--color-text-muted)]">Penalty</span>
                              <span className="text-[var(--color-danger)]">
                                -{formatCurrency(order.cancellation.penalty || 0)}
                              </span>
                            </div>
                          )}
                          <div className="flex justify-between items-center">
                            <span className="text-sm font-medium text-[var(--color-text)]">Refunded</span>
                            <span className="text-base font-semibold text-[var(--color-success)]">
                              +{formatCurrency(order.cancellation.refund || 0)}
                            </span>
                          </div>
                        </>
                      ) : (
                        // Active/Completed order
                        <>
                          <div className="flex justify-between items-center text-sm mb-1">
                            <span className="text-[var(--color-text-muted)]">Energy Cost</span>
                            <span className="text-[var(--color-text)]">
                              {formatCurrency(order.totalPrice)}
                            </span>
                          </div>
                          <div className="flex justify-between items-center text-sm mb-2">
                            <span className="text-[var(--color-text-muted)]">Platform Fee (2.5%)</span>
                            <span className="text-[var(--color-text)]">
                              {formatCurrency(fee)}
                            </span>
                          </div>
                          <div className="flex justify-between items-center">
                            <span className="text-sm font-medium text-[var(--color-text)]">Total Paid</span>
                            <span className="text-base font-semibold text-[var(--color-danger)]">
                              -{formatCurrency(order.totalPrice + fee)}
                            </span>
                          </div>
                        </>
                      )
                    ) : (
                      // Seller view
                      order.status === 'CANCELLED' && order.cancellation ? (
                        // Cancelled - show compensation (buyer cancel) or penalty (seller cancel)
                        (order.cancellation.cancelledBy?.startsWith('SELLER:') ? (
                          <div className="flex justify-between items-center">
                            <span className="text-sm font-medium text-[var(--color-text)]">Penalty (5%)</span>
                            <span className="text-base font-semibold text-[var(--color-danger)]">
                              -{formatCurrency(order.cancellation.penalty || 0)}
                            </span>
                          </div>
                        ) : (
                          <div className="flex justify-between items-center">
                            <span className="text-sm font-medium text-[var(--color-text)]">Compensation (5%)</span>
                            <span className="text-base font-semibold text-[var(--color-success)]">
                              +{formatCurrency(order.cancellation.compensation || 0)}
                            </span>
                          </div>
                        ))
                      ) : order.paymentStatus === 'RELEASED' ? (
                        // Payment released after delivery
                        <div className="flex justify-between items-center">
                          <span className="text-sm font-medium text-[var(--color-text)]">Received</span>
                          <span className="text-base font-semibold text-[var(--color-success)]">
                            +{formatCurrency(order.totalPrice)}
                          </span>
                        </div>
                      ) : (
                        // Payment in escrow
                        <div className="flex justify-between items-center">
                          <span className="text-sm font-medium text-[var(--color-text)]">In Escrow</span>
                          <span className="text-base font-semibold text-[var(--color-warning)]">
                            {formatCurrency(order.totalPrice)}
                          </span>
                        </div>
                      )
                    )}
                  </div>

                  {/* Delivery Status for completed orders */}
                  {order.fulfillment && (
                    <div className={`mt-2 p-3 rounded-lg ${order.fulfillment.status === 'FULL'
                        ? 'bg-[var(--color-success-light)]'
                        : order.fulfillment.status === 'PARTIAL'
                          ? 'bg-[var(--color-warning-light)]'
                          : 'bg-[var(--color-danger-light)]'
                      }`}>
                      <div className="flex items-center gap-2 mb-2">
                        {order.fulfillment.status === 'FULL' ? (
                          <Zap className="w-4 h-4 text-[var(--color-success)]" />
                        ) : (
                          <AlertTriangle className="w-4 h-4 text-[var(--color-warning)]" />
                        )}
                        <span className={`text-sm font-medium ${order.fulfillment.status === 'FULL'
                            ? 'text-[var(--color-success)]'
                            : order.fulfillment.status === 'PARTIAL'
                              ? 'text-[var(--color-warning)]'
                              : 'text-[var(--color-danger)]'
                          }`}>
                          {order.fulfillment.status === 'FULL'
                            ? 'Full Delivery'
                            : order.fulfillment.status === 'PARTIAL'
                              ? `Partial Delivery (${Math.round(order.fulfillment.deliveryRatio * 100)}%)`
                              : 'Delivery Failed'}
                        </span>
                      </div>
                      <div className="text-xs space-y-1">
                        <div className="flex justify-between">
                          <span className="text-[var(--color-text-muted)]">Delivered</span>
                          <span className="text-[var(--color-text)]">
                            {order.fulfillment.deliveredQty}/{order.fulfillment.expectedQty} kWh
                          </span>
                        </div>
                        {order.fulfillment.status !== 'FULL' && order.fulfillment.discomPenalty && order.fulfillment.discomPenalty > 0 && (
                          <div className="flex justify-between">
                            <span className="text-[var(--color-text-muted)]">DISCOM covered shortfall</span>
                            <span className="text-[var(--color-danger)]">
                              {formatCurrency(order.fulfillment.discomPenalty)}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Trust Impact */}
                  {order.trustImpact && order.trustImpact.change !== 0 && (
                    <div className={`mt-2 p-2 rounded-lg ${order.trustImpact.change > 0
                      ? 'bg-[var(--color-success-light)]'
                      : 'bg-[var(--color-danger-light)]'
                      }`}>
                      <div className="flex justify-between items-center text-xs">
                        <span className={order.trustImpact.change > 0
                          ? 'text-[var(--color-success)]'
                          : 'text-[var(--color-danger)]'
                        }>
                          Trust Score Impact
                        </span>
                        <span className={`font-semibold ${order.trustImpact.change > 0
                          ? 'text-[var(--color-success)]'
                          : 'text-[var(--color-danger)]'
                          }`}>
                          {order.trustImpact.change > 0 ? '+' : ''}{(order.trustImpact.change * 100).toFixed(1)}%
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Cancel Button for active bought orders - hide if within 30 min of delivery */}
                  {(() => {
                    const isCancelableStatus = order.status === 'ACTIVE' || order.status === 'PENDING';
                    if (!isCancelableStatus) return null;

                    // Check if we're at least 30 min before delivery start
                    const deliveryStart = order.deliveryTime?.start ? new Date(order.deliveryTime.start) : null;
                    const now = new Date();
                    const minCancelBuffer = 30 * 60 * 1000; // 30 minutes
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
                          onClick={() => isBought ? handleCancelOrder(order) : handleSellerCancelOrder(order)}
                          loading={cancellingOrderId === order.id}
                          disabled={!!cancellingOrderId}
                        >
                          <X className="w-4 h-4" />
                          Cancel Order
                        </Button>
                      </div>
                    );
                  })()}

                  <div className="flex justify-between items-center mt-2 text-xs text-[var(--color-text-muted)]">
                    <span>{formatDateTime(order.createdAt)}</span>
                    <span>ID: {truncateId(order.id)}</span>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </AppShell>
  );
}
