/**
 * Shared Seed Data for P2P Energy Trading
 * Used by both BPP and CDS services
 */

import { SourceType, DeliveryMode, OfferAttributes } from '../types/catalog';
import { TimeWindow } from '../types/beckn';

// Get tomorrow's date for realistic time windows
function getTomorrowDateStr(): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow.toISOString().split('T')[0];
}

export interface SeedProvider {
  id: string;
  name: string;
  trust_score: number;
  total_orders: number;
  successful_orders: number;
}

export interface SeedItem {
  id: string;
  provider_id: string;
  source_type: SourceType;
  delivery_mode: DeliveryMode;
  available_qty: number;
  meter_id: string;
  production_windows: TimeWindow[];
}

export interface SeedOffer {
  id: string;
  item_id: string;
  provider_id: string;
  price_value: number;
  currency: string;
  max_qty: number;
  time_window: TimeWindow;
  offer_attributes: OfferAttributes;
}

export interface SeedData {
  providers: SeedProvider[];
  items: SeedItem[];
  offers: SeedOffer[];
}

/**
 * Generate seed data with proper date-based time windows
 */
export function generateSeedData(): SeedData {
  const dateStr = getTomorrowDateStr();

  return {
    providers: [
      {
        id: 'provider-solar-alpha',
        name: 'Alpha Solar Energy',
        trust_score: 0.85,
        total_orders: 20,
        successful_orders: 17,
      },
      {
        id: 'provider-solar-beta',
        name: 'Beta Green Power',
        trust_score: 0.60,
        total_orders: 5,
        successful_orders: 3,
      },
    ],

    items: [
      {
        id: 'item-solar-001',
        provider_id: 'provider-solar-alpha',
        source_type: 'SOLAR',
        delivery_mode: 'SCHEDULED',
        available_qty: 100,
        meter_id: 'MTR-ALPHA-001',
        production_windows: [
          { startTime: `${dateStr}T08:00:00Z`, endTime: `${dateStr}T18:00:00Z` },
        ],
      },
      {
        id: 'item-solar-002',
        provider_id: 'provider-solar-beta',
        source_type: 'SOLAR',
        delivery_mode: 'SCHEDULED',
        available_qty: 150,
        meter_id: 'MTR-BETA-001',
        production_windows: [
          { startTime: `${dateStr}T06:00:00Z`, endTime: `${dateStr}T20:00:00Z` },
        ],
      },
    ],

    offers: [
      {
        id: 'offer-alpha-morning',
        item_id: 'item-solar-001',
        provider_id: 'provider-solar-alpha',
        price_value: 6.50,
        currency: 'INR',
        max_qty: 50,
        time_window: { startTime: `${dateStr}T10:00:00Z`, endTime: `${dateStr}T14:00:00Z` },
        offer_attributes: { pricingModel: 'PER_KWH', settlementType: 'DAILY' },
      },
      {
        id: 'offer-beta-afternoon',
        item_id: 'item-solar-002',
        provider_id: 'provider-solar-beta',
        price_value: 5.25,
        currency: 'INR',
        max_qty: 100,
        time_window: { startTime: `${dateStr}T12:00:00Z`, endTime: `${dateStr}T18:00:00Z` },
        offer_attributes: { pricingModel: 'PER_KWH', settlementType: 'DAILY' },
      },
    ],
  };
}
