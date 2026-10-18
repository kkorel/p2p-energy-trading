/**
 * Comprehensive unit tests for the Matching Algorithm
 * Tests price scoring, filter checks, weighted scoring, and sorting
 */

import { matchOffers, calculateUpdatedTrustScore, MatchingCriteria, ScoredOffer } from './matcher';
import { CatalogOffer, Provider } from '../types/catalog';
import { TimeWindow } from '../types/beckn';

// Helper to create test offers
function createTestOffer(overrides: Partial<CatalogOffer> = {}): CatalogOffer {
  return {
    id: `offer-${Date.now()}-${Math.random()}`,
    item_id: 'item-1',
    provider_id: 'provider-1',
    offerAttributes: {
      pricingModel: 'PER_KWH',
      settlementType: 'INSTANT',
    },
    price: { value: 6, currency: 'INR' },
    maxQuantity: 100,
    timeWindow: {
      startTime: '2026-01-29T08:00:00Z',
      endTime: '2026-01-29T16:00:00Z',
    },
    ...overrides,
  };
}

// Helper to create test providers
function createTestProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'provider-1',
    name: 'Test Provider',
    trust_score: 0.8,
    total_orders: 10,
    successful_orders: 8,
    ...overrides,
  };
}

describe('Matching Algorithm', () => {
  describe('Price Score Calculation', () => {
    it('should give score 1.0 to lowest priced offer', () => {
      const offers = [
        createTestOffer({ id: 'low', price: { value: 5, currency: 'INR' } }),
        createTestOffer({ id: 'high', price: { value: 10, currency: 'INR' } }),
      ];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = { requestedQuantity: 10 };

      const result = matchOffers(offers, providers, criteria);
      const lowPriceOffer = result.allOffers.find(o => o.offer.id === 'low');

      expect(lowPriceOffer?.breakdown.priceScore).toBe(1.0);
    });

    it('should give floor score (0.3) to highest priced offer', () => {
      const offers = [
        createTestOffer({ id: 'low', price: { value: 5, currency: 'INR' } }),
        createTestOffer({ id: 'high', price: { value: 10, currency: 'INR' } }),
      ];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = { requestedQuantity: 10 };

      const result = matchOffers(offers, providers, criteria);
      const highPriceOffer = result.allOffers.find(o => o.offer.id === 'high');

      expect(highPriceOffer?.breakdown.priceScore).toBeCloseTo(0.3, 2);
    });

    it('should give proportional score to middle priced offer', () => {
      const offers = [
        createTestOffer({ id: 'low', price: { value: 5, currency: 'INR' } }),
        createTestOffer({ id: 'mid', price: { value: 7.5, currency: 'INR' } }),
        createTestOffer({ id: 'high', price: { value: 10, currency: 'INR' } }),
      ];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = { requestedQuantity: 10 };

      const result = matchOffers(offers, providers, criteria);
      const midPriceOffer = result.allOffers.find(o => o.offer.id === 'mid');

      // Mid price should be between 0.3 and 1.0
      expect(midPriceOffer?.breakdown.priceScore).toBeGreaterThan(0.3);
      expect(midPriceOffer?.breakdown.priceScore).toBeLessThan(1.0);
      // Specifically: 0.3 + ((10 - 7.5) / (10 - 5)) * 0.7 = 0.3 + 0.35 = 0.65
      expect(midPriceOffer?.breakdown.priceScore).toBeCloseTo(0.65, 2);
    });

    it('should give score 1.0 when all offers have the same price', () => {
      const offers = [
        createTestOffer({ id: 'a', price: { value: 6, currency: 'INR' } }),
        createTestOffer({ id: 'b', price: { value: 6, currency: 'INR' } }),
        createTestOffer({ id: 'c', price: { value: 6, currency: 'INR' } }),
      ];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = { requestedQuantity: 10 };

      const result = matchOffers(offers, providers, criteria);

      result.allOffers.forEach(scoredOffer => {
        expect(scoredOffer.breakdown.priceScore).toBe(1.0);
      });
    });

    it('should give score 1.0 to a single offer', () => {
      const offers = [createTestOffer({ price: { value: 7, currency: 'INR' } })];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = { requestedQuantity: 10 };

      const result = matchOffers(offers, providers, criteria);

      expect(result.allOffers[0].breakdown.priceScore).toBe(1.0);
    });

    it('should handle zero price as lowest', () => {
      const offers = [
        createTestOffer({ id: 'zero', price: { value: 0, currency: 'INR' } }),
        createTestOffer({ id: 'normal', price: { value: 10, currency: 'INR' } }),
      ];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = { requestedQuantity: 10 };

      const result = matchOffers(offers, providers, criteria);
      const zeroOffer = result.allOffers.find(o => o.offer.id === 'zero');

      expect(zeroOffer?.breakdown.priceScore).toBe(1.0);
    });

    it('should handle very large price differences', () => {
      const offers = [
        createTestOffer({ id: 'cheap', price: { value: 5, currency: 'INR' } }),
        createTestOffer({ id: 'expensive', price: { value: 999999, currency: 'INR' } }),
      ];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = { requestedQuantity: 10 };

      const result = matchOffers(offers, providers, criteria);
      const expensiveOffer = result.allOffers.find(o => o.offer.id === 'expensive');

      expect(expensiveOffer?.breakdown.priceScore).toBeCloseTo(0.3, 2);
    });

    it('should handle floating point prices with precision', () => {
      const offers = [
        createTestOffer({ id: 'a', price: { value: 5.999999, currency: 'INR' } }),
        createTestOffer({ id: 'b', price: { value: 6.000001, currency: 'INR' } }),
      ];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = { requestedQuantity: 10 };

      const result = matchOffers(offers, providers, criteria);
      
      // Both should have valid scores
      expect(result.allOffers[0].breakdown.priceScore).toBeGreaterThan(0);
      expect(result.allOffers[1].breakdown.priceScore).toBeGreaterThan(0);
    });
  });

  describe('Filter Checks - Time Window', () => {
    it('should pass when time windows have exact overlap', () => {
      const offers = [
        createTestOffer({
          timeWindow: { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' },
        }),
      ];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = {
        requestedQuantity: 10,
        requestedTimeWindow: { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' },
      };

      const result = matchOffers(offers, providers, criteria);

      expect(result.allOffers[0].matchesFilters).toBe(true);
      expect(result.allOffers[0].filterReasons).not.toContain('Time window does not overlap');
    });

    it('should pass when time windows have partial overlap', () => {
      const offers = [
        createTestOffer({
          timeWindow: { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' },
        }),
      ];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = {
        requestedQuantity: 10,
        requestedTimeWindow: { startTime: '2026-01-29T10:00:00Z', endTime: '2026-01-29T14:00:00Z' },
      };

      const result = matchOffers(offers, providers, criteria);

      expect(result.allOffers[0].matchesFilters).toBe(true);
    });

    it('should fail when time windows do not overlap', () => {
      const offers = [
        createTestOffer({
          timeWindow: { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' },
        }),
      ];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = {
        requestedQuantity: 10,
        requestedTimeWindow: { startTime: '2026-01-29T14:00:00Z', endTime: '2026-01-29T18:00:00Z' },
      };

      const result = matchOffers(offers, providers, criteria);

      expect(result.allOffers[0].matchesFilters).toBe(false);
      expect(result.allOffers[0].filterReasons).toContain('Time window does not overlap');
    });

    it('should fail when time windows are adjacent (no overlap)', () => {
      const offers = [
        createTestOffer({
          timeWindow: { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' },
        }),
      ];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = {
        requestedQuantity: 10,
        requestedTimeWindow: { startTime: '2026-01-29T12:00:00Z', endTime: '2026-01-29T16:00:00Z' },
      };

      const result = matchOffers(offers, providers, criteria);

      expect(result.allOffers[0].matchesFilters).toBe(false);
    });

    it('should pass when offer has no time window (flexible)', () => {
      const offers = [
        createTestOffer({ timeWindow: undefined }),
      ];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = {
        requestedQuantity: 10,
        requestedTimeWindow: { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' },
      };

      const result = matchOffers(offers, providers, criteria);

      expect(result.allOffers[0].matchesFilters).toBe(true);
    });

    it('should pass when request has no time window (no constraint)', () => {
      const offers = [
        createTestOffer({
          timeWindow: { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T12:00:00Z' },
        }),
      ];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = {
        requestedQuantity: 10,
        requestedTimeWindow: undefined,
      };

      const result = matchOffers(offers, providers, criteria);

      expect(result.allOffers[0].matchesFilters).toBe(true);
    });

    it('should pass when both time windows are undefined', () => {
      const offers = [createTestOffer({ timeWindow: undefined })];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = {
        requestedQuantity: 10,
        requestedTimeWindow: undefined,
      };

      const result = matchOffers(offers, providers, criteria);

      expect(result.allOffers[0].matchesFilters).toBe(true);
    });
  });

  describe('Filter Checks - Quantity', () => {
    it('should pass when exact quantity is available', () => {
      const offers = [createTestOffer({ maxQuantity: 10 })];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = { requestedQuantity: 10 };

      const result = matchOffers(offers, providers, criteria);

      expect(result.allOffers[0].matchesFilters).toBe(true);
    });

    it('should pass when more than requested quantity is available', () => {
      const offers = [createTestOffer({ maxQuantity: 100 })];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = { requestedQuantity: 10 };

      const result = matchOffers(offers, providers, criteria);

      expect(result.allOffers[0].matchesFilters).toBe(true);
    });

    it('should fail when less than requested quantity is available', () => {
      const offers = [createTestOffer({ maxQuantity: 5 })];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = { requestedQuantity: 10 };

      const result = matchOffers(offers, providers, criteria);

      expect(result.allOffers[0].matchesFilters).toBe(false);
      expect(result.allOffers[0].filterReasons).toContain('Only 5 kWh available (need 10)');
    });

    it('should fail when zero quantity is available', () => {
      const offers = [createTestOffer({ maxQuantity: 0 })];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = { requestedQuantity: 10 };

      const result = matchOffers(offers, providers, criteria);

      expect(result.allOffers[0].matchesFilters).toBe(false);
      expect(result.allOffers[0].filterReasons).toContain('Only 0 kWh available (need 10)');
    });

    it('should pass when zero quantity is requested', () => {
      const offers = [createTestOffer({ maxQuantity: 10 })];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = { requestedQuantity: 0 };

      const result = matchOffers(offers, providers, criteria);

      expect(result.allOffers[0].matchesFilters).toBe(true);
    });

    it('should handle large quantities', () => {
      const offers = [createTestOffer({ maxQuantity: 10000 })];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = { requestedQuantity: 9999 };

      const result = matchOffers(offers, providers, criteria);

      expect(result.allOffers[0].matchesFilters).toBe(true);
    });
  });

  describe('Filter Checks - Max Price', () => {
    it('should pass when offer price is below max', () => {
      const offers = [createTestOffer({ price: { value: 5, currency: 'INR' } })];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = { requestedQuantity: 10, maxPrice: 10 };

      const result = matchOffers(offers, providers, criteria);

      expect(result.allOffers[0].matchesFilters).toBe(true);
    });

    it('should pass when offer price equals max', () => {
      const offers = [createTestOffer({ price: { value: 10, currency: 'INR' } })];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = { requestedQuantity: 10, maxPrice: 10 };

      const result = matchOffers(offers, providers, criteria);

      expect(result.allOffers[0].matchesFilters).toBe(true);
    });

    it('should fail when offer price exceeds max', () => {
      const offers = [createTestOffer({ price: { value: 15, currency: 'INR' } })];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = { requestedQuantity: 10, maxPrice: 10 };

      const result = matchOffers(offers, providers, criteria);

      expect(result.allOffers[0].matchesFilters).toBe(false);
      expect(result.allOffers[0].filterReasons).toContain('Price 15 exceeds max 10');
    });

    it('should pass when max price is undefined (no filter)', () => {
      const offers = [createTestOffer({ price: { value: 100, currency: 'INR' } })];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = { requestedQuantity: 10, maxPrice: undefined };

      const result = matchOffers(offers, providers, criteria);

      expect(result.allOffers[0].matchesFilters).toBe(true);
    });

    it('should fail when max price is zero and offer has any price', () => {
      const offers = [createTestOffer({ price: { value: 5, currency: 'INR' } })];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = { requestedQuantity: 10, maxPrice: 0 };

      const result = matchOffers(offers, providers, criteria);

      expect(result.allOffers[0].matchesFilters).toBe(false);
    });
  });

  describe('Filter Checks - Trust Threshold', () => {
    it('should pass when trust score is above threshold', () => {
      const offers = [createTestOffer()];
      const providers = new Map([['provider-1', createTestProvider({ trust_score: 0.5 })]]);
      const criteria: MatchingCriteria = { requestedQuantity: 10 };

      const result = matchOffers(offers, providers, criteria);

      expect(result.allOffers[0].matchesFilters).toBe(true);
    });

    it('should pass when trust score is at threshold', () => {
      const offers = [createTestOffer()];
      // Default threshold is 0.2
      const providers = new Map([['provider-1', createTestProvider({ trust_score: 0.2 })]]);
      const criteria: MatchingCriteria = { requestedQuantity: 10 };

      const result = matchOffers(offers, providers, criteria);

      expect(result.allOffers[0].matchesFilters).toBe(true);
    });

    it('should fail when trust score is below threshold', () => {
      const offers = [createTestOffer()];
      const providers = new Map([['provider-1', createTestProvider({ trust_score: 0.1 })]]);
      const criteria: MatchingCriteria = { requestedQuantity: 10 };

      const result = matchOffers(offers, providers, criteria);

      expect(result.allOffers[0].matchesFilters).toBe(false);
      expect(result.allOffers[0].filterReasons.some(r => r.includes('Trust score'))).toBe(true);
    });

    it('should fail when trust score is zero', () => {
      const offers = [createTestOffer()];
      const providers = new Map([['provider-1', createTestProvider({ trust_score: 0 })]]);
      const criteria: MatchingCriteria = { requestedQuantity: 10 };

      const result = matchOffers(offers, providers, criteria);

      expect(result.allOffers[0].matchesFilters).toBe(false);
    });

    it('should pass when trust score is maximum (1.0)', () => {
      const offers = [createTestOffer()];
      const providers = new Map([['provider-1', createTestProvider({ trust_score: 1.0 })]]);
      const criteria: MatchingCriteria = { requestedQuantity: 10 };

      const result = matchOffers(offers, providers, criteria);

      expect(result.allOffers[0].matchesFilters).toBe(true);
    });

    it('should use default trust score when provider is not found', () => {
      const offers = [createTestOffer({ provider_id: 'unknown-provider' })];
      const providers = new Map<string, Provider>(); // Empty map
      const criteria: MatchingCriteria = { requestedQuantity: 10 };

      const result = matchOffers(offers, providers, criteria);

      // Default trust score is 0.5, which is above threshold
      expect(result.allOffers[0].matchesFilters).toBe(true);
      expect(result.allOffers[0].provider.trust_score).toBe(0.5);
    });
  });

  describe('matchOffers - Full Integration', () => {
    it('should return empty result for empty offers array', () => {
      const providers = new Map<string, Provider>();
      const criteria: MatchingCriteria = { requestedQuantity: 10 };

      const result = matchOffers([], providers, criteria);

      expect(result.selectedOffer).toBeNull();
      expect(result.allOffers).toHaveLength(0);
      expect(result.eligibleCount).toBe(0);
      expect(result.reason).toBe('No offers available');
    });

    it('should return no selected offer when all offers fail filters', () => {
      const offers = [
        createTestOffer({ maxQuantity: 5 }), // Fails quantity
        createTestOffer({ maxQuantity: 3 }), // Fails quantity
      ];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = { requestedQuantity: 10 };

      const result = matchOffers(offers, providers, criteria);

      expect(result.selectedOffer).toBeNull();
      expect(result.eligibleCount).toBe(0);
      expect(result.allOffers).toHaveLength(2); // Still returns all offers
      expect(result.reason).toContain('No offers match');
    });

    it('should select the single passing offer', () => {
      const offers = [
        createTestOffer({ id: 'pass', maxQuantity: 100 }),
        createTestOffer({ id: 'fail', maxQuantity: 5 }),
      ];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = { requestedQuantity: 10 };

      const result = matchOffers(offers, providers, criteria);

      expect(result.selectedOffer?.offer.id).toBe('pass');
      expect(result.eligibleCount).toBe(1);
    });

    it('should select highest scored offer when multiple pass', () => {
      const offers = [
        createTestOffer({ id: 'expensive', price: { value: 10, currency: 'INR' }, provider_id: 'p1' }),
        createTestOffer({ id: 'cheap', price: { value: 5, currency: 'INR' }, provider_id: 'p2' }),
      ];
      const providers = new Map([
        ['p1', createTestProvider({ id: 'p1', trust_score: 0.8 })],
        ['p2', createTestProvider({ id: 'p2', trust_score: 0.8 })],
      ]);
      const criteria: MatchingCriteria = { requestedQuantity: 10 };

      const result = matchOffers(offers, providers, criteria);

      // Cheaper offer should be selected (higher price score)
      expect(result.selectedOffer?.offer.id).toBe('cheap');
      expect(result.eligibleCount).toBe(2);
    });

    it('should apply 50% penalty to non-matching offers in scoring', () => {
      const offers = [
        createTestOffer({ id: 'pass', maxQuantity: 100, price: { value: 10, currency: 'INR' } }),
        createTestOffer({ id: 'fail', maxQuantity: 5, price: { value: 5, currency: 'INR' } }),
      ];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = { requestedQuantity: 10 };

      const result = matchOffers(offers, providers, criteria);
      const passOffer = result.allOffers.find(o => o.offer.id === 'pass');
      const failOffer = result.allOffers.find(o => o.offer.id === 'fail');

      // Even though fail offer has better price, it should have lower final score
      expect(passOffer!.matchesFilters).toBe(true);
      expect(failOffer!.matchesFilters).toBe(false);
      // Pass offer should be ranked higher
      expect(result.allOffers[0].offer.id).toBe('pass');
    });

    it('should sort matching offers first, then by score', () => {
      const offers = [
        createTestOffer({ id: 'fail-cheap', maxQuantity: 5, price: { value: 1, currency: 'INR' } }),
        createTestOffer({ id: 'pass-mid', maxQuantity: 100, price: { value: 7, currency: 'INR' } }),
        createTestOffer({ id: 'pass-cheap', maxQuantity: 100, price: { value: 5, currency: 'INR' } }),
        createTestOffer({ id: 'fail-expensive', maxQuantity: 5, price: { value: 10, currency: 'INR' } }),
      ];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = { requestedQuantity: 10 };

      const result = matchOffers(offers, providers, criteria);

      // First should be matching offers (sorted by score)
      expect(result.allOffers[0].matchesFilters).toBe(true);
      expect(result.allOffers[1].matchesFilters).toBe(true);
      // Then non-matching offers
      expect(result.allOffers[2].matchesFilters).toBe(false);
      expect(result.allOffers[3].matchesFilters).toBe(false);
    });

    it('should include score breakdown for all offers', () => {
      const offers = [createTestOffer()];
      const providers = new Map([['provider-1', createTestProvider({ trust_score: 0.7 })]]);
      const criteria: MatchingCriteria = { requestedQuantity: 10 };

      const result = matchOffers(offers, providers, criteria);

      expect(result.allOffers[0].breakdown).toBeDefined();
      expect(result.allOffers[0].breakdown.priceScore).toBeDefined();
      expect(result.allOffers[0].breakdown.trustScore).toBe(0.7);
      expect(result.allOffers[0].breakdown.timeWindowFitScore).toBeDefined();
    });

    it('should give perfect time window fit score when no time constraint', () => {
      const offers = [createTestOffer()];
      const providers = new Map([['provider-1', createTestProvider()]]);
      const criteria: MatchingCriteria = { 
        requestedQuantity: 10,
        requestedTimeWindow: undefined,
      };

      const result = matchOffers(offers, providers, criteria);

      expect(result.allOffers[0].breakdown.timeWindowFitScore).toBe(1);
    });
  });

  describe('calculateUpdatedTrustScore', () => {
    it('should calculate 0.85 trust for 100% success rate', () => {
      const provider = createTestProvider({ total_orders: 0, successful_orders: 0 });
      
      const newScore = calculateUpdatedTrustScore(provider, true);
      
      // 0.7 * 1.0 + 0.3 * 0.5 = 0.85
      expect(newScore).toBeCloseTo(0.85, 2);
    });

    it('should calculate 0.15 trust for 0% success rate', () => {
      const provider = createTestProvider({ total_orders: 0, successful_orders: 0 });
      
      const newScore = calculateUpdatedTrustScore(provider, false);
      
      // 0.7 * 0.0 + 0.3 * 0.5 = 0.15
      expect(newScore).toBeCloseTo(0.15, 2);
    });

    it('should calculate 0.5 trust for 50% success rate', () => {
      const provider = createTestProvider({ total_orders: 9, successful_orders: 5 });
      
      // After this order (failed), will be 10 total, 5 successful = 50%
      const newScore = calculateUpdatedTrustScore(provider, false);
      
      // 0.7 * 0.5 + 0.3 * 0.5 = 0.5
      expect(newScore).toBeCloseTo(0.5, 2);
    });

    it('should calculate correct trust for 80% success rate', () => {
      const provider = createTestProvider({ total_orders: 99, successful_orders: 80 });
      
      // After this order (successful), will be 100 total, 81 successful = 81%
      const newScore = calculateUpdatedTrustScore(provider, true);
      
      // 0.7 * 0.81 + 0.3 * 0.5 = 0.567 + 0.15 = 0.717
      expect(newScore).toBeCloseTo(0.717, 2);
    });

    it('should handle first order correctly', () => {
      const provider = createTestProvider({ total_orders: 0, successful_orders: 0 });
      
      const successScore = calculateUpdatedTrustScore(provider, true);
      const failScore = calculateUpdatedTrustScore(provider, false);
      
      expect(successScore).toBeCloseTo(0.85, 2); // 1/1 = 100%
      expect(failScore).toBeCloseTo(0.15, 2); // 0/1 = 0%
    });

    it('should not exceed 1.0 for perfect track record', () => {
      const provider = createTestProvider({ total_orders: 1000, successful_orders: 1000 });
      
      const newScore = calculateUpdatedTrustScore(provider, true);
      
      expect(newScore).toBeLessThanOrEqual(1.0);
      expect(newScore).toBeCloseTo(0.85, 2); // Max is 0.7 * 1.0 + 0.3 * 0.5
    });

    it('should not go below 0.15 for zero success rate', () => {
      const provider = createTestProvider({ total_orders: 1000, successful_orders: 0 });
      
      const newScore = calculateUpdatedTrustScore(provider, false);
      
      expect(newScore).toBeGreaterThanOrEqual(0.15);
      expect(newScore).toBeCloseTo(0.15, 2); // Min is 0.7 * 0.0 + 0.3 * 0.5
    });
  });

  describe('Multiple Filter Failures', () => {
    it('should collect all filter failure reasons', () => {
      const offers = [
        createTestOffer({
          maxQuantity: 5,
          price: { value: 100, currency: 'INR' },
          timeWindow: { startTime: '2026-01-29T08:00:00Z', endTime: '2026-01-29T10:00:00Z' },
        }),
      ];
      const providers = new Map([['provider-1', createTestProvider({ trust_score: 0.1 })]]);
      const criteria: MatchingCriteria = {
        requestedQuantity: 10,
        maxPrice: 50,
        requestedTimeWindow: { startTime: '2026-01-29T14:00:00Z', endTime: '2026-01-29T18:00:00Z' },
      };

      const result = matchOffers(offers, providers, criteria);

      expect(result.allOffers[0].matchesFilters).toBe(false);
      expect(result.allOffers[0].filterReasons.length).toBeGreaterThanOrEqual(3);
      expect(result.allOffers[0].filterReasons.some(r => r.includes('kWh available'))).toBe(true);
      expect(result.allOffers[0].filterReasons.some(r => r.includes('exceeds max'))).toBe(true);
      expect(result.allOffers[0].filterReasons.some(r => r.includes('Time window'))).toBe(true);
    });
  });
});
