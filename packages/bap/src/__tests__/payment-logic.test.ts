/**
 * Unit tests for payment and cancellation logic
 */

describe('Payment Logic', () => {
  // Configuration
  const DISCOM_RATE = 10; // ₹10/kWh

  /**
   * Calculate seller payment based on delivery
   * Formula: sellerPayment = (delivered × sellerRate) - (discomRate - sellerRate) × undelivered
   */
  function calculateSellerPayment(
    expectedQty: number,
    deliveredQty: number,
    sellerRate: number,
    discomRate: number = DISCOM_RATE
  ): { sellerPayment: number; discomPenalty: number; toDiscom: number } {
    const undeliveredQty = expectedQty - deliveredQty;
    
    if (deliveredQty >= expectedQty) {
      // Full delivery
      return {
        sellerPayment: expectedQty * sellerRate,
        discomPenalty: 0,
        toDiscom: 0,
      };
    }
    
    // Partial/Failed delivery
    const paymentForDelivered = deliveredQty * sellerRate;
    const discomPenalty = Math.max(0, (discomRate - sellerRate) * undeliveredQty);
    const sellerPayment = Math.max(0, paymentForDelivered - discomPenalty);
    const toDiscom = discomPenalty + (undeliveredQty * sellerRate);
    
    return { sellerPayment, discomPenalty, toDiscom };
  }

  describe('Full Delivery', () => {
    it('should pay seller 100% when fully delivered', () => {
      // Seller rate: ₹7/kWh, Expected: 5 kWh, Delivered: 5 kWh
      const result = calculateSellerPayment(5, 5, 7);
      
      expect(result.sellerPayment).toBe(35); // 5 × ₹7 = ₹35
      expect(result.discomPenalty).toBe(0);
      expect(result.toDiscom).toBe(0);
    });

    it('should handle higher seller rate than DISCOM', () => {
      // Seller rate: ₹12/kWh (higher than DISCOM ₹10), Expected: 10 kWh
      const result = calculateSellerPayment(10, 10, 12);
      
      expect(result.sellerPayment).toBe(120); // 10 × ₹12 = ₹120
      expect(result.discomPenalty).toBe(0);
      expect(result.toDiscom).toBe(0);
    });
  });

  describe('Partial Delivery', () => {
    it('should apply DISCOM differential penalty (user example)', () => {
      // User's example:
      // DISCOM rate: ₹10/kWh
      // Seller rate: ₹7/kWh
      // Committed: 5 kWh, Delivered: 3 kWh, Undelivered: 2 kWh
      // Expected: 21 - (10 - 7) × 2 = 21 - 6 = ₹15
      
      const result = calculateSellerPayment(5, 3, 7, 10);
      
      expect(result.sellerPayment).toBe(15); // ₹21 - ₹6 = ₹15
      expect(result.discomPenalty).toBe(6);  // (10-7) × 2 = ₹6
      expect(result.toDiscom).toBe(20);      // ₹6 penalty + (2 × ₹7) buyer's payment
    });

    it('should handle 50% delivery', () => {
      // Seller rate: ₹8/kWh, Expected: 10 kWh, Delivered: 5 kWh
      // Payment for delivered: 5 × ₹8 = ₹40
      // DISCOM penalty: (10-8) × 5 = ₹10
      // Seller gets: ₹40 - ₹10 = ₹30
      
      const result = calculateSellerPayment(10, 5, 8, 10);
      
      expect(result.sellerPayment).toBe(30);
      expect(result.discomPenalty).toBe(10);
      expect(result.toDiscom).toBe(50); // ₹10 + (5 × ₹8)
    });

    it('should handle seller rate equal to DISCOM rate (no penalty)', () => {
      // Seller rate: ₹10/kWh (same as DISCOM), Expected: 10 kWh, Delivered: 6 kWh
      // No differential penalty since rates are equal
      
      const result = calculateSellerPayment(10, 6, 10, 10);
      
      expect(result.sellerPayment).toBe(60); // 6 × ₹10
      expect(result.discomPenalty).toBe(0);  // (10-10) × 4 = 0
      expect(result.toDiscom).toBe(40);      // Just buyer's payment for undelivered
    });

    it('should handle seller rate higher than DISCOM (no penalty, capped at 0)', () => {
      // Seller rate: ₹12/kWh (higher than DISCOM ₹10)
      // DISCOM differential is negative, but penalty should be 0 (not negative)
      
      const result = calculateSellerPayment(10, 6, 12, 10);
      
      // Payment for delivered: 6 × ₹12 = ₹72
      // DISCOM penalty: max(0, (10-12) × 4) = max(0, -8) = 0
      expect(result.sellerPayment).toBe(72);
      expect(result.discomPenalty).toBe(0);
    });
  });

  describe('Failed Delivery (0%)', () => {
    it('should apply full DISCOM penalty when nothing delivered', () => {
      // Seller rate: ₹7/kWh, Expected: 5 kWh, Delivered: 0 kWh
      // Payment for delivered: 0 × ₹7 = ₹0
      // DISCOM penalty: (10-7) × 5 = ₹15
      // Seller gets: max(0, ₹0 - ₹15) = ₹0
      
      const result = calculateSellerPayment(5, 0, 7, 10);
      
      expect(result.sellerPayment).toBe(0);
      expect(result.discomPenalty).toBe(15);
      expect(result.toDiscom).toBe(50); // ₹15 + (5 × ₹7) = full order value
    });

    it('should handle large order with zero delivery', () => {
      // Seller rate: ₹6/kWh, Expected: 100 kWh, Delivered: 0 kWh
      
      const result = calculateSellerPayment(100, 0, 6, 10);
      
      expect(result.sellerPayment).toBe(0);
      expect(result.discomPenalty).toBe(400); // (10-6) × 100
      expect(result.toDiscom).toBe(1000);     // ₹400 + (100 × ₹6) = full order
    });
  });

  describe('Edge Cases', () => {
    it('should handle zero quantity order', () => {
      const result = calculateSellerPayment(0, 0, 7, 10);
      
      expect(result.sellerPayment).toBe(0);
      expect(result.discomPenalty).toBe(0);
      expect(result.toDiscom).toBe(0);
    });

    it('should handle over-delivery (capped at expected)', () => {
      // Delivered more than expected - should only pay for expected
      const result = calculateSellerPayment(5, 7, 7, 10);
      
      expect(result.sellerPayment).toBe(35); // Pay for expected 5, not 7
      expect(result.discomPenalty).toBe(0);
    });

    it('should handle very small quantities (fractional kWh)', () => {
      const result = calculateSellerPayment(0.5, 0.3, 7, 10);
      
      // Payment for delivered: 0.3 × ₹7 = ₹2.1
      // DISCOM penalty: (10-7) × 0.2 = ₹0.6
      // Seller gets: ₹2.1 - ₹0.6 = ₹1.5
      expect(result.sellerPayment).toBeCloseTo(1.5, 2);
      expect(result.discomPenalty).toBeCloseTo(0.6, 2);
    });
  });
});

