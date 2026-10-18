'use client';

import { useState } from 'react';
import { Check, Loader2, AlertCircle, CreditCard, AlertTriangle, Zap, Users } from 'lucide-react';
import { BottomSheet, Button, Badge } from '@/components/ui';
import { formatCurrency, formatTime } from '@/lib/utils';
import { useBalance } from '@/contexts/balance-context';
import type { SmartBuyResponse, Order } from '@/lib/api';

type OrderStep = 'preview' | 'payment' | 'processing' | 'success' | 'error';

interface SmartOrderSheetProps {
  open: boolean;
  onClose: () => void;
  selection: SmartBuyResponse | null;
  onConfirm: () => Promise<Order | null>;
  trustWarning?: {
    score: number;
    percentage: string;
    message: string;
  };
}

export function SmartOrderSheet({
  open,
  onClose,
  selection,
  onConfirm,
  trustWarning,
}: SmartOrderSheetProps) {
  const { balance, processPayment, refreshBalance } = useBalance();
  const [step, setStep] = useState<OrderStep>('preview');
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  if (!selection) return null;

  const { selectedOffers, summary, selectionType } = selection;
  const isSingleOffer = selectionType === 'single';
  const singleOffer = isSingleOffer ? selectedOffers[0] : null;

  const totalPrice = summary.totalPrice;
  const fee = Math.round(totalPrice * 0.025 * 100) / 100; // 2.5% platform fee
  const totalAmount = totalPrice + fee;
  const hasEnoughBalance = balance >= totalAmount;

  const handleProceedToPayment = () => {
    setStep('payment');
  };

  const handleConfirmPayment = async () => {
    if (isProcessing) return;

    if (!hasEnoughBalance) {
      setError('Insufficient balance. Please add funds in your profile.');
      setStep('error');
      return;
    }

    setIsProcessing(true);
    setStep('processing');
    setError(null);

    try {
      const result = await onConfirm();
      if (!result) {
        throw new Error('Order creation failed');
      }

      setOrder(result);
      await processPayment(result.id, totalPrice);
      await refreshBalance();
      setStep('success');
    } catch (err: any) {
      setError(err.message || 'Something went wrong');
      setStep('error');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleClose = () => {
    onClose();
    setTimeout(() => {
      setStep('preview');
      setError(null);
      setOrder(null);
      setIsProcessing(false);
    }, 200);
  };

  return (
    <BottomSheet
      open={open}
      onClose={handleClose}
      title={
        step === 'preview'
          ? 'Order Preview'
          : step === 'payment'
          ? 'Confirm Payment'
          : undefined
      }
    >
      {step === 'preview' && (
        <div className="flex flex-col gap-4">
          {/* Partial fulfillment warning */}
          {!summary.fullyFulfilled && (
            <div className="p-3 rounded-[12px] bg-[var(--color-warning-light)] border border-[var(--color-warning)]">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-[var(--color-warning)] mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-[var(--color-warning)] mb-1">
                    Partial Fulfillment
                  </p>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    Only {summary.totalQuantity} kWh available (requested: {summary.totalQuantity + summary.shortfall} kWh).
                    Short by {summary.shortfall} kWh.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Summary stats */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-[var(--color-surface)] rounded-[12px] p-3 text-center">
              <p className="text-2xl font-semibold text-[var(--color-primary)]">
                {summary.totalQuantity}
              </p>
              <p className="text-xs text-[var(--color-text-muted)]">kWh Total</p>
            </div>
            <div className="bg-[var(--color-surface)] rounded-[12px] p-3 text-center">
              <div className="flex items-center justify-center gap-1.5">
                {isSingleOffer ? (
                  <Zap className="w-5 h-5 text-[var(--color-primary)]" />
                ) : (
                  <Users className="w-5 h-5 text-[var(--color-text)]" />
                )}
                <p className="text-2xl font-semibold text-[var(--color-text)]">
                  {summary.offersUsed}
                </p>
              </div>
              <p className="text-xs text-[var(--color-text-muted)]">
                {isSingleOffer ? 'Seller' : 'Sellers'}
              </p>
            </div>
          </div>

          {/* Single offer display */}
          {isSingleOffer && singleOffer && (
            <div className="bg-[var(--color-surface)] rounded-[14px] p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-sm font-medium text-[var(--color-text)]">
                    {singleOffer.provider_name}
                  </p>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    Best match for your order
                  </p>
                </div>
                <Badge variant="success">Best Deal</Badge>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <p className="text-xs text-[var(--color-text-muted)]">Rate</p>
                  <p className="font-medium text-[var(--color-text)]">
                    {formatCurrency(singleOffer.unit_price)}/kWh
                  </p>
                </div>
                {singleOffer.timeWindow && (
                  <div>
                    <p className="text-xs text-[var(--color-text-muted)]">Delivery</p>
                    <p className="font-medium text-[var(--color-text)]">
                      {formatTime(singleOffer.timeWindow.startTime)}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Multiple offers list */}
          {!isSingleOffer && (
            <div>
              <p className="text-sm font-medium text-[var(--color-text)] mb-2">
                Selected Sellers ({selectedOffers.length})
              </p>
              <div className="max-h-[200px] overflow-y-auto space-y-2">
                {selectedOffers.map((item) => (
                  <div
                    key={item.offer_id}
                    className="flex items-center justify-between p-3 bg-[var(--color-surface)] rounded-[12px]"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[var(--color-text)] truncate">
                        {item.provider_name}
                      </p>
                      <p className="text-xs text-[var(--color-text-muted)]">
                        {item.quantity} kWh × {formatCurrency(item.unit_price)}
                      </p>
                    </div>
                    <div className="text-right ml-3">
                      <p className="text-sm font-semibold text-[var(--color-primary)]">
                        {formatCurrency(item.subtotal)}
                      </p>
                      {item.timeWindow && (
                        <p className="text-xs text-[var(--color-text-muted)]">
                          {formatTime(item.timeWindow.startTime)}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Price summary */}
          <div className="flex items-center justify-between py-3 border-t border-[var(--color-border)]">
            <div>
              <p className="text-sm text-[var(--color-text-muted)]">
                {isSingleOffer ? 'Price' : 'Average Price'}
              </p>
              <p className="text-xs text-[var(--color-text-muted)]">
                {formatCurrency(isSingleOffer ? singleOffer!.unit_price : (summary.averagePrice ?? 0))}/kWh
              </p>
            </div>
            <div className="text-right">
              <p className="text-sm text-[var(--color-text-muted)]">Total</p>
              <p className="text-xl font-semibold text-[var(--color-primary)]">
                {formatCurrency(summary.totalPrice)}
              </p>
            </div>
          </div>

          <Button fullWidth size="lg" onClick={handleProceedToPayment}>
            <CreditCard className="w-4 h-4 mr-2" />
            Continue to Payment
          </Button>
        </div>
      )}

      {step === 'payment' && (
        <div className="flex flex-col gap-4">
          {trustWarning && (
            <div className="p-3 rounded-[12px] bg-[var(--color-warning-light)] border border-[var(--color-warning)]">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-[var(--color-warning)] mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-[var(--color-warning)] mb-1">
                    Advisory: Low Trust Score
                  </p>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    {trustWarning.message}
                  </p>
                </div>
              </div>
            </div>
          )}

          <div className="bg-[var(--color-surface)] rounded-[14px] p-4">
            <p className="text-sm font-medium text-[var(--color-text)] mb-3">
              Payment Summary
            </p>

            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-[var(--color-text-muted)]">
                  Energy ({summary.totalQuantity} kWh{!isSingleOffer ? ` from ${summary.offersUsed} sellers` : ''})
                </span>
                <span className="text-[var(--color-text)]">
                  {formatCurrency(totalPrice)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-[var(--color-text-muted)]">
                  Platform Fee (2.5%)
                </span>
                <span className="text-[var(--color-text)]">{formatCurrency(fee)}</span>
              </div>
              <div className="border-t border-[var(--color-border)] pt-2 mt-2">
                <div className="flex justify-between">
                  <span className="text-sm font-medium text-[var(--color-text)]">
                    Total
                  </span>
                  <span className="text-base font-semibold text-[var(--color-primary)]">
                    {formatCurrency(totalAmount)}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div
            className={`p-3 rounded-[12px] ${
              hasEnoughBalance
                ? 'bg-[var(--color-success-light)]'
                : 'bg-[var(--color-danger-light)]'
            }`}
          >
            <div className="flex justify-between items-center">
              <span
                className={`text-sm ${
                  hasEnoughBalance
                    ? 'text-[var(--color-success)]'
                    : 'text-[var(--color-danger)]'
                }`}
              >
                Your Balance
              </span>
              <span
                className={`text-sm font-semibold ${
                  hasEnoughBalance
                    ? 'text-[var(--color-success)]'
                    : 'text-[var(--color-danger)]'
                }`}
              >
                {formatCurrency(balance)}
              </span>
            </div>
            {!hasEnoughBalance && (
              <p className="text-xs text-[var(--color-danger)] mt-1">
                Insufficient balance. Add funds in Profile.
              </p>
            )}
          </div>

          <div className="flex gap-3">
            <Button
              fullWidth
              variant="secondary"
              onClick={() => setStep('preview')}
              disabled={isProcessing}
            >
              Back
            </Button>
            <Button
              fullWidth
              size="lg"
              onClick={handleConfirmPayment}
              disabled={!hasEnoughBalance || isProcessing}
              loading={isProcessing}
            >
              Confirm & Pay
            </Button>
          </div>
        </div>
      )}

      {step === 'processing' && (
        <div className="flex flex-col items-center justify-center py-12">
          <Loader2 className="h-12 w-12 text-[var(--color-primary)] animate-spin mb-4" />
          <p className="text-base font-medium text-[var(--color-text)]">
            Processing Order
          </p>
          <p className="text-sm text-[var(--color-text-muted)]">
            {isSingleOffer ? 'Reserving energy...' : `Reserving ${summary.offersUsed} offers...`}
          </p>
        </div>
      )}

      {step === 'success' && order && (
        <div className="flex flex-col items-center justify-center py-8">
          <div className="w-16 h-16 bg-[var(--color-success-light)] rounded-full flex items-center justify-center mb-4">
            <Check className="h-8 w-8 text-[var(--color-success)]" />
          </div>
          <p className="text-lg font-semibold text-[var(--color-text)] mb-1">
            Order Successful!
          </p>
          <p className="text-sm text-[var(--color-text-muted)] mb-6">
            {isSingleOffer ? 'Your energy is reserved' : `${summary.offersUsed} offers confirmed`}
          </p>

          <div className="w-full bg-[var(--color-surface)] rounded-[14px] p-4 mb-6">
            <div className="flex justify-between mb-2">
              <span className="text-sm text-[var(--color-text-muted)]">Order ID</span>
              <span className="text-sm font-mono text-[var(--color-text)]">
                {order.id.slice(0, 8)}...
              </span>
            </div>
            <div className="flex justify-between mb-2">
              <span className="text-sm text-[var(--color-text-muted)]">Quantity</span>
              <span className="text-sm font-medium text-[var(--color-text)]">
                {summary.totalQuantity} kWh
              </span>
            </div>
            {!isSingleOffer && (
              <div className="flex justify-between mb-2">
                <span className="text-sm text-[var(--color-text-muted)]">Sellers</span>
                <span className="text-sm font-medium text-[var(--color-text)]">
                  {summary.offersUsed}
                </span>
              </div>
            )}
            <div className="flex justify-between mb-2">
              <span className="text-sm text-[var(--color-text-muted)]">Total Paid</span>
              <span className="text-sm font-semibold text-[var(--color-success)]">
                {formatCurrency(totalAmount)}
              </span>
            </div>
            <div className="flex justify-between pt-2 border-t border-[var(--color-border)]">
              <span className="text-sm text-[var(--color-text-muted)]">Status</span>
              <Badge variant="success">Confirmed</Badge>
            </div>
          </div>

          <Button fullWidth variant="secondary" onClick={handleClose}>
            Done
          </Button>
        </div>
      )}

      {step === 'error' && (
        <div className="flex flex-col items-center justify-center py-8">
          <div className="w-16 h-16 bg-[var(--color-danger-light)] rounded-full flex items-center justify-center mb-4">
            <AlertCircle className="h-8 w-8 text-[var(--color-danger)]" />
          </div>
          <p className="text-lg font-semibold text-[var(--color-text)] mb-1">
            Order Failed
          </p>
          <p className="text-sm text-[var(--color-text-muted)] text-center mb-6 max-w-[280px]">
            {error || 'Something went wrong. Please try again.'}
          </p>

          <div className="flex gap-3 w-full">
            <Button fullWidth variant="secondary" onClick={handleClose}>
              Close
            </Button>
            <Button fullWidth onClick={() => setStep('preview')}>
              Try Again
            </Button>
          </div>
        </div>
      )}
    </BottomSheet>
  );
}
