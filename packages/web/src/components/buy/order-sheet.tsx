'use client';

import { useState, useEffect } from 'react';
import { Check, Loader2, AlertCircle, CreditCard } from 'lucide-react';
import { BottomSheet, Button, Input, Badge } from '@/components/ui';
import { formatCurrency, formatTime } from '@/lib/utils';
import { useBalance } from '@/contexts/balance-context';
import type { Offer, Order } from '@/lib/api';

type OrderStep = 'quantity' | 'payment' | 'processing' | 'success' | 'error';

interface OrderSheetProps {
  open: boolean;
  onClose: () => void;
  offer: Offer | null;
  providerName: string;
  providerId?: string;
  initialQuantity?: number;
  availableQuantity?: number; // Actual available quantity (from blockStats)
  onConfirm: (quantity: number) => Promise<Order | null>;
  trustWarning?: {
    score: number;
    percentage: string;
    message: string;
  };
}

export function OrderSheet({
  open,
  onClose,
  offer,
  providerName,
  providerId,
  initialQuantity,
  availableQuantity,
  onConfirm,
  trustWarning,
}: OrderSheetProps) {
  const { balance, processPayment, refreshBalance } = useBalance();
  const [step, setStep] = useState<OrderStep>('quantity');
  const [quantity, setQuantity] = useState(initialQuantity || 10);
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  // Use available quantity if provided, otherwise fall back to maxQuantity
  const effectiveMaxQuantity = availableQuantity ?? offer?.maxQuantity ?? 100;

  // Reset quantity when offer changes or sheet opens
  useEffect(() => {
    if (open && offer) {
      const maxQty = availableQuantity ?? offer.maxQuantity;
      const qty = initialQuantity || Math.min(10, maxQty);
      setQuantity(Math.min(qty, maxQty));
    }
  }, [open, offer, initialQuantity, availableQuantity]);

  const totalPrice = offer ? offer.price.value * quantity : 0;
  const fee = Math.round(totalPrice * 0.025 * 100) / 100; // 2.5% platform fee
  const totalAmount = totalPrice + fee;
  const hasEnoughBalance = balance >= totalAmount;

  const handleProceedToPayment = () => {
    setStep('payment');
  };

  const handleConfirmPayment = async () => {
    if (!offer || isProcessing) return;
    
    if (!hasEnoughBalance) {
      setError('Insufficient balance. Please add funds in your profile.');
      setStep('error');
      return;
    }

    setIsProcessing(true);
    setStep('processing');
    setError(null);

    try {
      // Create the order first
      const result = await onConfirm(quantity);
      if (!result) {
        throw new Error('Order creation failed');
      }
      
      setOrder(result);

      // Process the payment verification (escrow already done in /confirm)
      await processPayment(result.id, totalPrice, providerId);
      
      // Refresh balance to get latest
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
    // Reset after animation
    setTimeout(() => {
      setStep('quantity');
      setError(null);
      setOrder(null);
      setIsProcessing(false);
    }, 200);
  };

  if (!offer) return null;

  return (
    <BottomSheet open={open} onClose={handleClose} title={step === 'quantity' ? 'Order Summary' : step === 'payment' ? 'Confirm Payment' : undefined}>
      {step === 'quantity' && (
        <div className="flex flex-col gap-4">
          {/* Provider info */}
          <div className="flex items-center justify-between py-3 border-b border-[var(--color-border)]">
            <span className="text-sm text-[var(--color-text-muted)]">Provider</span>
            <span className="text-sm font-medium text-[var(--color-text)]">{providerName}</span>
          </div>

          {/* Time */}
          <div className="flex items-center justify-between py-3 border-b border-[var(--color-border)]">
            <span className="text-sm text-[var(--color-text-muted)]">Delivery Time</span>
            <span className="text-sm font-medium text-[var(--color-text)]">
              {offer.timeWindow 
                ? `${formatTime(offer.timeWindow.startTime)} - ${formatTime(offer.timeWindow.endTime)}`
                : 'Flexible timing'
              }
            </span>
          </div>

          {/* Unit Price */}
          <div className="flex items-center justify-between py-3 border-b border-[var(--color-border)]">
            <span className="text-sm text-[var(--color-text-muted)]">Price per kWh</span>
            <span className="text-sm font-medium text-[var(--color-text)]">
              {formatCurrency(offer.price.value)}
            </span>
          </div>

          {/* Quantity selector */}
          <div className="py-2">
            <label className="text-sm font-medium text-[var(--color-text)] mb-2 block">
              Quantity (kWh)
            </label>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setQuantity(Math.max(1, quantity - 5))}
                className="w-11 h-11 rounded-[12px] border border-[var(--color-border)] flex items-center justify-center text-lg font-medium text-[var(--color-text)] hover:bg-[var(--color-surface)] transition-colors"
              >
                −
              </button>
              <Input
                type="number"
                value={quantity}
                onChange={(e) => setQuantity(Math.min(effectiveMaxQuantity, Math.max(1, parseInt(e.target.value) || 1)))}
                className="text-center font-medium"
                min={1}
                max={effectiveMaxQuantity}
              />
              <button
                type="button"
                onClick={() => setQuantity(Math.min(effectiveMaxQuantity, quantity + 5))}
                className="w-11 h-11 rounded-[12px] border border-[var(--color-border)] flex items-center justify-center text-lg font-medium text-[var(--color-text)] hover:bg-[var(--color-surface)] transition-colors"
              >
                +
              </button>
            </div>
            <p className="text-xs text-[var(--color-text-muted)] mt-1">
              Max available: {effectiveMaxQuantity} kWh
            </p>
          </div>

          {/* Total */}
          <div className="flex items-center justify-between py-4 bg-[var(--color-surface)] rounded-[14px] px-4 -mx-4">
            <span className="text-base font-medium text-[var(--color-text)]">Total</span>
            <span className="text-xl font-semibold text-[var(--color-primary)]">
              {formatCurrency(totalPrice)}
            </span>
          </div>

          {/* Continue to payment */}
          <Button fullWidth size="lg" onClick={handleProceedToPayment}>
            <CreditCard className="w-4 h-4 mr-2" />
            Continue to Payment
          </Button>
        </div>
      )}

      {step === 'payment' && (
        <div className="flex flex-col gap-4">
          {/* Trust Score Warning (if applicable) */}
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

          {/* Payment breakdown */}
          <div className="bg-[var(--color-surface)] rounded-[14px] p-4">
            <p className="text-sm font-medium text-[var(--color-text)] mb-3">Payment Summary</p>

            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-[var(--color-text-muted)]">Energy ({quantity} kWh)</span>
                <span className="text-[var(--color-text)]">{formatCurrency(totalPrice)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-[var(--color-text-muted)]">Platform Fee (2.5%)</span>
                <span className="text-[var(--color-text)]">{formatCurrency(fee)}</span>
              </div>
              <div className="border-t border-[var(--color-border)] pt-2 mt-2">
                <div className="flex justify-between">
                  <span className="text-sm font-medium text-[var(--color-text)]">Total</span>
                  <span className="text-base font-semibold text-[var(--color-primary)]">
                    {formatCurrency(totalAmount)}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Balance check */}
          <div className={`p-3 rounded-[12px] ${hasEnoughBalance ? 'bg-[var(--color-success-light)]' : 'bg-[var(--color-danger-light)]'}`}>
            <div className="flex justify-between items-center">
              <span className={`text-sm ${hasEnoughBalance ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}`}>
                Your Balance
              </span>
              <span className={`text-sm font-semibold ${hasEnoughBalance ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}`}>
                {formatCurrency(balance)}
              </span>
            </div>
            {!hasEnoughBalance && (
              <p className="text-xs text-[var(--color-danger)] mt-1">
                Insufficient balance. Add funds in Profile.
              </p>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex gap-3">
            <Button fullWidth variant="secondary" onClick={() => setStep('quantity')} disabled={isProcessing}>
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
          <p className="text-base font-medium text-[var(--color-text)]">Processing Payment</p>
          <p className="text-sm text-[var(--color-text-muted)]">This may take a moment...</p>
        </div>
      )}

      {step === 'success' && order && (
        <div className="flex flex-col items-center justify-center py-8">
          <div className="w-16 h-16 bg-[var(--color-success-light)] rounded-full flex items-center justify-center mb-4">
            <Check className="h-8 w-8 text-[var(--color-success)]" />
          </div>
          <p className="text-lg font-semibold text-[var(--color-text)] mb-1">Payment Successful!</p>
          <p className="text-sm text-[var(--color-text-muted)] mb-6">
            Your order has been confirmed
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
              <span className="text-sm font-medium text-[var(--color-text)]">{quantity} kWh</span>
            </div>
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
            {error?.toLowerCase().includes('trust score') ? 'Trust Score Too Low' : 'Order Failed'}
          </p>
          <p className="text-sm text-[var(--color-text-muted)] text-center mb-6 max-w-[280px]">
            {error || 'Something went wrong. Please try again.'}
          </p>

          <div className="flex gap-3 w-full">
            <Button fullWidth variant="secondary" onClick={handleClose}>
              Close
            </Button>
            {!error?.toLowerCase().includes('trust score') && (
              <Button fullWidth onClick={() => setStep('quantity')}>
                Try Again
              </Button>
            )}
          </div>
        </div>
      )}
    </BottomSheet>
  );
}