describe('Cancellation Rules', () => {
  /**
   * Check if order can be cancelled
   * Must be at least 30 minutes before delivery start time
   */
  function canCancelOrder(deliveryStartTime: Date, currentTime: Date): {
    canCancel: boolean;
    minutesRemaining: number;
    error?: string;
  } {
    const minCancelBufferMs = 30 * 60 * 1000; // 30 minutes
    const timeUntilDelivery = deliveryStartTime.getTime() - currentTime.getTime();
    const minutesRemaining = Math.floor(timeUntilDelivery / 60000);

    if (timeUntilDelivery < 0) {
      return {
        canCancel: false,
        minutesRemaining: 0,
        error: 'Delivery has already started or completed',
      };
    }

    if (timeUntilDelivery < minCancelBufferMs) {
      return {
        canCancel: false,
        minutesRemaining,
        error: `Cancellation not allowed within 30 minutes of delivery start. Only ${minutesRemaining} minutes remaining.`,
      };
    }

    return { canCancel: true, minutesRemaining };
  }

  describe('Time-based Cancellation', () => {
    it('should allow cancellation 1 hour before delivery', () => {
      const deliveryStart = new Date('2026-01-23T14:00:00Z');
      const currentTime = new Date('2026-01-23T13:00:00Z'); // 1 hour before
      
      const result = canCancelOrder(deliveryStart, currentTime);
      
      expect(result.canCancel).toBe(true);
      expect(result.minutesRemaining).toBe(60);
    });

    it('should allow cancellation exactly 30 minutes before delivery', () => {
      const deliveryStart = new Date('2026-01-23T14:00:00Z');
      const currentTime = new Date('2026-01-23T13:30:00Z'); // Exactly 30 min before
      
      const result = canCancelOrder(deliveryStart, currentTime);
      
      expect(result.canCancel).toBe(true);
      expect(result.minutesRemaining).toBe(30);
    });

    it('should NOT allow cancellation 29 minutes before delivery', () => {
      const deliveryStart = new Date('2026-01-23T14:00:00Z');
      const currentTime = new Date('2026-01-23T13:31:00Z'); // 29 min before
      
      const result = canCancelOrder(deliveryStart, currentTime);
      
      expect(result.canCancel).toBe(false);
      expect(result.minutesRemaining).toBe(29);
      expect(result.error).toContain('30 minutes');
    });

    it('should NOT allow cancellation 5 minutes before delivery', () => {
      const deliveryStart = new Date('2026-01-23T14:00:00Z');
      const currentTime = new Date('2026-01-23T13:55:00Z'); // 5 min before
      
      const result = canCancelOrder(deliveryStart, currentTime);
      
      expect(result.canCancel).toBe(false);
      expect(result.minutesRemaining).toBe(5);
    });

    it('should NOT allow cancellation after delivery has started', () => {
      const deliveryStart = new Date('2026-01-23T14:00:00Z');
      const currentTime = new Date('2026-01-23T14:30:00Z'); // 30 min after start
      
      const result = canCancelOrder(deliveryStart, currentTime);
      
      expect(result.canCancel).toBe(false);
      expect(result.error).toContain('already started');
    });
  });

  describe('Cancellation Penalty', () => {
    /**
     * Calculate cancellation penalty
     * 10% total: 5% to seller, 5% to platform
     */
    function calculateCancellationPenalty(orderTotal: number): {
      buyerRefund: number;
      sellerCompensation: number;
      platformFee: number;
      totalPenalty: number;
    } {
      const penaltyRate = 0.10;
      const sellerShare = 0.05;
      const platformShare = 0.05;
      
      const totalPenalty = orderTotal * penaltyRate;
      const sellerCompensation = orderTotal * sellerShare;
      const platformFee = orderTotal * platformShare;
      const buyerRefund = orderTotal - totalPenalty;
      
      return { buyerRefund, sellerCompensation, platformFee, totalPenalty };
    }

    it('should calculate 10% penalty correctly', () => {
      const result = calculateCancellationPenalty(1000);
      
      expect(result.totalPenalty).toBe(100);    // 10% of ₹1000
      expect(result.sellerCompensation).toBe(50); // 5% to seller
      expect(result.platformFee).toBe(50);       // 5% to platform
      expect(result.buyerRefund).toBe(900);      // 90% back to buyer
    });

    it('should handle small order amounts', () => {
      const result = calculateCancellationPenalty(50);
      
      expect(result.totalPenalty).toBe(5);
      expect(result.sellerCompensation).toBe(2.5);
      expect(result.platformFee).toBe(2.5);
      expect(result.buyerRefund).toBe(45);
    });

    it('should handle large order amounts', () => {
      const result = calculateCancellationPenalty(10000);
      
      expect(result.totalPenalty).toBe(1000);
      expect(result.sellerCompensation).toBe(500);
      expect(result.platformFee).toBe(500);
      expect(result.buyerRefund).toBe(9000);
    });
  });

  describe('Seller Cancellation Penalty', () => {
    /**
     * Seller cancellation rules:
     * - Buyer refunded 100% (order total + platform fee)
     * - Seller pays 5% penalty to platform
     */
    function calculateSellerCancellation(
      orderTotal: number,
      platformFeeRate: number = 0.025,
      sellerPenaltyRate: number = 0.05
    ): { buyerRefund: number; sellerPenalty: number; platformFee: number } {
      const platformFee = orderTotal * platformFeeRate;
      const buyerRefund = orderTotal + platformFee;
      const sellerPenalty = orderTotal * sellerPenaltyRate;

      return { buyerRefund, sellerPenalty, platformFee };
    }

    it('should refund buyer fully including platform fee', () => {
      const result = calculateSellerCancellation(1000);
      expect(result.buyerRefund).toBe(1025);
      expect(result.platformFee).toBe(25);
    });

    it('should charge seller a 5% penalty', () => {
      const result = calculateSellerCancellation(1000);
      expect(result.sellerPenalty).toBe(50);
    });
  });
});
