/**
 * CDS Sync Client - Beckn Protocol Catalog Publishing
 *
 * Publishes catalog data to external CDS using the Beckn protocol
 * catalog_publish action format.
 *
 * Based on the BPP-DEG Postman collection format:
 * - POST /publish endpoint
 * - action: "catalog_publish"
 * - Full Beckn v2 catalog structure
 */

import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { config } from '../config';
import { createLogger } from '../utils/logger';
import { TimeWindow } from '../types/beckn';
import { secureAxiosBpp } from '../beckn/secure-client';

const logger = createLogger('CDS-PUBLISH');

// ==================== Constants ====================

const BECKN_CORE_CONTEXT = 'https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/core/v2/context.jsonld';
const BECKN_ENERGY_TRADE_CONTEXT = 'https://raw.githubusercontent.com/beckn/protocol-specifications-v2/refs/heads/p2p-trading/schema/EnergyTrade/v0.3/context.jsonld';
const BECKN_DOMAIN = process.env.BECKN_DOMAIN || 'beckn.one:deg:p2p-trading-interdiscom:2.0.0';
const BECKN_VERSION = '2.0.0';

// ==================== Type Definitions ====================

export interface SyncProvider {
  id: string;
  name: string;
  trust_score?: number;
}

export interface SyncItem {
  id: string;
  provider_id: string;
  source_type: string;
  delivery_mode: string;
  available_qty: number;
  production_windows: TimeWindow[];
  meter_id: string;
  // Provider utility attributes (for CDS filtering by utility)
  utility_id?: string;
  utility_customer_id?: string;
}

export interface SyncOffer {
  id: string;
  item_id: string;
  provider_id: string;
  price_value: number;
  currency: string;
  max_qty: number;
  time_window: TimeWindow;
  pricing_model?: string;
  settlement_type?: string;
}

export interface SyncBlocks {
  offer_id: string;
  block_ids: string[];
  status: 'AVAILABLE' | 'RESERVED' | 'SOLD';
  order_id?: string;
  transaction_id?: string;
}

// ==================== Beckn Catalog Types ====================

interface BecknDescriptor {
  '@type': string;
  'schema:name': string;
  'beckn:shortDesc'?: string;
  'beckn:longDesc'?: string;
}

interface BecknItemAttributes {
  '@context': string;
  '@type': string;
  sourceType: string;
  meterId: string;
  availableQuantity?: number;  // Required for CDS filtering
}

interface BecknItem {
  '@context': string;
  '@type': string;
  'beckn:networkId': string[];
  'beckn:isActive': boolean;
  'beckn:id': string;
  'beckn:descriptor': BecknDescriptor;
  'beckn:provider': {
    'beckn:id': string;
    'beckn:descriptor': BecknDescriptor;
    'beckn:providerAttributes'?: {
      '@context': string;
      '@type': string;
      meterId: string;
      utilityId: string;
      utilityCustomerId: string;
    };
  };
  'beckn:itemAttributes': BecknItemAttributes;
}

interface BecknOfferAttributes {
  '@context': string;
  '@type': string;
  pricingModel: string;
  deliveryWindow?: {
    '@type': string;
    'schema:startTime': string;
    'schema:endTime': string;
  };
  validityWindow?: {
    '@type': string;
    'schema:startTime': string;
    'schema:endTime': string;
  };
}

interface BecknOffer {
  '@context': string;
  '@type': string;
  'beckn:id': string;
  'beckn:descriptor': BecknDescriptor;
  'beckn:provider': string;
  'beckn:items': string[];
  'beckn:price': {
    '@type': string;
    'schema:price': number;
    'schema:priceCurrency': string;
    unitText: string;  // No 'schema:' prefix per Postman spec
    applicableQuantity?: {
      unitQuantity: number;
      unitText: string;
    };
  };
  'beckn:offerAttributes': BecknOfferAttributes;
}

interface BecknCatalog {
  '@context': string;
  '@type': string;
  'beckn:id': string;
  'beckn:descriptor': BecknDescriptor;
  'beckn:bppId': string;
  'beckn:bppUri': string;
  'beckn:isActive'?: boolean;
  'beckn:items': BecknItem[];
  'beckn:offers': BecknOffer[];
}

