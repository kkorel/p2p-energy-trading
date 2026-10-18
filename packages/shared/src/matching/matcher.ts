/**
 * Multi-Criteria Weighted Scoring Matcher for P2P Energy Trading
 * 
 * Based on Uber/Ola style filter-then-rank approach:
 * 1. Hard filters: time window overlap, quantity available
 * 2. Soft scoring: price, trust, time window fit
 * 
 * ALL offers are scored and returned, with a flag indicating if they match filters.
 * This allows the UI to show all offers with their scores, sorted by match quality.
 */

import { CatalogOffer, Provider } from '../types/catalog';
import { TimeWindow } from '../types/beckn';
import { timeWindowsOverlap, calculateTimeWindowFit } from '../utils/time';
import { config } from '../config';

export interface MatchingCriteria {
  requestedQuantity: number;
  requestedTimeWindow?: TimeWindow;
  maxPrice?: number;
}

export interface ScoredOffer {
  offer: CatalogOffer;
  provider: Provider;
  score: number;
  matchesFilters: boolean;
  filterReasons: string[];
  breakdown: {
    priceScore: number;
    trustScore: number;
    timeWindowFitScore: number;
  };
}

export interface MatchingResult {
  selectedOffer: ScoredOffer | null;
  allOffers: ScoredOffer[];
  eligibleCount: number;
  reason?: string;
}

/**
 * Normalize price score (lower price = higher score)
 * Uses a floor to ensure even the most expensive offer gets some score (not 0%)
 */
function calculatePriceScore(offerPrice: number, minPrice: number, maxPrice: number): number {
  if (maxPrice === minPrice) return 1; // All same price, give full score
  // Calculate base score, but apply a floor so max-priced offer gets 0.3 (30%), not 0%
  const rawScore = (maxPrice - offerPrice) / (maxPrice - minPrice);
  // Scale to 0.3-1.0 range instead of 0-1 (so even highest price gets 30%)
  return 0.3 + rawScore * 0.7;
}

/**
 * Check if an offer passes the hard filters
 */
function checkOfferFilters(
  offer: CatalogOffer,
  provider: Provider | undefined,
  criteria: MatchingCriteria
): { matches: boolean; reasons: string[] } {
  const reasons: string[] = [];
  
  // Check time window overlap (handle missing timeWindow gracefully)
  const offerTimeWindow = offer.timeWindow || undefined;
  if (criteria.requestedTimeWindow && !timeWindowsOverlap(offerTimeWindow, criteria.requestedTimeWindow)) {
    reasons.push('Time window does not overlap');
  }
  
  // Check quantity available
  if (offer.maxQuantity < criteria.requestedQuantity) {
    reasons.push(`Only ${offer.maxQuantity} kWh available (need ${criteria.requestedQuantity})`);
  }
  
  // Check max price if specified
  if (criteria.maxPrice !== undefined && offer.price.value > criteria.maxPrice) {
    reasons.push(`Price ${offer.price.value} exceeds max ${criteria.maxPrice}`);
  }
  
  // Check minimum trust threshold
  if (provider && provider.trust_score < config.matching.minTrustThreshold) {
    reasons.push(`Trust score ${(provider.trust_score * 100).toFixed(0)}% below minimum ${(config.matching.minTrustThreshold * 100).toFixed(0)}%`);
  }
  
  return {
    matches: reasons.length === 0,
    reasons,
  };
}

/**
 * Main matching function - scores ALL offers and ranks them
 * Returns all offers with scores, sorted by score descending.
 * Offers that don't match filters have matchesFilters=false but still have scores.
 */
export function matchOffers(
  offers: CatalogOffer[],
  providers: Map<string, Provider>,
  criteria: MatchingCriteria
): MatchingResult {
  const weights = config.matching.weights;
  
  if (offers.length === 0) {
    return {
      selectedOffer: null,
      allOffers: [],
      eligibleCount: 0,
      reason: 'No offers available',
    };
  }
  
  // Calculate price range for normalization (using ALL offers)
  const prices = offers.map(o => o.price.value);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  
  // Score ALL offers
  const scoredOffers: ScoredOffer[] = offers.map(offer => {
    const provider = providers.get(offer.provider_id) || {
      id: offer.provider_id,
      name: 'Unknown Provider',
      trust_score: config.matching.defaultTrustScore,
      total_orders: 0,
      successful_orders: 0,
    };
    
    // Check if offer passes hard filters
    const { matches, reasons } = checkOfferFilters(offer, provider, criteria);
    
    // Calculate individual scores
    const priceScore = calculatePriceScore(offer.price.value, minPrice, maxPrice);
    const trustScore = provider.trust_score;
    const offerTimeWindow = offer.timeWindow || undefined;
    const timeWindowFitScore = criteria.requestedTimeWindow 
      ? calculateTimeWindowFit(offerTimeWindow, criteria.requestedTimeWindow)
      : 1; // Perfect fit if no time constraints
    
    // Calculate weighted total score
    // Offers that don't match filters get a penalty to sort them lower
    const baseScore = 
      weights.price * priceScore +
      weights.trust * trustScore +
      weights.timeWindowFit * timeWindowFitScore;
    
    // Apply penalty for non-matching offers (sort them to the bottom)
    const score = matches ? baseScore : baseScore * 0.5;
    
    return {
      offer,
      provider,
      score,
      matchesFilters: matches,
      filterReasons: reasons,
      breakdown: {
        priceScore,
        trustScore,
        timeWindowFitScore,
      },
    };
  });
  
  // Sort by score descending (matching offers will be at the top due to penalty)
  scoredOffers.sort((a, b) => {
    // First, sort by matchesFilters (matching offers first)
    if (a.matchesFilters !== b.matchesFilters) {
      return a.matchesFilters ? -1 : 1;
    }
    // Then by score descending
    return b.score - a.score;
  });
  
  // Count eligible offers
  const eligibleCount = scoredOffers.filter(o => o.matchesFilters).length;
  
  // Select best eligible offer
  const selectedOffer = scoredOffers.find(o => o.matchesFilters) || null;
  
  return {
    selectedOffer,
    allOffers: scoredOffers,
    eligibleCount,
    reason: eligibleCount === 0 
      ? 'No offers match the criteria (time window, quantity, price, or trust threshold)'
      : undefined,
  };
}

/**
 * Update provider trust score after order completion
 */
export function calculateUpdatedTrustScore(
  provider: Provider,
  wasSuccessful: boolean
): number {
  const newTotalOrders = provider.total_orders + 1;
  const newSuccessfulOrders = provider.successful_orders + (wasSuccessful ? 1 : 0);
  
  // Trust formula: 70% based on success rate, 30% base rating
  const successRate = newSuccessfulOrders / newTotalOrders;
  const baseRating = 0.5; // Could be external rating in future
  
  return successRate * 0.7 + baseRating * 0.3;
}
