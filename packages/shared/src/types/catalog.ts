/**
 * Catalog Types for P2P Energy Trading
 * Based on Beckn EnergyResource and EnergyTradeOffer attributes
 */

import { TimeWindow, Price } from './beckn';

// Energy source types
export type SourceType = 'SOLAR' | 'WIND' | 'HYDRO' | 'BIOMASS' | 'GRID';

// Delivery mode - always SCHEDULED for P2P energy trading (energy is time-bound)
export type DeliveryMode = 'SCHEDULED';

// Item attributes following EnergyResource schema
export interface ItemAttributes {
  sourceType: SourceType;
  deliveryMode: DeliveryMode; // Always 'SCHEDULED' - energy delivery is time-bound
  meterId: string;
  availableQuantity: number; // kWh
  productionWindow: TimeWindow[];
}

// Catalog item (energy resource)
export interface CatalogItem {
  id: string;
  descriptor?: {
    name: string;
    description?: string;
  };
  provider_id: string;
  itemAttributes: ItemAttributes;
  offers: CatalogOffer[];
}

// Pricing model
export type PricingModel = 'PER_KWH' | 'FLAT_RATE' | 'TIME_OF_USE';

// Settlement type
export type SettlementType = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'INSTANT';

// Offer attributes following EnergyTradeOffer schema
export interface OfferAttributes {
  pricingModel: PricingModel;
  settlementType: SettlementType;
}

// Catalog offer
export interface CatalogOffer {
  id: string;
  item_id: string;
  provider_id: string;
  offerAttributes: OfferAttributes;
  price: Price;
  maxQuantity: number; // kWh
  timeWindow: TimeWindow;
  // BPP routing info for proper Beckn flows
  bpp_id?: string;
  bpp_uri?: string;
}

// Provider (BPP) information
export interface Provider {
  id: string;
  name: string;
  trust_score: number; // 0.0 to 1.0
  total_orders: number;
  successful_orders: number;
}

// Full catalog structure returned in on_discover
export interface Catalog {
  providers: ProviderCatalog[];
}

export interface ProviderCatalog {
  id: string;
  descriptor?: {
    name: string;
  };
  // BPP routing info for proper Beckn flows
  bpp_id?: string;
  bpp_uri?: string;
  items: CatalogItem[];
}
