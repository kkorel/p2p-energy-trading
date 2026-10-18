/**
 * Beckn v2 Wire Format Utilities
 *
 * Converts between internal data structures and the Beckn v2 order format
 * used on the wire between BAP ↔ BPP (as defined in the Postman spec).
 *
 * Wire format uses beckn: prefixed keys:
 *   message.order.beckn:orderItems[], beckn:seller, beckn:buyer, etc.
 *
 * Internal format uses simplified keys:
 *   message.orderItems[], order.items[], order.id, etc.
 */

const BECKN_CORE_CONTEXT =
  'https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/core/v2/context.jsonld';
const BECKN_ENERGY_TRADE_CONTEXT =
  'https://raw.githubusercontent.com/beckn/protocol-specifications-v2/refs/heads/p2p-trading/schema/EnergyTrade/v0.3/context.jsonld';

// ===================== Types =====================

export interface WireOrderItem {
  'beckn:orderedItem': string;
  'beckn:quantity': { unitQuantity: number; unitText: string };
  'beckn:orderItemAttributes'?: {
    '@context'?: string;
    '@type'?: string;
    providerAttributes?: {
      '@context'?: string;
      '@type'?: string;
      meterId?: string;
      utilityCustomerId?: string;
      utilityId?: string;
      userType?: string;
    };
    fulfillmentAttributes?: any;
  };
  'beckn:acceptedOffer'?: {
    '@context'?: string;
    '@type'?: string;
    'beckn:id': string;
    'beckn:descriptor'?: { '@type': string; 'schema:name': string };
    'beckn:provider'?: string;
    'beckn:items'?: string[];
    'beckn:price'?: {
      '@type'?: string;
      'schema:price': number;
      'schema:priceCurrency': string;
      'schema:unitText'?: string;
    };
    'beckn:offerAttributes'?: any;
  };
}

export interface WireOrder {
  '@context'?: string;
  '@type'?: string;
  'beckn:id'?: string;
  'beckn:orderStatus'?: string;
  'beckn:seller'?: string;
  'beckn:buyer'?: {
    '@context'?: string;
    '@type'?: string;
    'beckn:id': string;
    'beckn:buyerAttributes'?: {
      '@context'?: string;
      '@type'?: string;
      meterId?: string;
      utilityCustomerId?: string;
      utilityId?: string;
    };
  };
  'beckn:orderAttributes'?: {
    '@context'?: string;
    '@type'?: string;
    bap_id?: string;
    bpp_id?: string;
    total_quantity?: { unitQuantity: number; unitText: string };
  };
  'beckn:orderItems'?: WireOrderItem[];
  'beckn:fulfillment'?: any;
  'beckn:payment'?: any;
}

// ===================== Internal → Wire builders =====================

export interface BuildSelectOrderOptions {
  sellerId: string;
  buyerId: string;
  buyerMeterId?: string;
  buyerUtilityCustomerId?: string;
  buyerUtilityId?: string;
  bapId: string;
  bppId: string;
  items: Array<{
    itemId: string;
    quantity: number;
    offerId: string;
    offerPrice: number;
    offerCurrency: string;
    offerProvider: string;
    offerItems: string[];
    offerName?: string;
    offerTimeWindow?: { startTime: string; endTime: string } | null;
    providerMeterId?: string;
    providerUtilityCustomerId?: string;
    providerUtilityId?: string;
  }>;
}

/**
 * Build a Beckn v2 wire-format order for select/init/confirm messages.
 */
