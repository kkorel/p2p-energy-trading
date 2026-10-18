/**
 * Order Types for P2P Energy Trading
 */

import { Price, TimeWindow } from './beckn';

// Order status
export type OrderStatus = 'DRAFT' | 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';

// Order item in select/init/confirm
export interface OrderItem {
  item_id: string;
  offer_id: string;
  provider_id: string;
  quantity: number; // kWh
  price: Price;
  timeWindow: TimeWindow;
  source_type?: string; // Energy source type (SOLAR, WIND, etc.) - stored for history even after offer deletion
}

// Quote breakdown
export interface Quote {
  price: Price;
  totalQuantity: number;
  breakdown?: QuoteBreakdown[];
}

export interface QuoteBreakdown {
  title: string;
  price: Price;
}

// Full order structure
export interface Order {
  id: string;
  transaction_id: string;
  status: OrderStatus;
  items: OrderItem[];
  quote: Quote;
  created_at: string;
  updated_at: string;
  bulkGroupId?: string; // Links orders from same bulk purchase
}

// Provider attributes for Beckn order items (used in select/init/on_update)
export interface OrderItemProviderAttributes {
  '@context'?: string;
  '@type'?: string;
  meterId?: string;
  utility?: string;
  utilityCustomerId?: string;
  userType?: string;
}

// Beckn order item attributes (wraps provider + fulfillment attributes)
export interface OrderItemAttributes {
  '@context'?: string;
  '@type'?: string;
  providerAttributes?: OrderItemProviderAttributes;
}

// Order in select request
export interface SelectOrderItem {
  item_id: string;
  offer_id: string;
  quantity: number;
  'beckn:orderItemAttributes'?: OrderItemAttributes;
}

// Fulfillment (stubbed for Phase-1)
export interface Fulfillment {
  id: string;
  type: 'ENERGY_DELIVERY';
  state: {
    descriptor: {
      code: string;
      name: string;
    };
  };
  start?: {
    time: TimeWindow;
  };
  end?: {
    time: TimeWindow;
  };
}
