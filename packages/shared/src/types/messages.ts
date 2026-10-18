/**
 * Beckn Message Types for P2P Energy Trading
 * Defines the structure of discover/select/init/confirm/status messages
 */

import { BecknMessage, TimeWindow, Quantity } from './beckn';
import { Catalog, CatalogItem, SourceType, DeliveryMode } from './catalog';
import { Order, SelectOrderItem, Quote, Fulfillment } from './orders';

// ============ DISCOVER ============

export interface DiscoverFilters {
  type: 'jsonpath';
  expression: string;
}

export interface DiscoverIntent {
  item?: {
    itemAttributes?: {
      sourceType?: SourceType;
      deliveryMode?: DeliveryMode;
      availableQuantity?: number;
    };
  };
  fulfillment?: {
    time?: TimeWindow;
  };
  quantity?: Quantity;
}

export interface DiscoverMessageContent {
  intent?: DiscoverIntent;
  filters?: DiscoverFilters;
}

export type DiscoverMessage = BecknMessage<DiscoverMessageContent>;

// ============ ON_DISCOVER ============

export interface OnDiscoverMessageContent {
  catalog: Catalog;
}

export type OnDiscoverMessage = BecknMessage<OnDiscoverMessageContent>;

// ============ SELECT ============

export interface SelectMessageContent {
  orderItems: SelectOrderItem[];
}

export type SelectMessage = BecknMessage<SelectMessageContent>;

// ============ ON_SELECT ============

export interface OnSelectMessageContent {
  order: {
    id: string;
    items: SelectOrderItem[];
    quote: Quote;
    provider: {
      id: string;
      descriptor?: { name: string };
    };
  };
}

export type OnSelectMessage = BecknMessage<OnSelectMessageContent>;

// ============ INIT ============

export interface InitMessageContent {
  order: {
    id?: string;
    items: SelectOrderItem[];
    provider: { id: string };
    quote?: Quote;
  };
}

export type InitMessage = BecknMessage<InitMessageContent>;

// ============ ON_INIT ============

export interface OnInitMessageContent {
  order: Order;
}

export type OnInitMessage = BecknMessage<OnInitMessageContent>;

// ============ CONFIRM ============

export interface ConfirmMessageContent {
  order: {
    id: string;
  };
}

export type ConfirmMessage = BecknMessage<ConfirmMessageContent>;

// ============ ON_CONFIRM ============

export interface OnConfirmMessageContent {
  order: Order;
}

export type OnConfirmMessage = BecknMessage<OnConfirmMessageContent>;

// ============ STATUS ============

export interface StatusMessageContent {
  order_id: string;
}

export type StatusMessage = BecknMessage<StatusMessageContent>;

// ============ ON_STATUS ============

export interface OnStatusMessageContent {
  order: Order;
  fulfillment?: Fulfillment;
}

export type OnStatusMessage = BecknMessage<OnStatusMessageContent>;

// ============ CANCEL ============

export interface CancelMessageContent {
  order_id: string;
  reason?: string;
}

export type CancelMessage = BecknMessage<CancelMessageContent>;

// ============ ON_CANCEL ============

export interface OnCancelMessageContent {
  order: Order;
  cancellation: {
    cancelled_by: 'BUYER' | 'SELLER' | 'SYSTEM';
    reason?: string;
    refund_status?: 'INITIATED' | 'COMPLETED' | 'NONE';
  };
}

export type OnCancelMessage = BecknMessage<OnCancelMessageContent>;

// ============ ON_UPDATE ============
// Received from Utility BPP (DISCOM) with delivery progress/curtailment

/**
 * Meter reading during delivery window
 * Schema: EnergyTradeDelivery/v0.2
 */
export interface MeterReading {
  'beckn:timeWindow'?: {
    '@type': 'beckn:TimePeriod';
    'schema:startTime': string;
    'schema:endTime': string;
  };
  consumedEnergy: number;
  producedEnergy: number;
  allocatedEnergy: number;
  unit: string;
}

/**
 * Fulfillment attributes for energy delivery
 * Schema: EnergyTradeDelivery/v0.2
 */
export interface EnergyFulfillmentAttributes {
  '@context'?: string;
  '@type'?: 'EnergyTradeDelivery';
  deliveryStatus: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  deliveryMode: 'GRID_INJECTION' | 'DIRECT_TRANSFER';
  deliveredQuantity: number;
  curtailedQuantity?: number;
  curtailmentReason?: 'GRID_OUTAGE' | 'SELLER_UNDERDELIVERY' | 'BUYER_OVERCONSUMPTION' | 'TECHNICAL_ISSUE';
  meterReadings?: MeterReading[];
  lastUpdated: string;
}

/**
 * Order item with fulfillment data (as received in on_update)
 */
export interface OnUpdateOrderItem {
  'beckn:orderedItem': string;
  'beckn:quantity': {
    unitQuantity: number;
    unitText: string;
  };
  'beckn:orderItemAttributes'?: {
    '@context'?: string;
    '@type'?: string;
    providerAttributes?: {
      '@context'?: string;
      '@type'?: string;
      meterId?: string;
      utilityCustomerId?: string;
    };
    fulfillmentAttributes?: EnergyFulfillmentAttributes;
  };
  'beckn:acceptedOffer'?: {
    'beckn:id': string;
    [key: string]: any;
  };
}

export interface OnUpdateMessageContent {
  order: {
    '@context'?: string;
    '@type'?: string;
    'beckn:id': string;
    'beckn:orderStatus': 'CREATED' | 'INPROGRESS' | 'COMPLETED' | 'CANCELLED' | 'PARTIALLYFULFILLED';
    'beckn:seller': string;
    'beckn:buyer'?: {
      'beckn:id': string;
      [key: string]: any;
    };
    'beckn:orderItems': OnUpdateOrderItem[];
  };
}

export type OnUpdateMessage = BecknMessage<OnUpdateMessageContent>;