export function buildWireOrder(opts: BuildSelectOrderOptions, orderStatus = 'CREATED'): WireOrder {
  const totalQuantity = opts.items.reduce((sum, i) => sum + i.quantity, 0);

  const wireItems: WireOrderItem[] = opts.items.map(item => ({
    'beckn:orderedItem': item.itemId,
    'beckn:quantity': { unitQuantity: item.quantity, unitText: 'kWh' },
    'beckn:orderItemAttributes': {
      '@context': BECKN_ENERGY_TRADE_CONTEXT,
      '@type': 'EnergyOrderItem',
      providerAttributes: {
        '@context': BECKN_ENERGY_TRADE_CONTEXT,
        '@type': 'EnergyCustomer',
        meterId: item.providerMeterId,
        utilityCustomerId: item.providerUtilityCustomerId,
        utilityId: item.providerUtilityId,
        userType: 'PROSUMER', // Default to PROSUMER for P2P sellers
      },
    },
    'beckn:acceptedOffer': {
      '@context': BECKN_CORE_CONTEXT,
      '@type': 'beckn:Offer',
      'beckn:id': item.offerId,
      'beckn:descriptor': {
        '@type': 'beckn:Descriptor',
        'schema:name': item.offerName || `Energy Offer`,
      },
      'beckn:provider': item.offerProvider,
      'beckn:items': item.offerItems,
      'beckn:price': {
        '@type': 'schema:PriceSpecification',
        'schema:price': item.offerPrice,
        'schema:priceCurrency': item.offerCurrency,
        'schema:unitText': 'kWh',
      },
      'beckn:offerAttributes': item.offerTimeWindow ? {
        '@context': BECKN_ENERGY_TRADE_CONTEXT,
        '@type': 'EnergyTradeOffer',
        pricingModel: 'PER_KWH',
        deliveryWindow: {
          '@type': 'beckn:TimePeriod',
          'schema:startTime': item.offerTimeWindow.startTime,
          'schema:endTime': item.offerTimeWindow.endTime,
        },
      } : undefined,
    },
  }));

  return {
    '@context': BECKN_CORE_CONTEXT,
    '@type': 'beckn:Order',
    'beckn:orderStatus': orderStatus,
    'beckn:seller': opts.sellerId,
    'beckn:buyer': {
      '@context': BECKN_CORE_CONTEXT,
      '@type': 'beckn:Buyer',
      'beckn:id': opts.buyerId,
      'beckn:buyerAttributes': {
        '@context': BECKN_ENERGY_TRADE_CONTEXT,
        '@type': 'EnergyCustomer',
        meterId: opts.buyerMeterId,
        utilityCustomerId: opts.buyerUtilityCustomerId,
        utilityId: opts.buyerUtilityId,
      },
    },
    'beckn:orderAttributes': {
      '@context': BECKN_ENERGY_TRADE_CONTEXT,
      '@type': 'EnergyTradeOrder',
      bap_id: opts.bapId,
      bpp_id: opts.bppId,
      total_quantity: { unitQuantity: totalQuantity, unitText: 'kWh' },
    },
    'beckn:orderItems': wireItems,
  };
}

/**
 * Build a Beckn v2 status message body (minimal — just order id).
 */
export function buildWireStatusOrder(orderId: string): { 'beckn:id': string } {
  return { 'beckn:id': orderId };
}

/**
 * Build an on_confirm / on_init / on_select wire-format response order
 * from an internal order and the original request order.
 */
export function buildWireResponseOrder(
  internalOrder: any,
  requestOrder: WireOrder | null,
  orderId?: string,
): WireOrder {
  // Start from the request order (echo it back) or build fresh
  const wire: WireOrder = requestOrder ? { ...requestOrder } : {
    '@context': BECKN_CORE_CONTEXT,
    '@type': 'beckn:Order',
  };

  // Set order ID if assigned
  if (orderId || internalOrder?.id) {
    wire['beckn:id'] = orderId || internalOrder.id;
  }

  // Update status
  const statusMap: Record<string, string> = {
    DRAFT: 'CREATED',
    PENDING: 'CREATED',
    ACTIVE: 'INPROGRESS',
    COMPLETED: 'COMPLETED',
    CANCELLED: 'CANCELLED',
  };
  wire['beckn:orderStatus'] = statusMap[internalOrder?.status] || internalOrder?.status || 'CREATED';

  return wire;
}

// ===================== Wire → Internal parsers =====================

export interface ParsedSelectItems {
  items: Array<{
    item_id: string;
    offer_id: string;
    quantity: number;
    providerAttributes?: {
      meterId?: string;
      utilityCustomerId?: string;
      utilityId?: string;
    };
  }>;
  sellerId?: string;
  buyerId?: string;
}

/**
 * Parse a Beckn v2 wire-format order into internal select items.
 * Handles both wire format (beckn:orderItems) and internal format (orderItems / order.items).
 */