interface CatalogPublishContext {
  domain: string;
  version: string;
  action: 'catalog_publish';
  timestamp: string;
  message_id: string;
  transaction_id: string;
  bap_id: string;
  bap_uri: string;
  bpp_id: string;
  bpp_uri: string;
  ttl: string;
  // NOTE: Do NOT include 'location' or 'schema_context' - CDS will not index catalogs with these fields
}

interface CatalogPublishMessage {
  context: CatalogPublishContext;
  message: {
    catalogs: BecknCatalog[];
  };
}

// ==================== Configuration ====================

/**
 * CDS is always enabled - no toggle needed
 * @deprecated This function always returns true. CDS publishing is unconditional.
 */
export function isExternalCDSEnabled(): boolean {
  return true;
}

/**
 * Get the CDS base URL for publishing
 * Returns the URL with /catalog appended if not already present
 */
function getCDSPublishUrl(): string {
  // Use EXTERNAL_CDS_URL for publishing, or fall back to CDS_URL
  const baseUrl = process.env.EXTERNAL_CDS_URL || process.env.CDS_URL || config.external.cds;

  // If URL already ends with /catalog, just append /publish
  // Otherwise append /catalog/publish
  if (baseUrl.endsWith('/catalog')) {
    return `${baseUrl}/publish`;
  }
  return `${baseUrl}/catalog/publish`;
}

// ==================== Catalog Building Functions ====================

/**
 * Build a Beckn-compliant item from internal data
 */
function buildBecknItem(item: SyncItem, providerName: string): BecknItem {
  return {
    '@context': BECKN_CORE_CONTEXT,
    '@type': 'beckn:Item',
    'beckn:networkId': ['p2p-interdiscom-trading-pilot-network'],
    'beckn:isActive': true,
    'beckn:id': item.id,
    'beckn:descriptor': {
      '@type': 'beckn:Descriptor',
      'schema:name': `${item.source_type} Energy - ${item.available_qty} kWh`,
      'beckn:shortDesc': `${item.source_type} energy available for trading`,
    },
    'beckn:provider': {
      'beckn:id': item.provider_id,
      'beckn:descriptor': {
        '@type': 'beckn:Descriptor',
        'schema:name': providerName,
      },
      // Per Postman spec: providerAttributes with utility info for CDS filtering
      'beckn:providerAttributes': {
        '@context': BECKN_ENERGY_TRADE_CONTEXT,
        '@type': 'EnergyCustomer',
        meterId: item.meter_id || `der://meter/${item.id}`,
        utilityId: item.utility_id || 'UNKNOWN',
        utilityCustomerId: item.utility_customer_id || 'UNKNOWN',
      },
    },
    'beckn:itemAttributes': {
      '@context': BECKN_ENERGY_TRADE_CONTEXT,
      '@type': 'EnergyResource',
      sourceType: item.source_type,
      meterId: item.meter_id || `der://meter/${item.id}`,
      // Note: Do NOT include availableQuantity here - CDS manages this field internally
    },
  };
}

/**
 * Build a Beckn-compliant offer from internal data
 * Schema matches BPP-DEG publish-catalog format from Postman:
 * - beckn:price at root level with schema:PriceSpecification format
 * - beckn:offerAttributes with validityWindow, minimumQuantity, maximumQuantity
 */
function buildBecknOffer(offer: SyncOffer, _meterId?: string): BecknOffer {
  return {
    '@context': BECKN_CORE_CONTEXT,
    '@type': 'beckn:Offer',
    'beckn:id': offer.id,
    'beckn:descriptor': {
      '@type': 'beckn:Descriptor',
      'schema:name': `Energy Offer - ${offer.max_qty} kWh`,
    },
    'beckn:provider': offer.provider_id,
    'beckn:items': [offer.item_id],
    'beckn:price': {
      '@type': 'schema:PriceSpecification',
      'schema:price': offer.price_value,
      'schema:priceCurrency': offer.currency || 'INR',
      unitText: 'kWh',  // No 'schema:' prefix per Postman spec
      applicableQuantity: {
        unitQuantity: offer.max_qty,
        unitText: 'kWh',
      },
    },
    'beckn:offerAttributes': {
      '@context': BECKN_ENERGY_TRADE_CONTEXT,
      '@type': 'EnergyTradeOffer',
      pricingModel: offer.pricing_model || 'PER_KWH',
      deliveryWindow: offer.time_window ? {
        '@type': 'beckn:TimePeriod',
        'schema:startTime': offer.time_window.startTime,
        'schema:endTime': offer.time_window.endTime,
      } : undefined,
      validityWindow: offer.time_window ? {
        '@type': 'beckn:TimePeriod',
        'schema:startTime': offer.time_window.startTime,
        'schema:endTime': offer.time_window.endTime,
      } : undefined,
    },
  };
}

