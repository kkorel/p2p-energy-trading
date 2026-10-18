/**
 * Bulk Matcher - Selects multiple offers to fulfill a target quantity
 *
 * Uses a greedy best-first algorithm:
 * 1. Sort offers by matching score (descending)
 * 2. Select offers until target quantity reached or maxOffers limit hit
 * 3. For each offer: take min(availableQuantity, remaining needed)
 */

import { CatalogOffer, Provider } from '../types/catalog';
import { ScoredOffer } from './matcher';

export interface BulkSelectedOffer {
  offer: CatalogOffer;
  provider: Provider;
  quantity: number;  // kWh to buy from this offer
  score: number;
  subtotal: number;  // price.value * quantity
}

export interface BulkSelectionResult {
  selectedOffers: BulkSelectedOffer[];
  totalQuantity: number;
  totalPrice: number;
  fullyFulfilled: boolean;
  shortfall: number;
  offersUsed: number;
  offersAvailable: number;
}

/**
 * Select offers to fulfill a target quantity using greedy best-first algorithm
 *
 * @param scoredOffers - Offers already scored by the matching algorithm
 * @param targetQuantity - Total kWh requested
 * @param maxOffers - Maximum number of offers to combine (default 15)
 * @param availableBlockCounts - Optional map of offer_id -> available blocks (for real-time availability)
 * @returns BulkSelectionResult with selected offers and fulfillment status
 */
export function selectOffersForBulk(
  scoredOffers: ScoredOffer[],
  targetQuantity: number,
  maxOffers: number = 15,
  availableBlockCounts?: Map<string, number>
): BulkSelectionResult {
  const selectedOffers: BulkSelectedOffer[] = [];
  let totalQuantity = 0;
  let totalPrice = 0;

  // Filter to only offers that match filters and sort by score descending
  const eligibleOffers = scoredOffers
    .filter(o => o.matchesFilters)
    .sort((a, b) => b.score - a.score);

  for (const scored of eligibleOffers) {
    // Stop if we've reached target quantity
    if (totalQuantity >= targetQuantity) break;

    // Stop if we've hit max offers limit
    if (selectedOffers.length >= maxOffers) break;

    // Determine available quantity for this offer
    // Use real-time block count if provided, otherwise use offer's maxQuantity
    const availableFromOffer = availableBlockCounts?.has(scored.offer.id)
      ? availableBlockCounts.get(scored.offer.id)!
      : scored.offer.maxQuantity;

    // Skip if no availability
    if (availableFromOffer <= 0) continue;

    // Calculate how much to take from this offer
    const remainingNeeded = targetQuantity - totalQuantity;
    const quantityFromOffer = Math.min(availableFromOffer, remainingNeeded);

    // Skip if we can't take any meaningful quantity
    if (quantityFromOffer <= 0) continue;

    const subtotal = scored.offer.price.value * quantityFromOffer;

    selectedOffers.push({
      offer: scored.offer,
      provider: scored.provider,
      quantity: quantityFromOffer,
      score: scored.score,
      subtotal,
    });

    totalQuantity += quantityFromOffer;
    totalPrice += subtotal;
  }

  const fullyFulfilled = totalQuantity >= targetQuantity;
  const shortfall = Math.max(0, targetQuantity - totalQuantity);

  return {
    selectedOffers,
    totalQuantity,
    totalPrice,
    fullyFulfilled,
    shortfall,
    offersUsed: selectedOffers.length,
    offersAvailable: eligibleOffers.length,
  };
}

/**
 * Calculate average price per kWh for a bulk selection
 */
export function calculateAveragePrice(result: BulkSelectionResult): number {
  if (result.totalQuantity === 0) return 0;
  return result.totalPrice / result.totalQuantity;
}

/**
 * Format bulk selection result for API response
 */
export function formatBulkSelectionResponse(result: BulkSelectionResult) {
  return {
    selectedOffers: result.selectedOffers.map(s => ({
      offer_id: s.offer.id,
      item_id: s.offer.item_id,
      provider_id: s.offer.provider_id,
      provider_name: s.provider.name,
      quantity: s.quantity,
      unit_price: s.offer.price.value,
      currency: s.offer.price.currency,
      subtotal: s.subtotal,
      score: s.score,
      timeWindow: s.offer.timeWindow,
    })),
    summary: {
      totalQuantity: result.totalQuantity,
      totalPrice: result.totalPrice,
      averagePrice: calculateAveragePrice(result),
      currency: result.selectedOffers[0]?.offer.price.currency || 'INR',
      fullyFulfilled: result.fullyFulfilled,
      shortfall: result.shortfall,
      offersUsed: result.offersUsed,
      offersAvailable: result.offersAvailable,
    },
  };
}