export function parseWireSelectMessage(messageContent: any): ParsedSelectItems {
  // Wire format: message.order['beckn:orderItems']
  const wireOrder = messageContent.order;
  if (wireOrder && wireOrder['beckn:orderItems']) {
    const wireItems = wireOrder['beckn:orderItems'] as WireOrderItem[];
    return {
      items: wireItems.map(wi => ({
        item_id: wi['beckn:orderedItem'],
        offer_id: wi['beckn:acceptedOffer']?.['beckn:id'] || '',
        quantity: wi['beckn:quantity']?.unitQuantity || 0,
        providerAttributes: wi['beckn:orderItemAttributes']?.providerAttributes,
      })),
      sellerId: wireOrder['beckn:seller'],
      buyerId: wireOrder['beckn:buyer']?.['beckn:id'],
    };
  }

  // Internal format: message.orderItems[]
  if (messageContent.orderItems) {
    return {
      items: messageContent.orderItems.map((oi: any) => ({
        item_id: oi.item_id,
        offer_id: oi.offer_id,
        quantity: oi.quantity,
        providerAttributes: oi['beckn:orderItemAttributes']?.providerAttributes,
      })),
    };
  }

  // Internal format: message.order.items[]
  if (wireOrder?.items) {
    return {
      items: wireOrder.items.map((oi: any) => ({
        item_id: oi.item_id,
        offer_id: oi.offer_id,
        quantity: oi.quantity,
        providerAttributes: oi['beckn:orderItemAttributes']?.providerAttributes,
      })),
      sellerId: wireOrder.provider?.id,
    };
  }

  return { items: [] };
}

/**
 * Parse a Beckn v2 wire-format status message to get order ID.
 */
export function parseWireStatusMessage(messageContent: any): string {
  // Wire format: message.order['beckn:id']
  if (messageContent.order?.['beckn:id']) {
    return messageContent.order['beckn:id'];
  }
  // Internal format: message.order_id or message.order.id
  return messageContent.order_id || messageContent.order?.id || '';
}

/**
 * Parse a Beckn v2 wire-format confirm message to get order ID.
 */
export function parseWireConfirmMessage(messageContent: any): string {
  // Wire format: message.order['beckn:id']
  if (messageContent.order?.['beckn:id']) {
    return messageContent.order['beckn:id'];
  }
  // Internal format: message.order.id
  return messageContent.order?.id || '';
}

/**
 * Parse a Beckn v2 on_select/on_init/on_confirm response to extract internal order data.
 * Returns data usable by our internal state management.
 */
export function parseWireOrderResponse(messageContent: any): {
  orderId?: string;
  status?: string;
  items?: any[];
  quote?: any;
  providerId?: string;
  providerName?: string;
} {
  const order = messageContent.order;
  if (!order) return {};

  // Wire format
  if (order['beckn:orderItems'] || order['beckn:id'] || order['beckn:orderStatus']) {
    const wireItems = order['beckn:orderItems'] as WireOrderItem[] | undefined;
    const totalQty = wireItems?.reduce((sum: number, wi: WireOrderItem) =>
      sum + (wi['beckn:quantity']?.unitQuantity || 0), 0) || 0;

    // Calculate total price from accepted offers
    let totalPrice = 0;
    let currency = 'INR';
    if (wireItems) {
      for (const wi of wireItems) {
        const offerPrice = wi['beckn:acceptedOffer']?.['beckn:price']?.['schema:price'] || 0;
        const qty = wi['beckn:quantity']?.unitQuantity || 0;
        totalPrice += offerPrice * qty;
        currency = wi['beckn:acceptedOffer']?.['beckn:price']?.['schema:priceCurrency'] || currency;
      }
    }

    return {
      orderId: order['beckn:id'],
      status: order['beckn:orderStatus'],
      items: wireItems?.map(wi => ({
        item_id: wi['beckn:orderedItem'],
        offer_id: wi['beckn:acceptedOffer']?.['beckn:id'] || '',
        quantity: wi['beckn:quantity']?.unitQuantity || 0,
        provider_id: order['beckn:seller'] || wi['beckn:acceptedOffer']?.['beckn:provider'] || '',
        price: {
          value: (wi['beckn:acceptedOffer']?.['beckn:price']?.['schema:price'] || 0) * (wi['beckn:quantity']?.unitQuantity || 0),
          currency,
        },
      })),
      quote: {
        price: { value: totalPrice, currency },
        totalQuantity: totalQty,
      },
      providerId: order['beckn:seller'],
    };
  }

  // Internal format — pass through
  return {
    orderId: order.id,
    status: order.status,
    items: order.items,
    quote: order.quote,
    providerId: order.provider?.id,
    providerName: order.provider?.descriptor?.name,
  };
}