/**
 * Create the Beckn publish context
 */
function createPublishContext(transactionId?: string): CatalogPublishContext {
  // NOTE: Do NOT include 'location' or 'schema_context' - CDS will not index catalogs with these fields
  return {
    domain: BECKN_DOMAIN,
    version: BECKN_VERSION,
    action: 'catalog_publish',
    timestamp: new Date().toISOString(),
    message_id: uuidv4(),
    transaction_id: transactionId || uuidv4(),
    bap_id: config.bap.id,
    bap_uri: config.bap.uri,
    bpp_id: config.bpp.id,
    bpp_uri: config.bpp.uri,
    ttl: 'PT30S',
  };
}

// ==================== Main Publish Functions ====================

/**
 * Publish a complete catalog to external CDS
 * This is the main function that creates the proper Beckn catalog_publish request
 */
export async function publishCatalogToCDS(
  provider: SyncProvider,
  items: SyncItem[],
  offers: SyncOffer[],
  isActive: boolean = true
): Promise<boolean> {
  try {
    // Build catalog ID based on provider
    const catalogId = `catalog-${provider.id}`;

    // Build Beckn items
    const becknItems = items.map(item => buildBecknItem(item, provider.name));

    // Build Beckn offers with meter IDs from their corresponding items
    const becknOffers = offers.map(offer => {
      const item = items.find(i => i.id === offer.item_id);
      return buildBecknOffer(offer, item?.meter_id);
    });

    // Build the catalog
    const catalog: BecknCatalog = {
      '@context': BECKN_CORE_CONTEXT,
      '@type': 'beckn:Catalog',
      'beckn:id': catalogId,
      'beckn:descriptor': {
        '@type': 'beckn:Descriptor',
        'schema:name': `${provider.name} Energy Trading Catalog`,
      },
      'beckn:bppId': config.bpp.id,
      'beckn:bppUri': config.bpp.uri,
      'beckn:isActive': isActive,
      'beckn:items': becknItems,
      'beckn:offers': becknOffers,
    };

    // Build the full publish message
    const publishMessage: CatalogPublishMessage = {
      context: createPublishContext(),
      message: {
        catalogs: [catalog],
      },
    };

    const url = getCDSPublishUrl();
    const offerIds = offers.map(o => o.id).join(', ');

    // Use secureAxiosBpp for CDS publish (BPP keys for catalog_publish)
    const response = await secureAxiosBpp.post(url, publishMessage, {
      timeout: 30000, // 30 second timeout
    });

    // Check for NACK response
    if (response.data?.ack_status === 'NACK') {
      logger.error('CDS returned NACK for catalog publish', {
        providerId: provider.id,
        error: response.data?.error,
      });
      return false;
    }

    logger.info(`publish: ${offerIds}`);

    return true;
  } catch (error: any) {
    const errorDetails = {
      providerId: provider.id,
      error: error.message,
      code: error.code,
      status: error.response?.status,
      statusText: error.response?.statusText,
      responseData: error.response?.data ? JSON.stringify(error.response.data).substring(0, 1000) : 'no response data',
      url: getCDSPublishUrl(),
    };
    logger.error('Failed to publish catalog to CDS: ' + JSON.stringify(errorDetails));
    console.error('[CDS-PUBLISH-ERROR]', errorDetails);
    return false;
  }
}

/**
 * Publish a single offer to CDS (convenience wrapper)
 * Creates a minimal catalog with just the one offer and its item
 */
