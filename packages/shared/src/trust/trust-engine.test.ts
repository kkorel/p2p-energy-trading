/**
 * Trust Engine Unit Tests
 * Tests for trust score calculations with proportional penalties
 */

import {
    calculateAllowedLimit,
    calculateDeliveryPenalty,
    updateTrustAfterDiscom,
    updateTrustAfterCancel,
    updateTrustAfterSellerCancel,
    updateTrustAfterMeterAnalysis,
    getTrustTierDescription,
    getNextTierProgress,
    getTrustConfig,
} from './trust-engine';

describe('Trust Engine', () => {
    describe('getTrustConfig', () => {
        it('should return default config values', () => {
            const config = getTrustConfig();
            expect(config.defaultScore).toBe(0.3);
            expect(config.defaultLimit).toBe(10);
            expect(config.successBonus).toBe(0.02);
            expect(config.failurePenalty).toBe(0.10);
            expect(config.sellerCancelPenalty).toBe(0.05);
        });
    });

    describe('calculateAllowedLimit', () => {
        it('should return 10% for new users (trust < 0.3)', () => {
            expect(calculateAllowedLimit(0.0)).toBe(10);
            expect(calculateAllowedLimit(0.1)).toBe(10);
            expect(calculateAllowedLimit(0.29)).toBe(10);
        });

        it('should return 20% for starter tier (trust 0.3-0.49)', () => {
            expect(calculateAllowedLimit(0.3)).toBe(20);
            expect(calculateAllowedLimit(0.4)).toBe(20);
            expect(calculateAllowedLimit(0.49)).toBe(20);
        });

        it('should return 40% for bronze tier (trust 0.5-0.69)', () => {
            expect(calculateAllowedLimit(0.5)).toBe(40);
            expect(calculateAllowedLimit(0.6)).toBe(40);
        });

        it('should return 60% for silver tier (trust 0.7-0.84)', () => {
            expect(calculateAllowedLimit(0.7)).toBe(60);
            expect(calculateAllowedLimit(0.8)).toBe(60);
        });

        it('should return 80% for gold tier (trust 0.85-0.94)', () => {
            expect(calculateAllowedLimit(0.85)).toBe(80);
            expect(calculateAllowedLimit(0.9)).toBe(80);
        });

        it('should return 100% for platinum tier (trust >= 0.95)', () => {
            expect(calculateAllowedLimit(0.95)).toBe(100);
            expect(calculateAllowedLimit(1.0)).toBe(100);
        });
    });

    describe('calculateDeliveryPenalty', () => {
        it('should return 0 penalty for full delivery', () => {
            expect(calculateDeliveryPenalty(5, 5, 0.10)).toBe(0);
            expect(calculateDeliveryPenalty(10, 10, 0.10)).toBe(0);
        });

        it('should return full penalty for no delivery', () => {
            expect(calculateDeliveryPenalty(5, 0, 0.10)).toBe(0.10);
            expect(calculateDeliveryPenalty(10, 0, 0.10)).toBe(0.10);
        });

        it('should return proportional penalty for partial delivery', () => {
            // Sold 5, delivered 4 → 20% shortfall → 0.02 penalty
            expect(calculateDeliveryPenalty(5, 4, 0.10)).toBeCloseTo(0.02, 2);

            // Sold 5, delivered 1 → 80% shortfall → 0.08 penalty
            expect(calculateDeliveryPenalty(5, 1, 0.10)).toBeCloseTo(0.08, 2);

            // Sold 10, delivered 5 → 50% shortfall → 0.05 penalty
            expect(calculateDeliveryPenalty(10, 5, 0.10)).toBeCloseTo(0.05, 2);
        });

        it('should handle edge case of 0 expected quantity', () => {
            expect(calculateDeliveryPenalty(0, 0, 0.10)).toBe(0);
        });

        it('should cap delivery ratio at 1 for over-delivery', () => {
            expect(calculateDeliveryPenalty(5, 10, 0.10)).toBe(0);
        });
    });

    describe('updateTrustAfterDiscom', () => {
        it('should increase trust for full delivery', () => {
            const result = updateTrustAfterDiscom(0.5, 5, 5);
            expect(result.newScore).toBeGreaterThan(0.5);
            expect(result.trustImpact).toBeGreaterThan(0);
        });

        it('should decrease trust proportionally for partial delivery', () => {
            // Delivered 4 of 5 - small penalty
            const result1 = updateTrustAfterDiscom(0.5, 4, 5);
            expect(result1.newScore).toBeLessThan(0.5);
            expect(result1.trustImpact).toBeLessThan(0);

            // Delivered 1 of 5 - larger penalty
            const result2 = updateTrustAfterDiscom(0.5, 1, 5);
            expect(result2.newScore).toBeLessThan(result1.newScore);
            expect(Math.abs(result2.trustImpact)).toBeGreaterThan(Math.abs(result1.trustImpact));
        });

        it('should apply full penalty for no delivery', () => {
            const result = updateTrustAfterDiscom(0.5, 0, 5);
            expect(result.newScore).toBe(0.4); // 0.5 - 0.10
            expect(result.trustImpact).toBe(-0.10);
        });

        it('should clamp trust score to [0, 1]', () => {
            // Should not go below 0
            const resultLow = updateTrustAfterDiscom(0.05, 0, 10);
            expect(resultLow.newScore).toBe(0);

            // Should not exceed 1
            const resultHigh = updateTrustAfterDiscom(0.99, 10, 10);
            expect(resultHigh.newScore).toBeLessThanOrEqual(1);
        });

        it('should update allowed limit based on new score', () => {
            // Start at 0.5 (40% limit), succeed → go above 0.5
            const result = updateTrustAfterDiscom(0.5, 5, 5);
            expect(result.newLimit).toBe(40); // Still in same tier

            // Cross tier boundary
            const result2 = updateTrustAfterDiscom(0.69, 5, 5);
            expect(result2.newLimit).toBe(60); // Moved to silver
        });
    });

    describe('updateTrustAfterCancel', () => {
        it('should penalize buyer for cancellation within window', () => {
            const result = updateTrustAfterCancel(0.5, 5, 5, true);
            expect(result.newScore).toBeLessThan(0.5);
            expect(result.trustImpact).toBeLessThan(0);
        });

        it('should not penalize for cancellation outside window', () => {
            const result = updateTrustAfterCancel(0.5, 5, 5, false);
            expect(result.newScore).toBe(0.5);
            expect(result.trustImpact).toBe(0);
        });

        it('should apply proportional penalty based on cancelled quantity', () => {
            // Cancel 5 of 10 units
            const result = updateTrustAfterCancel(0.5, 5, 10, true);
            const expectedPenalty = 0.03 * (5 / 10); // Half quantity = half penalty
            expect(result.trustImpact).toBeCloseTo(-expectedPenalty, 3);
        });
    });

    describe('updateTrustAfterSellerCancel', () => {
        it('should penalize seller more strictly than buyer', () => {
            const sellerResult = updateTrustAfterSellerCancel(0.5, 5, 5, true);
            const buyerResult = updateTrustAfterCancel(0.5, 5, 5, true);
            expect(sellerResult.trustImpact).toBeLessThan(buyerResult.trustImpact);
        });

        it('should apply proportional penalty based on cancelled quantity', () => {
            const result = updateTrustAfterSellerCancel(0.6, 2, 10, true);
            const expectedPenalty = 0.05 * (2 / 10); // Default seller penalty
            expect(result.trustImpact).toBeCloseTo(-expectedPenalty, 3);
        });

        it('should not penalize seller outside cancellation window', () => {
            const result = updateTrustAfterSellerCancel(0.6, 5, 5, false);
            expect(result.newScore).toBe(0.6);
            expect(result.trustImpact).toBe(0);
        });
    });

    describe('updateTrustAfterMeterAnalysis', () => {
        it('should give full bonus for HIGH quality analysis', () => {
            const result = updateTrustAfterMeterAnalysis(0.3, 'HIGH');
            expect(result.newScore).toBe(0.5); // 0.3 + 0.2
            expect(result.trustImpact).toBe(0.2);
        });

        it('should give partial bonus for MEDIUM quality', () => {
            const result = updateTrustAfterMeterAnalysis(0.3, 'MEDIUM');
            expect(result.trustImpact).toBeCloseTo(0.12, 2); // 0.2 * 0.6
        });

        it('should give minimal bonus for LOW quality', () => {
            const result = updateTrustAfterMeterAnalysis(0.3, 'LOW');
            expect(result.trustImpact).toBeCloseTo(0.06, 2); // 0.2 * 0.3
        });
    });

    describe('getTrustTierDescription', () => {
        it('should return correct tier descriptions', () => {
            expect(getTrustTierDescription(0.1)).toBe('New (10% Trading)');
            expect(getTrustTierDescription(0.3)).toBe('Starter (20% Trading)');
            expect(getTrustTierDescription(0.5)).toBe('Bronze (40% Trading)');
            expect(getTrustTierDescription(0.7)).toBe('Silver (60% Trading)');
            expect(getTrustTierDescription(0.85)).toBe('Gold (80% Trading)');
            expect(getTrustTierDescription(0.95)).toBe('Platinum (Full Trading)');
        });
    });

    describe('getNextTierProgress', () => {
        it('should show progress to next tier', () => {
            const result = getNextTierProgress(0.4);
            expect(result.currentTier).toBe('Starter');
            expect(result.nextTier).toBe('Bronze');
            expect(result.progress).toBeGreaterThan(0);
            expect(result.scoreNeeded).toBeCloseTo(0.1, 2);
        });

        it('should show 100% progress for platinum tier', () => {
            const result = getNextTierProgress(0.98);
            expect(result.currentTier).toBe('Platinum');
            expect(result.nextTier).toBeNull();
            expect(result.progress).toBe(100);
        });
    });
});