export async function publishOfferToCDS(
  provider: SyncProvider,
  item: SyncItem,
  offer: SyncOffer
): Promise<boolean> {
  return publishCatalogToCDS(provider, [item], [offer], true);
}

/**
 * Revoke/deactivate a catalog on CDS
 * Publishes with isActive: false to mark the catalog as inactive
 */
export async function revokeCatalogFromCDS(
  provider: SyncProvider,
  items: SyncItem[],
  offers: SyncOffer[]
): Promise<boolean> {
  return publishCatalogToCDS(provider, items, offers, false);
}

// ==================== Legacy Sync Functions (for backward compatibility) ====================
// These functions now use the new publishCatalogToCDS internally

/**
 * Sync provider information to external CDS
 * @deprecated Use publishCatalogToCDS instead
 */
export async function syncProviderToCDS(provider: SyncProvider): Promise<boolean> {
  // For provider-only sync, we just log - real sync happens with publishCatalogToCDS
  logger.info('Provider registered (will sync with catalog)', {
    providerId: provider.id,
    name: provider.name,
  });
  return true;
}

/**
 * Sync catalog item to external CDS
 * @deprecated Use publishCatalogToCDS instead
 */
export async function syncItemToCDS(item: SyncItem): Promise<boolean> {
  // For item-only sync, we just log - real sync happens with publishCatalogToCDS
  logger.info('Item registered (will sync with catalog)', {
    itemId: item.id,
    providerId: item.provider_id,
  });
  return true;
}

/**
 * Sync offer to external CDS
 * This is the main function called when offers are created
 */
export async function syncOfferToCDS(offer: SyncOffer): Promise<boolean> {
  try {
    // To sync a single offer, we need provider and item info
    // Build minimal catalog with just this offer
    const provider: SyncProvider = {
      id: offer.provider_id,
      name: `Provider ${offer.provider_id}`, // Will be updated with real name in seller-routes
    };

    const item: SyncItem = {
      id: offer.item_id,
      provider_id: offer.provider_id,
      source_type: 'SOLAR', // Default, will be updated with real type
      delivery_mode: 'GRID_INJECTION',
      available_qty: offer.max_qty,
      production_windows: offer.time_window ? [offer.time_window] : [],
      meter_id: `der://meter/${offer.item_id}`,
    };

    return await publishOfferToCDS(provider, item, offer);
  } catch (error: any) {
    logger.error('Failed to sync offer to CDS', {
      offerId: offer.id,
      error: error.message,
    });
    return false;
  }
}

/**
 * Delete offer from external CDS
 * Publishes the catalog with the offer removed
 */
export async function deleteOfferFromCDS(offerId: string): Promise<boolean> {
  // Note: The Beckn protocol doesn't have a direct "delete" operation
  // We need to republish the catalog without the deleted offer
  // This requires fetching current catalog state from the database
  // For now, log the deletion - the caller should republish the full catalog
  logger.info('Offer deletion noted (caller should republish catalog)', { offerId });
  return true;
}

/**
 * Sync block status updates to external CDS
 * Block status changes are reflected in availableQuantity updates
 */
export async function syncBlocksToCDS(blocks: SyncBlocks): Promise<boolean> {
  // Block status updates affect the availableQuantity in the catalog
  // The caller should republish the catalog with updated quantities
  logger.info('Block status changed (caller should republish catalog)', {
    offerId: blocks.offer_id,
    blockCount: blocks.block_ids.length,
    status: blocks.status,
  });
  return true;
}

/**
 * Sync a complete offer (provider + item + offer) to CDS
 * This is the preferred method for syncing new offers
 */
export async function syncCompleteOfferToCDS(
  provider: SyncProvider,
  item: SyncItem,
  offer: SyncOffer
): Promise<{ success: boolean; failedSteps: string[] }> {
  const failedSteps: string[] = [];

  const success = await publishOfferToCDS(provider, item, offer);

  if (!success) {
    failedSteps.push('catalog_publish');
  }

  if (success) {
    logger.info('Complete offer synced to CDS', {
      providerId: provider.id,
      itemId: item.id,
      offerId: offer.id
    });
  } else {
    logger.warn('Failed to sync offer to CDS', {
      offerId: offer.id,
      failedSteps
    });
  }

  return { success, failedSteps };
}
