/**
 * BAP Routes - Consumer-side APIs for initiating flows
 */

import { Router, Request, Response } from 'express';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import {
  DiscoverMessage,
  SelectMessage,
  InitMessage,
  ConfirmMessage,
  StatusMessage,
  createContext,
  createLogger,
  config,
  matchOffers,
  MatchingCriteria,
  TimeWindow,
  SourceType,
  DeliveryMode,
  CatalogOffer,
  Provider,
  // VC imports
  VerifiableCredential,
  VerificationOptions,
  verifyCredential,
  parseAndVerifyCredential,
  verifyGenerationProfile,
  getIssuerId,
  validateProviderMatch,
  // Secure client for signed Beckn requests
  secureAxios,
  getKeyPair,
  createSignedHeaders,
  // Beckn v2 wire-format builders
  buildWireOrder,
  buildWireStatusOrder,
  BuildSelectOrderOptions,
  // Bulk matcher
  selectOffersForBulk,
  formatBulkSelectionResponse,
  // Trade rules
  validateQuantity,
  roundQuantity,
  snapTimeWindow,
  checkTradeWindow,
} from '@p2p/shared';
import { logEvent } from './events';
import { createTransaction, getTransaction, updateTransaction, getAllTransactions, clearAllTransactions } from './state';
import { optionalAuthMiddleware, authMiddleware } from './middleware/auth';
import { prisma } from '@p2p/shared';
import { getAvailableBlockCount, getOfferById } from './seller-catalog';

const router = Router();
const logger = createLogger('BAP');

/**
 * Transform external CDS catalog format (beckn: prefixed) to our internal format
 * External format uses:
 * - catalogs[] instead of catalog.providers[]
 * - beckn:id, beckn:items, beckn:offers with beckn: prefix
 * - offers at catalog level instead of nested in items
 * - Various price formats: beckn:price, schema:price, etc.
 */
function transformExternalCatalogFormat(rawMessage: any): { providers: any[] } {
  // Check if it's already in our internal format
  if (rawMessage.catalog?.providers) {
    return rawMessage.catalog;
  }

  // Check for external format with catalogs array
  const catalogs = rawMessage.catalogs || rawMessage.message?.catalogs || [];

  if (!catalogs.length) {
    logger.debug('No catalogs found in response');
    return { providers: [] };
  }

  const providers: any[] = [];

  for (const catalog of catalogs) {
    const providerId = catalog['beckn:providerId'] || catalog.providerId || catalog['beckn:id'] || catalog.id;

    // IMPORTANT: Extract BPP routing info for proper Beckn flows
    const bppId = catalog['beckn:bppId'] || catalog.bppId || providerId;
    const bppUri = catalog['beckn:bppUri'] || catalog.bppUri || null;

    const rawItems = catalog['beckn:items'] || catalog.items || [];

    // Extract provider name from items if available (where actual seller name is stored)
    // Fall back to catalog descriptor or BPP ID
    let providerName = 'Unknown Provider';
    if (rawItems.length > 0) {
      const firstItem = rawItems[0];
      const itemProvider = firstItem['beckn:provider'] || firstItem.provider || {};
      const itemProviderDescriptor = itemProvider['beckn:descriptor'] || itemProvider.descriptor || {};
      providerName = itemProviderDescriptor['schema:name'] || itemProviderDescriptor.name || providerName;
    }
    // Fall back to catalog descriptor if no item provider name
    if (providerName === 'Unknown Provider') {
      providerName = catalog['beckn:descriptor']?.['schema:name'] ||
        catalog.descriptor?.name ||
        catalog['beckn:bppId'] ||
        'Unknown Provider';
    }
    const catalogOffers = catalog['beckn:offers'] || catalog.offers || [];


    const transformedItems: any[] = [];

    // Helper function to extract offer data
    const extractOfferData = (offer: any, itemId: string, itemAttrs: any = {}) => {
      const offerId = offer['beckn:id'] || offer.id;
      const offerAttrs = offer['beckn:offerAttributes'] || offer.offerAttributes || {};

      // Extract price from multiple possible formats:
      // 1. offer['beckn:price']['schema:price'] (new format at root)
      // 2. offerAttrs['beckn:price']['value'] (old format inside offerAttributes)
      // 3. offerAttrs.price (simplified format)
      const offerPrice = offer['beckn:price'] || {};
      const attrPrice = offerAttrs['beckn:price'] || offerAttrs.price || {};
      const priceValue = attrPrice.value ?? offerPrice['schema:price'] ?? attrPrice['schema:price'] ?? offerPrice.value ?? 0;
      const priceCurrency = attrPrice.currency || offerPrice['schema:priceCurrency'] || attrPrice['schema:priceCurrency'] || offerPrice.currency || 'INR';

      // Extract time window from multiple possible locations
      const timeWindow = offerAttrs['beckn:timeWindow'] || offerAttrs.timeWindow || offerAttrs.validityWindow || {};
      const startTime = timeWindow['schema:startTime'] || timeWindow.startTime || null;
      const endTime = timeWindow['schema:endTime'] || timeWindow.endTime || null;

      // Extract max quantity from multiple possible formats
      // CDS may use: beckn:maxQuantity, maxQuantity, applicableQuantity (in offerAttrs or price)
      // Also check price.applicableQuantity which is where we publish it
      const priceApplicableQty = offerPrice.applicableQuantity || offerPrice['schema:applicableQuantity'] || {};
      const maxQty = offerAttrs['beckn:maxQuantity'] || offerAttrs.maxQuantity ||
                     offerAttrs.applicableQuantity || offerAttrs['beckn:applicableQuantity'] || priceApplicableQty || {};
      const maxQuantity = maxQty.unitQuantity || maxQty.value || (typeof maxQty === 'number' ? maxQty : null) ||
                         priceApplicableQty.unitQuantity || offerAttrs.maximumQuantity || itemAttrs.availableQuantity || 100;

      return {
        id: offerId,
        item_id: itemId,
        provider_id: providerId,
        // BPP routing info for proper Beckn flow
        bpp_id: bppId,
        bpp_uri: bppUri,
        price: {
          value: typeof priceValue === 'number' ? priceValue : parseFloat(priceValue) || 0,
          currency: priceCurrency,
        },
        maxQuantity: typeof maxQuantity === 'number' ? maxQuantity : parseFloat(maxQuantity) || 100,
        timeWindow: startTime && endTime ? {
          startTime,
          endTime,
        } : null,
      };
    };

    // Process items if they exist
    if (rawItems.length > 0) {
      for (const item of rawItems) {
        const itemId = item['beckn:id'] || item.id;
        const itemAttrs = item['beckn:itemAttributes'] || item.itemAttributes || {};

        const itemOffers: any[] = [];

        for (const offer of catalogOffers) {
          const offerItems = offer['beckn:items'] || offer.items || [];

          if (offerItems.includes(itemId) || offerItems.length === 0) {
            itemOffers.push(extractOfferData(offer, itemId, itemAttrs));
          }
        }

        transformedItems.push({
          id: itemId,
          offers: itemOffers,
          itemAttributes: {
            sourceType: itemAttrs.sourceType || 'MIXED',
            availableQuantity: itemAttrs.availableQuantity || 100,
            deliveryMode: itemAttrs.deliveryMode || 'GRID_INJECTION',
            meterId: itemAttrs.meterId,
          },
        });
      }
    } else if (catalogOffers.length > 0) {
      // FALLBACK: If no items but offers exist, extract offers with their referenced item IDs
      // This handles cases where CDS returns offers without explicit items array
      logger.debug('No items found but offers exist', {
        providerId,
        offerCount: catalogOffers.length,
      });

      // Group offers by their item references
      const offersByItem = new Map<string, any[]>();

      for (const offer of catalogOffers) {
        const offerItemIds = offer['beckn:items'] || offer.items || [];
        // Use first item ID or generate a synthetic one
        const itemId = offerItemIds[0] || `synthetic-item-${providerId}`;

        if (!offersByItem.has(itemId)) {
          offersByItem.set(itemId, []);
        }
        offersByItem.get(itemId)!.push(extractOfferData(offer, itemId, {}));
      }

      // Create items from grouped offers
      for (const [itemId, offers] of offersByItem) {
        transformedItems.push({
          id: itemId,
          offers,
          itemAttributes: {
            sourceType: 'MIXED',
            availableQuantity: 100,
            deliveryMode: 'GRID_INJECTION',
          },
        });
      }
    }

    providers.push({
      id: providerId,
      descriptor: { name: providerName },
      // BPP routing info at provider level
      bpp_id: bppId,
      bpp_uri: bppUri,
      items: transformedItems,
    });
  }

  // Count total offers
  const totalOffers = providers.reduce((sum, p) =>
    sum + p.items.reduce((iSum: number, i: any) => iSum + (i.offers?.length || 0), 0), 0);

  logger.debug(`Transformed ${catalogs.length} catalogs into ${providers.length} providers`, {
    totalOffers,
    providerDetails: providers.map(p => ({
      id: p.id,
      itemCount: p.items.length,
      offerCount: p.items.reduce((sum: number, i: any) => sum + (i.offers?.length || 0), 0),
    })),
  });
  return { providers };
}

/**
 * Check if two time windows overlap
 * Used for client-side filtering of offers by requested time window
 */
function timeWindowsOverlap(offerWindow: TimeWindow | null | undefined, requestedWindow: TimeWindow | null | undefined): boolean {
  // If no requested window, all offers match
  if (!requestedWindow || !requestedWindow.startTime || !requestedWindow.endTime) {
    return true;
  }

  // If offer has no time window, it's considered always available (matches any window)
  if (!offerWindow || !offerWindow.startTime || !offerWindow.endTime) {
    return true;
  }

  const offerStart = new Date(offerWindow.startTime).getTime();
  const offerEnd = new Date(offerWindow.endTime).getTime();
  const requestStart = new Date(requestedWindow.startTime).getTime();
  const requestEnd = new Date(requestedWindow.endTime).getTime();

  // Check for overlap: offer window must intersect with requested window
  // Two windows overlap if one starts before the other ends AND ends after the other starts
  return offerStart < requestEnd && offerEnd > requestStart;
}

/**
 * Filter catalog providers to only include offers that match the requested time window
 */
function filterCatalogByTimeWindow(catalog: { providers: any[] }, requestedWindow: TimeWindow | null | undefined): { providers: any[] } {
  if (!requestedWindow) {
    return catalog; // No filtering needed
  }

  const filteredProviders = catalog.providers.map(provider => {
    const filteredItems = provider.items.map((item: any) => {
      const filteredOffers = (item.offers || []).filter((offer: any) =>
        timeWindowsOverlap(offer.timeWindow, requestedWindow)
      );
      return { ...item, offers: filteredOffers };
    }).filter((item: any) => item.offers && item.offers.length > 0); // Remove items with no matching offers

    return { ...provider, items: filteredItems };
  }).filter(provider => provider.items.length > 0); // Remove providers with no matching items

  return { providers: filteredProviders };
}

const ESCROW_ACCOUNT = {
  bankName: 'Example Bank',
  accountName: 'P2P Energy Escrow',
  accountNumber: '001234567890',
  ifsc: 'EXMP0001234',
  branch: 'Powai, Mumbai',
};

const DEFAULT_ESCROW_DURATION_SEC = 30 * 60;

// ==================== DEMO ACCOUNTS ====================
// In-memory demo accounts with balances for visualization

type DemoAccount = {
  id: string;
  name: string;
  type: 'buyer' | 'seller' | 'escrow' | 'platform';
  balance: number;
  currency: string;
};

type DemoTransaction = {
  id: string;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  amount: number;
  description: string;
  timestamp: string;
};

const INITIAL_BALANCES = {
  buyer: 10000,    // ₹10,000
  seller: 5000,    // ₹5,000
  escrow: 0,       // ₹0 (starts empty)
  platform: 0,     // ₹0 (fees collected)
};

let demoAccounts: Map<string, DemoAccount> = new Map();
let demoTransactions: DemoTransaction[] = [];

function initializeDemoAccounts(): void {
  demoAccounts = new Map([
    ['buyer', { id: 'buyer', name: 'Rahul Kumar (Buyer)', type: 'buyer', balance: INITIAL_BALANCES.buyer, currency: 'INR' }],
    ['seller', { id: 'seller', name: 'SunPower Energy (Seller)', type: 'seller', balance: INITIAL_BALANCES.seller, currency: 'INR' }],
    ['escrow', { id: 'escrow', name: 'P2P Escrow Account', type: 'escrow', balance: INITIAL_BALANCES.escrow, currency: 'INR' }],
    ['platform', { id: 'platform', name: 'Platform Fees', type: 'platform', balance: INITIAL_BALANCES.platform, currency: 'INR' }],
  ]);
  demoTransactions = []; // Clear transaction history
  logger.info('Demo accounts initialized', {
    buyer: INITIAL_BALANCES.buyer,
    seller: INITIAL_BALANCES.seller,
    escrow: INITIAL_BALANCES.escrow,
  });
}

// Initialize on module load
initializeDemoAccounts();

function getDemoAccount(id: string): DemoAccount | undefined {
  return demoAccounts.get(id);
}

function getAllDemoAccounts(): DemoAccount[] {
  return Array.from(demoAccounts.values());
}

function getAllDemoTransactions(): DemoTransaction[] {
  return demoTransactions;
}

function updateDemoBalance(id: string, delta: number): void {
  const account = demoAccounts.get(id);
  if (account) {
    account.balance = roundMoney(account.balance + delta);
    logger.info(`[BALANCE] ${account.name}: ${delta >= 0 ? '+' : ''}₹${delta.toFixed(2)} = ₹${account.balance.toFixed(2)}`);
  }
}

function transferMoney(fromId: string, toId: string, amount: number, description: string): boolean {
  const from = demoAccounts.get(fromId);
  const to = demoAccounts.get(toId);

  if (!from || !to) {
    logger.error(`Transfer failed: account not found (from=${fromId}, to=${toId})`);
    return false;
  }

  if (from.balance < amount) {
    logger.error(`Transfer failed: insufficient balance (${from.name} has ₹${from.balance}, needs ₹${amount})`);
    return false;
  }

  from.balance = roundMoney(from.balance - amount);
  to.balance = roundMoney(to.balance + amount);

  // Record the transaction
  const tx: DemoTransaction = {
    id: `tx-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    fromId,
    fromName: from.name.split(' (')[0], // Short name
    toId,
    toName: to.name.split(' (')[0],
    amount: roundMoney(amount),
    description,
    timestamp: new Date().toISOString(),
  };
  demoTransactions.unshift(tx); // Add to beginning (newest first)

  // Keep only last 20 transactions
  if (demoTransactions.length > 20) {
    demoTransactions = demoTransactions.slice(0, 20);
  }

  logger.info(`[TRANSFER] ${description}: ₹${amount.toFixed(2)} | ${from.name} (₹${from.balance.toFixed(2)}) → ${to.name} (₹${to.balance.toFixed(2)})`);
  return true;
}

type SettlementStatus =
  | 'INITIATED'
  | 'FUNDED'
  | 'RELEASED'
  | 'REFUNDED'
  | 'ERROR_NO_RECORD'
  | 'ERROR_EXPIRED'
  | 'ERROR_ALREADY_SETTLED';

type SettlementOutcome = 'SUCCESS' | 'FAIL';

type SettlementRecord = {
  tradeId: string;
  orderId: string | null;
  transactionId: string | null;
  buyerId: string | null;
  sellerId: string | null;
  principal: number;
  fee: number;
  total: number;
  expiresAt: string;
  status: SettlementStatus;
  verificationOutcome: SettlementOutcome | null;
  fundedReceipt: string | null;
  payoutReceipt: string | null;
  fundedAt: string | null;
  verifiedAt: string | null;
  payoutAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function computeFee(principal: number): number {
  return roundMoney(Math.min(20, principal * 0.0003));
}

function nowIso(): string {
  return new Date().toISOString();
}

function toRecord(row: any): SettlementRecord {
  return {
    tradeId: row.tradeId,
    orderId: row.orderId ?? null,
    transactionId: row.transactionId ?? null,
    buyerId: row.buyerId ?? null,
    sellerId: row.sellerId ?? null,
    principal: Number(row.principal ?? 0),
    fee: Number(row.fee ?? 0),
    total: Number(row.total ?? 0),
    expiresAt: row.expiresAt,
    status: row.status,
    verificationOutcome: row.verificationOutcome ?? null,
    fundedReceipt: row.fundedReceipt ?? null,
    payoutReceipt: row.payoutReceipt ?? null,
    fundedAt: row.fundedAt ?? null,
    verifiedAt: row.verifiedAt ?? null,
    payoutAt: row.payoutAt ?? null,
    createdAt: row.createdAt?.toISOString?.() ?? row.createdAt ?? null,
    updatedAt: row.updatedAt?.toISOString?.() ?? row.updatedAt ?? null,
  };
}

async function getSettlementRecord(tradeId: string): Promise<SettlementRecord | null> {
  const record = await prisma.settlementRecord.findUnique({
    where: { tradeId },
  });
  return record ? toRecord(record) : null;
}

async function insertSettlementRecord(record: SettlementRecord): Promise<void> {
  await prisma.settlementRecord.create({
    data: {
      tradeId: record.tradeId,
      orderId: record.orderId,
      transactionId: record.transactionId,
      buyerId: record.buyerId,
      sellerId: record.sellerId,
      principal: record.principal,
      fee: record.fee,
      total: record.total,
      expiresAt: record.expiresAt,
      status: record.status,
      verificationOutcome: record.verificationOutcome,
      fundedReceipt: record.fundedReceipt,
      payoutReceipt: record.payoutReceipt,
      fundedAt: record.fundedAt,
      verifiedAt: record.verifiedAt,
      payoutAt: record.payoutAt,
    },
  });
}

async function updateSettlementRecord(tradeId: string, fields: Partial<SettlementRecord>): Promise<void> {
  const updateData: any = {};

  if (fields.status !== undefined) updateData.status = fields.status;
  if (fields.verificationOutcome !== undefined)
    updateData.verificationOutcome = fields.verificationOutcome;
  if (fields.fundedReceipt !== undefined)
    updateData.fundedReceipt = fields.fundedReceipt;
  if (fields.payoutReceipt !== undefined)
    updateData.payoutReceipt = fields.payoutReceipt;
  if (fields.fundedAt !== undefined) updateData.fundedAt = fields.fundedAt;
  if (fields.verifiedAt !== undefined)
    updateData.verifiedAt = fields.verifiedAt;
  if (fields.payoutAt !== undefined) updateData.payoutAt = fields.payoutAt;
  if (fields.orderId !== undefined) updateData.orderId = fields.orderId;
  if (fields.transactionId !== undefined)
    updateData.transactionId = fields.transactionId;
  if (fields.buyerId !== undefined) updateData.buyerId = fields.buyerId;
  if (fields.sellerId !== undefined) updateData.sellerId = fields.sellerId;
  if (fields.principal !== undefined) updateData.principal = fields.principal;
  if (fields.fee !== undefined) updateData.fee = fields.fee;
  if (fields.total !== undefined) updateData.total = fields.total;
  if (fields.expiresAt !== undefined) updateData.expiresAt = fields.expiresAt;

  if (Object.keys(updateData).length === 0) {
    return;
  }

  await prisma.settlementRecord.update({
    where: { tradeId },
    data: updateData,
  });
}

function buildPaymentSteps(record: SettlementRecord | null) {
  const hasRecord = !!record;
  const funded = record?.status === 'FUNDED' || record?.status === 'RELEASED' || record?.status === 'REFUNDED';
  const settled = record?.status === 'RELEASED' || record?.status === 'REFUNDED';
  const isError = record?.status?.startsWith('ERROR_');
  const outcome = record?.verificationOutcome;
  const isRelease = record?.status === 'RELEASED';
  const isRefund = record?.status === 'REFUNDED';

  const steps = [
    { id: 1, label: 'TE -> Bank: Request to block funds', status: hasRecord ? 'complete' : 'pending', time: record?.createdAt ?? null },
    { id: 2, label: 'Bank (internal): Block funds in buyer account', status: funded ? 'complete' : 'pending', time: record?.fundedAt ?? null },
    { id: 3, label: 'Bank -> TE: Block confirmed', status: funded ? 'complete' : 'pending', time: record?.fundedAt ?? null },
    { id: 4, label: 'Bank -> Buyer: Funds blocked notification', status: funded ? 'complete' : 'pending', time: record?.fundedAt ?? null },
    { id: 5, label: 'TE decides outcome using verification result + timing', status: outcome ? 'complete' : isError ? 'error' : 'pending', detail: outcome ?? (isError ? record?.status : null), time: record?.verifiedAt ?? null },
    { id: 6, label: 'TE -> Bank: Execute settlement instruction', status: outcome ? 'complete' : isError ? 'error' : 'pending', detail: outcome === 'SUCCESS' ? 'RELEASE to seller' : outcome === 'FAIL' ? 'REFUND to buyer' : null },
    { id: 7, label: 'Bank (internal): Unblock & transfer/refund', status: settled ? 'complete' : isError ? 'error' : 'pending', time: record?.payoutAt ?? null },
    { id: 8, label: 'Bank -> Seller: Payment credited', status: isRelease ? 'complete' : isRefund ? 'skipped' : isError ? 'error' : 'pending', time: isRelease ? record?.payoutAt ?? null : null },
    { id: 9, label: 'Bank -> Buyer: Funds released/refunded notification', status: settled ? 'complete' : isError ? 'error' : 'pending', time: record?.payoutAt ?? null },
  ];

  return steps;
}

function buildEscrowInstructions(record: SettlementRecord) {
  return {
    bank: ESCROW_ACCOUNT,
    reference: record.tradeId,
    note: 'Use NEFT/RTGS/IMPS. Reference must match Trade ID.',
  };
}

function buildPayoutInstruction(record: SettlementRecord, outcome: SettlementOutcome | null) {
  if (!outcome) return null;
  const amount = outcome === 'SUCCESS' ? record.principal : record.total;
  return {
    action: outcome === 'SUCCESS' ? 'RELEASE' : 'REFUND',
    amount,
    currency: 'INR',
    note: outcome === 'SUCCESS'
      ? 'Pay seller principal from escrow; fee stays with platform.'
      : 'Refund buyer principal + fee in full.',
  };
}

/**
 * POST /api/discover - Initiate catalog discovery
 * Uses optional auth to filter out user's own offers
 */
router.post('/api/discover', optionalAuthMiddleware, async (req: Request, res: Response) => {
  const {
    sourceType,
    deliveryMode,
    minQuantity,
    timeWindow,
    transaction_id
  } = req.body as {
    sourceType?: SourceType;
    deliveryMode?: DeliveryMode;
    minQuantity?: number;
    timeWindow?: TimeWindow;
    transaction_id?: string;
  };

  const txnId = transaction_id || uuidv4();

  // Trade rules: validate minimum quantity (1 kWh)
  if (minQuantity != null) {
    const qtyErr = validateQuantity(minQuantity);
    if (qtyErr) {
      return res.status(400).json({ success: false, error: qtyErr });
    }
  }

  // Trade rules: snap time window to 1-hour delivery blocks (06:00-18:00)
  let effectiveTimeWindow = timeWindow;
  if (timeWindow?.startTime && timeWindow?.endTime) {
    const startDate = new Date(timeWindow.startTime);
    const endDate = new Date(timeWindow.endTime);
    if (endDate <= startDate) {
      return res.status(400).json({
        success: false,
        error: 'End time must be after start time',
      });
    }
    effectiveTimeWindow = snapTimeWindow(timeWindow.startTime, timeWindow.endTime);

    // Trade rules: gate closure check (T-4h before delivery, T-24h max future)
    const tradeCheck = checkTradeWindow(effectiveTimeWindow.startTime);
    if (!tradeCheck.allowed) {
      return res.status(400).json({ success: false, error: tradeCheck.reason });
    }
  }

  // Get user's provider ID to exclude their own offers
  const excludeProviderId = req.user?.providerId || null;
  // Get user's ID for order association
  const buyerId = req.user?.id || null;

  // Create transaction state with discovery criteria for matching
  await createTransaction(txnId);
  await updateTransaction(txnId, {
    discoveryCriteria: {
      sourceType,
      deliveryMode,
      minQuantity,
      timeWindow: effectiveTimeWindow,
    },
    excludeProviderId, // Store for filtering in callback
    buyerId, // Store buyer ID for order association
  });
  logger.debug('Discovery criteria', {
    sourceType,
    deliveryMode,
    minQuantity,
    timeWindow: effectiveTimeWindow,
  });
  // Build JSONPath filter expression for external CDS
  // Format matches BAP-DEG Postman spec:
  // $[?('p2p-interdiscom-trading-pilot-network' == @.beckn:networkId && @.beckn:itemAttributes.sourceType == 'SOLAR' && ...)]
  // IMPORTANT: External CDS requires networkId filter to identify which network's catalogs to return
  const filterParts: string[] = [];

  // Always include networkId filter (required by CDS per Postman spec)
  filterParts.push(`'p2p-interdiscom-trading-pilot-network' == @.beckn:networkId`);

  if (sourceType) {
    filterParts.push(`@.beckn:itemAttributes.sourceType == '${sourceType}'`);
  }
  if (deliveryMode) {
    filterParts.push(`@.beckn:itemAttributes.deliveryMode == '${deliveryMode}'`);
  }
  // Note: Don't filter by availableQuantity - CDS manages this internally
  // Quantity filtering is done via intent.quantity instead

  // Build JSONPath expression
  const expression = `$[?(${filterParts.join(' && ')})]`;

  // Create context with location for external CDS
  const context = createContext({
    action: 'discover',
    transaction_id: txnId,
    bap_id: config.bap.id,
    bap_uri: config.bap.uri,
  });

  // Build discover message with both filters and intent
  // Filters: JSONPath expression for basic filtering
  // Intent: Time window and quantity for time-based matching
  const discoverMessage = {
    context,
    message: {
      filters: {
        type: 'jsonpath',
        expression,
        expressionType: 'jsonpath',
      },
      intent: effectiveTimeWindow ? {
        fulfillment: {
          time: effectiveTimeWindow,
        },
        quantity: minQuantity ? { value: minQuantity } : undefined,
      } : undefined,
    },
  };

  // Always use external CDS for discovery
  // Get the CDS discover URL from external CDS configuration
  // EXTERNAL_CDS_URL (e.g., .../beckn/catalog) → use .../beckn/discover
  const getCdsDiscoverUrl = () => {
    const externalUrl = process.env.EXTERNAL_CDS_URL || config.external.cds;
    // If URL ends with /catalog, replace with /discover for the discover endpoint
    if (externalUrl.endsWith('/catalog')) {
      return externalUrl.replace(/\/catalog$/, '/discover');
    }
    return `${externalUrl}/discover`;
  };

  const cdsDiscoverUrl = getCdsDiscoverUrl();

  logger.debug('discover', { txnId, url: cdsDiscoverUrl });

  // Log outbound event
  await logEvent(txnId, context.message_id, 'discover', 'OUTBOUND', JSON.stringify(discoverMessage));

  try {
    const response = await secureAxios.post(cdsDiscoverUrl, discoverMessage, { timeout: 8000 });

    // Check if the CDS returned catalog data synchronously in the response
    // External CDS may return data in ack.message.catalogs instead of via callback
    const syncCatalog = response.data?.ack?.message?.catalogs ||
      response.data?.message?.catalogs ||
      response.data?.catalogs;

    let processedCatalog: { providers: any[] } | null = null;

    if (syncCatalog && syncCatalog.length > 0) {
      logger.debug('CDS response', { txnId, catalogs: syncCatalog.length });

      // Transform and store the synchronous catalog response
      const catalog = transformExternalCatalogFormat({ catalogs: syncCatalog });

      // Get the provider ID to exclude (user's own provider)
      const currentTxState = await getTransaction(txnId);
      const excludeProviderId = currentTxState?.excludeProviderId;
      const requestedTimeWindow = currentTxState?.discoveryCriteria?.timeWindow;

      // Filter out user's own provider from catalog
      let filteredProviders = catalog.providers.filter(p => p.id !== excludeProviderId);

      // Apply time window filtering if a time window was requested
      if (requestedTimeWindow) {
        const timeFilteredCatalog = filterCatalogByTimeWindow({ providers: filteredProviders }, requestedTimeWindow);
        filteredProviders = timeFilteredCatalog.providers;
      }

      // Refresh local offer availability from actual block counts
      // This ensures discovery reflects the true current availability, not stale CDS data
      for (const providerCatalog of filteredProviders) {
        for (const item of providerCatalog.items || []) {
          for (const offer of item.offers || []) {
            // Check if this is a local offer (exists in our database)
            const localOffer = await getOfferById(offer.id);
            if (localOffer) {
              // Get real-time block availability
              const availableBlocks = await getAvailableBlockCount(offer.id);
              offer.maxQuantity = availableBlocks;

            }
          }
          // Filter out offers with 0 availability
          item.offers = (item.offers || []).filter((o: any) => o.maxQuantity > 0);
        }
        // Filter out items with no offers
        providerCatalog.items = (providerCatalog.items || []).filter((i: any) => i.offers && i.offers.length > 0);
      }
      // Filter out providers with no items
      filteredProviders = filteredProviders.filter(p => p.items && p.items.length > 0);

      // Extract providers and offers for matching
      const providers = new Map<string, Provider>();
      const allOffers: CatalogOffer[] = [];

      for (const providerCatalog of filteredProviders) {
        providers.set(providerCatalog.id, {
          id: providerCatalog.id,
          name: providerCatalog.descriptor?.name || 'Unknown',
          trust_score: config.matching.defaultTrustScore,
          total_orders: 0,
          successful_orders: 0,
        });

        for (const item of providerCatalog.items || []) {
          allOffers.push(...(item.offers || []));
        }
      }

      // Always run matching algorithm to calculate scores for all offers
      let matchingResults = null;
      if (allOffers.length > 0) {
        const criteria: MatchingCriteria = {
          requestedQuantity: currentTxState?.discoveryCriteria?.minQuantity || 1,
          requestedTimeWindow: currentTxState?.discoveryCriteria?.timeWindow,
          maxPrice: currentTxState?.discoveryCriteria?.maxPrice,
        };

        try {
          matchingResults = matchOffers(allOffers, providers, criteria);
        } catch (matchError: any) {
          logger.error(`Matching error: ${matchError.message}`);
        }
      }

      // Update transaction state with the catalog
      await updateTransaction(txnId, {
        catalog: { providers: filteredProviders },
        providers,
        matchingResults,
        status: 'SELECTING',
      });

      logger.info(`discover: ${filteredProviders.length} providers, ${allOffers.length} offers`);

      processedCatalog = { providers: filteredProviders };
    }

    if (processedCatalog && processedCatalog.providers.length > 0) {
      return res.json({
        status: 'ok',
        transaction_id: txnId,
        message_id: context.message_id,
        catalog: processedCatalog,
        source: 'external_cds',
        ack: response.data,
      });
    }

    // CDS returned 200 but no usable catalog — fall through to local fallback
    logger.info('CDS returned empty catalog, falling back to local', { transaction_id: txnId });
  } catch (error: any) {
    const cdsStatus = error.response?.status;
    logger.error(`CDS discover failed: ${error.message}`, { status: cdsStatus });
  }

  // Fall back to local catalog (runs when CDS fails OR returns empty catalog)
  logger.info('Falling back to LOCAL catalog', { transaction_id: txnId });
  try {
    const now = new Date();
    const localOffers = await prisma.catalogOffer.findMany({
      where: {
        ...(sourceType ? { item: { sourceType: sourceType } } : {}),
        ...(excludeProviderId ? { providerId: { not: excludeProviderId } } : {}),
        // Filter out expired offers
        timeWindowEnd: { gt: now },
        blocks: { some: { status: 'AVAILABLE' } },
      },
      include: {
        item: true,
        provider: true,
        blocks: { where: { status: 'AVAILABLE' } },
      },
    });

    // Don't filter individual offers by minQuantity — smart buy can combine
    // multiple smaller offers to fulfill the total requested quantity
    const filteredOffers = localOffers.filter(offer => {
      const availableQty = offer.blocks.length;
      return availableQty > 0;
    });

    const providerMap = new Map<string, any>();
    for (const offer of filteredOffers) {
      if (!providerMap.has(offer.providerId)) {
        providerMap.set(offer.providerId, {
          id: offer.providerId,
          descriptor: { name: offer.provider?.name || 'Unknown Provider' },
          items: [],
        });
      }
      const provider = providerMap.get(offer.providerId)!;
      let itemEntry = provider.items.find((i: any) => i.id === offer.itemId);
      if (!itemEntry) {
        itemEntry = {
          id: offer.itemId,
          descriptor: { name: `${offer.item?.sourceType || 'Energy'} from ${offer.provider?.name || 'Provider'}` },
          itemAttributes: {
            sourceType: offer.item?.sourceType || 'MIXED',
            deliveryMode: offer.item?.deliveryMode || 'INJECTION',
            availableQuantity: offer.blocks.length,
          },
          source_type: offer.item?.sourceType || 'MIXED',
          delivery_mode: offer.item?.deliveryMode || 'INJECTION',
          offers: [],
        };
        provider.items.push(itemEntry);
      }
      itemEntry.offers.push({
        id: offer.id,
        item_id: offer.itemId,
        provider_id: offer.providerId,
        price: { value: offer.priceValue, currency: offer.currency || 'INR' },
        quantity: { available: offer.blocks.length, maximum: offer.maxQty },
        maxQuantity: offer.blocks.length,
        timeWindow: offer.timeWindowStart && offer.timeWindowEnd ? {
          startTime: offer.timeWindowStart.toISOString(),
          endTime: offer.timeWindowEnd.toISOString(),
        } : null,
      });
    }

    const catalog = { providers: Array.from(providerMap.values()) };
    await updateTransaction(txnId, { catalog });

    const totalOffers = catalog.providers.reduce((sum, p) =>
      sum + p.items.reduce((iSum: number, i: any) => iSum + (i.offers?.length || 0), 0), 0);
    logger.info(`Local fallback catalog: ${catalog.providers.length} providers, ${totalOffers} offers`, { transaction_id: txnId });

    return res.json({
      transaction_id: txnId,
      status: 'success',
      catalog,
      source: 'local_fallback',
    });
  } catch (fallbackError: any) {
    logger.error(`Local fallback also failed: ${fallbackError.message}`, { transaction_id: txnId });
    res.status(500).json({ error: 'Discovery failed. Please try again.' });
  }
});

/**
 * POST /api/select - Select an offer (with matching algorithm)
 * Supports smart buy mode (auto single/multi) and bulk mode for selecting multiple offers
 */
router.post('/api/select', async (req: Request, res: Response) => {
  const {
    transaction_id,
    offer_id,
    item_id,
    quantity,
    requestedTimeWindow,
    autoMatch,
    // Smart buy mode - auto determines single vs multi
    smartBuy,
    // Bulk buy mode parameters (explicit multi-offer)
    bulkBuy,
    targetQuantity,
    maxOffers,
  } = req.body as {
    transaction_id: string;
    offer_id?: string;
    item_id?: string;
    quantity: number;
    requestedTimeWindow?: TimeWindow;
    autoMatch?: boolean;
    // Smart buy mode
    smartBuy?: boolean;
    // Bulk buy mode
    bulkBuy?: boolean;
    targetQuantity?: number;
    maxOffers?: number;
  };

  // Trade rules: validate quantity (min 1 kWh)
  const selectQty = targetQuantity || quantity;
  if (selectQty != null) {
    const qtyErr = validateQuantity(selectQty);
    if (qtyErr) {
      return res.status(400).json({ error: qtyErr });
    }
  }

  const txState = await getTransaction(transaction_id);

  if (!txState || !txState.catalog) {
    return res.status(400).json({ error: 'No catalog found for transaction. Run discover first.' });
  }

  let selectedOffer: CatalogOffer | undefined;
  let selectedItemId: string | undefined;
  let matchingResult: any;

  // Helper: Effective target quantity for smart/bulk modes
  const effectiveTarget = targetQuantity || quantity;

  // ==================== SMART BUY MODE ====================
  // Automatically determines if single or multiple offers are needed
  // Use the snapped time window from discover criteria if available, since the catalog
  // was already filtered by it. Fall back to the frontend's requestedTimeWindow.
  const effectiveSmartTimeWindow = txState.discoveryCriteria?.timeWindow || requestedTimeWindow;

  if (smartBuy && effectiveTarget && (requestedTimeWindow || effectiveSmartTimeWindow)) {
    // Collect all offers and providers from the catalog
    const allOffers: CatalogOffer[] = [];
    const providers = new Map<string, Provider>();

    for (const providerCatalog of txState.catalog.providers) {
      providers.set(providerCatalog.id, {
        id: providerCatalog.id,
        name: providerCatalog.descriptor?.name || 'Unknown',
        trust_score: config.matching.defaultTrustScore,
        total_orders: 0,
        successful_orders: 0,
      });

      for (const item of providerCatalog.items) {
        for (const offer of item.offers) {
          allOffers.push(offer);
        }
      }
    }

    if (allOffers.length === 0) {
      return res.status(400).json({ error: 'No offers available in catalog' });
    }

    // Score all offers using existing matching algorithm
    // Use the snapped time window that was used to filter the catalog during discover,
    // ensuring consistency between catalog contents and matching criteria
    const criteria: MatchingCriteria = {
      requestedQuantity: 1, // Use 1 for scoring, actual qty handled by selector
      requestedTimeWindow: effectiveSmartTimeWindow,
    };

    matchingResult = matchOffers(allOffers, providers, criteria);

    // Use bulk matcher to select offers
    const smartResult = selectOffersForBulk(
      matchingResult.allOffers,
      effectiveTarget,
      maxOffers || 15
    );

    if (smartResult.selectedOffers.length === 0) {
      // Collect available time windows from all offers for suggestions
      const availableWindows = matchingResult.allOffers
        .filter((o: any) => o.offer.timeWindow?.startTime && o.offer.timeWindow?.endTime)
        .map((o: any) => o.offer.timeWindow)
        .filter((tw: any, i: number, arr: any[]) => arr.findIndex(t => t.startTime === tw.startTime) === i)
        .slice(0, 5);

      let errorMessage = 'No matching offers found';
      const filterReasons = matchingResult.allOffers
        .flatMap((o: any) => o.filterReasons || [])
        .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i);

      if (matchingResult.allOffers.length === 0) {
        errorMessage = 'No offers available in the catalog';
      } else if (matchingResult.eligibleCount === 0) {
        if (filterReasons.some((r: string) => r.includes('Time window'))) {
          errorMessage = 'No offers match the requested time window. Try adjusting your delivery time.';
        } else if (filterReasons.length > 0) {
          errorMessage = `No offers match your criteria: ${filterReasons[0]}`;
        }
      }

      // Return 200 with structured "no eligible" result so frontend can show suggestions
      return res.json({
        status: 'no_eligible_offers',
        transaction_id,
        smartBuy: true,
        error: errorMessage,
        offersAvailable: matchingResult.allOffers.length,
        eligibleOffers: matchingResult.eligibleCount,
        filterReasons,
        availableWindows,
        selectedOffers: [],
        summary: {
          totalQuantity: 0,
          totalPrice: 0,
          offersUsed: 0,
          fullyFulfilled: false,
          shortfall: effectiveTarget,
        },
      });
    }

    // Determine selection type: single if only 1 offer AND fully fulfilled
    const isSingleOffer = smartResult.selectedOffers.length === 1 && smartResult.fullyFulfilled;
    const selectionType = isSingleOffer ? 'single' : 'multiple';

    logger.info(`smartBuy: ${smartResult.offersUsed} sellers, ${smartResult.totalQuantity}/${effectiveTarget} kWh, Rs ${smartResult.totalPrice.toFixed(2)}`);

    // Store selection in transaction state (same format as bulk mode)
    await updateTransaction(transaction_id, {
      bulkMode: !isSingleOffer, // Only true if multiple offers
      selectedOffers: smartResult.selectedOffers,
      bulkSelection: {
        totalQuantity: smartResult.totalQuantity,
        totalPrice: smartResult.totalPrice,
        fullyFulfilled: smartResult.fullyFulfilled,
        shortfall: smartResult.shortfall,
        targetQuantity: effectiveTarget,
      },
      // For single offer mode, also set the legacy fields
      selectedOffer: isSingleOffer ? smartResult.selectedOffers[0].offer : undefined,
      selectedQuantity: isSingleOffer ? smartResult.selectedOffers[0].quantity : undefined,
      order: undefined,
      error: undefined,
    });

    // Return smart buy response with selection type
    const response = formatBulkSelectionResponse(smartResult);
    return res.json({
      status: 'ok',
      transaction_id,
      smartBuy: true,
      selectionType,
      ...response,
      message: smartResult.fullyFulfilled
        ? isSingleOffer
          ? `Found 1 offer for ${smartResult.totalQuantity} kWh`
          : `Found ${smartResult.offersUsed} offers for ${smartResult.totalQuantity} kWh`
        : `Partial fulfillment: ${smartResult.totalQuantity}/${effectiveTarget} kWh available (${smartResult.shortfall} kWh short)`,
    });
  }

  // ==================== BULK BUY MODE (explicit multi-offer) ====================
  const effectiveBulkTimeWindow = txState.discoveryCriteria?.timeWindow || requestedTimeWindow;

  if (bulkBuy && targetQuantity && (requestedTimeWindow || effectiveBulkTimeWindow)) {
    // Collect all offers and providers from the catalog
    const allOffers: CatalogOffer[] = [];
    const providers = new Map<string, Provider>();

    for (const providerCatalog of txState.catalog.providers) {
      providers.set(providerCatalog.id, {
        id: providerCatalog.id,
        name: providerCatalog.descriptor?.name || 'Unknown',
        trust_score: config.matching.defaultTrustScore,
        total_orders: 0,
        successful_orders: 0,
      });

      for (const item of providerCatalog.items) {
        for (const offer of item.offers) {
          allOffers.push(offer);
        }
      }
    }

    if (allOffers.length === 0) {
      return res.status(400).json({ error: 'No offers available in catalog' });
    }

    // Score all offers using existing matching algorithm
    // Use the snapped time window from discover criteria for consistency
    const criteria: MatchingCriteria = {
      requestedQuantity: 1, // Use 1 for scoring, actual qty handled by bulk selector
      requestedTimeWindow: effectiveBulkTimeWindow,
    };

    matchingResult = matchOffers(allOffers, providers, criteria);

    // Use bulk matcher to select offers
    const bulkResult = selectOffersForBulk(
      matchingResult.allOffers,
      targetQuantity,
      maxOffers || 15
    );

    if (bulkResult.selectedOffers.length === 0) {
      // Provide helpful error message based on why no offers matched
      let errorMessage = 'No matching offers found for bulk order';
      if (matchingResult.allOffers.length === 0) {
        errorMessage = 'No offers available in the catalog';
      } else if (matchingResult.eligibleCount === 0) {
        // Check common filter failures
        const filterReasons = matchingResult.allOffers
          .flatMap(o => o.filterReasons || [])
          .filter((v, i, a) => a.indexOf(v) === i); // unique
        if (filterReasons.some(r => r.includes('Time window'))) {
          errorMessage = 'No offers match the requested time window. Try adjusting your delivery time.';
        } else if (filterReasons.length > 0) {
          errorMessage = `No offers match your criteria: ${filterReasons[0]}`;
        }
      }
      return res.status(400).json({
        error: errorMessage,
        offersAvailable: matchingResult.allOffers.length,
        eligibleOffers: matchingResult.eligibleCount,
      });
    }

    logger.info(`Bulk selection: ${bulkResult.offersUsed} offers selected for ${bulkResult.totalQuantity}/${targetQuantity} kWh`, {
      transaction_id,
      fullyFulfilled: bulkResult.fullyFulfilled,
      shortfall: bulkResult.shortfall,
    });

    // Store bulk selection in transaction state
    await updateTransaction(transaction_id, {
      bulkMode: true,
      selectedOffers: bulkResult.selectedOffers,
      bulkSelection: {
        totalQuantity: bulkResult.totalQuantity,
        totalPrice: bulkResult.totalPrice,
        fullyFulfilled: bulkResult.fullyFulfilled,
        shortfall: bulkResult.shortfall,
        targetQuantity,
      },
      // Clear single offer selection
      selectedOffer: undefined,
      selectedQuantity: undefined,
      order: undefined,
      error: undefined,
    });

    // Return bulk selection preview (no BPP call needed yet)
    const response = formatBulkSelectionResponse(bulkResult);
    return res.json({
      status: 'ok',
      transaction_id,
      bulkMode: true,
      ...response,
      message: bulkResult.fullyFulfilled
        ? `Selected ${bulkResult.offersUsed} offers for ${bulkResult.totalQuantity} kWh`
        : `Partial fulfillment: ${bulkResult.totalQuantity}/${targetQuantity} kWh available (${bulkResult.shortfall} kWh short)`,
    });
  }

  // ==================== SINGLE OFFER MODE (existing logic) ====================
  if (autoMatch && txState.catalog && requestedTimeWindow) {
    // Use matching algorithm to select best offer
    const allOffers: CatalogOffer[] = [];
    const providers = new Map<string, Provider>();

    for (const providerCatalog of txState.catalog.providers) {
      // Add provider with default trust score (in production, fetch from registry)
      providers.set(providerCatalog.id, {
        id: providerCatalog.id,
        name: providerCatalog.descriptor?.name || 'Unknown',
        trust_score: config.matching.defaultTrustScore,
        total_orders: 0,
        successful_orders: 0,
      });

      for (const item of providerCatalog.items) {
        for (const offer of item.offers) {
          allOffers.push(offer);
        }
      }
    }

    const criteria: MatchingCriteria = {
      requestedQuantity: quantity,
      requestedTimeWindow,
    };

    matchingResult = matchOffers(allOffers, providers, criteria);

    if (matchingResult.selectedOffer) {
      selectedOffer = matchingResult.selectedOffer.offer;
      selectedItemId = selectedOffer.item_id;

      logger.info(`Matching algorithm selected offer: ${selectedOffer.id} with score ${matchingResult.selectedOffer.score.toFixed(3)}`, {
        transaction_id,
        breakdown: matchingResult.selectedOffer.breakdown,
      });
    } else {
      return res.status(400).json({
        error: matchingResult.reason || 'No matching offers found',
        allOffers: matchingResult.allOffers.length,
      });
    }
  } else if (offer_id) {
    // Manual offer selection
    for (const providerCatalog of txState.catalog.providers) {
      for (const item of providerCatalog.items) {
        for (const offer of item.offers) {
          if (offer.id === offer_id) {
            selectedOffer = offer;
            selectedItemId = item.id;
            break;
          }
        }
        if (selectedOffer) break;
      }
      if (selectedOffer) break;
    }

    if (!selectedOffer) {
      return res.status(400).json({ error: `Offer ${offer_id} not found in catalog` });
    }
  } else {
    return res.status(400).json({ error: 'Either offer_id or autoMatch with requestedTimeWindow is required' });
  }

  // Resolve item ID for use in message and attribute lookup
  const resolvedItemId = selectedItemId || item_id || selectedOffer.item_id;

  // Look up item attributes from catalog for Beckn orderItemAttributes
  let itemMeterId: string | undefined;
  if (txState.catalog) {
    for (const providerCatalog of txState.catalog.providers) {
      for (const catalogItem of providerCatalog.items) {
        if (catalogItem.id === resolvedItemId) {
          itemMeterId = catalogItem.itemAttributes?.meterId;
          break;
        }
      }
      if (itemMeterId) break;
    }
  }

  // Look up provider's utility customer info from DB
  let utilityCustomerId: string | undefined;
  try {
    const providerRecord = await prisma.provider.findUnique({
      where: { id: selectedOffer.provider_id },
      include: { user: true },
    });
    utilityCustomerId = providerRecord?.user?.consumerNumber || undefined;
  } catch (e) {
    // Non-critical — proceed without utilityCustomerId
  }

  // Determine BPP routing - use offer's bpp_uri if available (external), otherwise use local BPP
  const targetBppUri = selectedOffer.bpp_uri || config.bpp.uri;
  const targetBppId = selectedOffer.bpp_id || selectedOffer.provider_id;
  const isExternalBpp = !!selectedOffer.bpp_uri && selectedOffer.bpp_uri !== config.bpp.uri;

  // Create context with correct BPP info
  const context = createContext({
    action: 'select',
    transaction_id,
    bap_id: config.bap.id,
    bap_uri: config.bap.uri,
    bpp_id: targetBppId,
    bpp_uri: targetBppUri,
  });

  // Look up buyer utility info
  let buyerMeterId: string | undefined;
  let buyerUtilityCustomerId: string | undefined;
  const buyerUser = req.user?.id ? await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { meterNumber: true, consumerNumber: true },
  }) : null;
  buyerMeterId = buyerUser?.meterNumber || undefined;
  buyerUtilityCustomerId = buyerUser?.consumerNumber || undefined;

  // Build Beckn v2 wire format order for select
  const wireOrder = buildWireOrder({
    sellerId: selectedOffer.provider_id,
    buyerId: req.user?.id || 'buyer',
    buyerMeterId,
    buyerUtilityCustomerId,
    buyerUtilityId: config.utility?.id,
    bapId: config.bap.id,
    bppId: targetBppId,
    items: [{
      itemId: resolvedItemId,
      quantity,
      offerId: selectedOffer.id,
      offerPrice: selectedOffer.price.value,
      offerCurrency: selectedOffer.price.currency,
      offerProvider: selectedOffer.provider_id,
      offerItems: [resolvedItemId],
      offerTimeWindow: selectedOffer.timeWindow,
      providerMeterId: itemMeterId,
      providerUtilityCustomerId: utilityCustomerId,
      providerUtilityId: config.utility?.id,
    }],
  });

  const selectMessage = {
    context,
    message: { order: wireOrder },
  };

  logger.info(`select: ${selectedOffer.id}`);

  await logEvent(transaction_id, context.message_id, 'select', 'OUTBOUND', JSON.stringify(selectMessage));

  // Update state - store the offer and quantity, and CLEAR the old order to allow a new one
  // This is critical for allowing multiple purchases from the same discovery
  await updateTransaction(transaction_id, {
    selectedOffer,
    selectedQuantity: quantity,
    order: undefined, // Clear old order so new one can be created
    error: undefined, // Clear any previous error
    // Clear bulk mode fields when using single offer mode
    bulkMode: false,
    selectedOffers: undefined,
    bulkSelection: undefined,
  });

  try {
    // Route to the correct BPP based on offer's bpp_uri
    const bppEndpoint = isExternalBpp ? targetBppUri : `${config.urls.bpp}/select`;
    const targetUrl = isExternalBpp ? `${targetBppUri}/select` : bppEndpoint;


    // Use secureAxios for external BPPs (handles Beckn HTTP signatures)
    // Use plain axios for local BPP (no signature needed)
    const response = isExternalBpp
      ? await secureAxios.post(targetUrl, selectMessage)
      : await axios.post(targetUrl, selectMessage);

    res.json({
      status: 'ok',
      transaction_id,
      message_id: context.message_id,
      selected_offer: {
        id: selectedOffer.id,
        provider_id: selectedOffer.provider_id,
        price: selectedOffer.price,
        quantity,
      },
      matching: matchingResult ? {
        score: matchingResult.selectedOffer?.score,
        breakdown: matchingResult.selectedOffer?.breakdown,
        alternativeOffers: matchingResult.allOffers.length,
      } : undefined,
      ack: response.data,
    });
  } catch (error: any) {
    logger.error(`Select request failed: ${error.message}`, {
      transaction_id,
      status: error.response?.status,
      data: error.response?.data,
    });
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/init - Initialize order
 * Supports both single offer and bulk mode
 */
router.post('/api/init', async (req: Request, res: Response) => {
  const { transaction_id } = req.body as { transaction_id: string };

  const txState = await getTransaction(transaction_id);

  if (!txState) {
    return res.status(400).json({ error: 'Transaction not found' });
  }

  // Check for bulk mode or single offer mode
  const isBulkMode = txState.bulkMode && txState.selectedOffers && txState.selectedOffers.length > 0;
  const hasSingleOffer = txState.selectedOffer;

  if (!isBulkMode && !hasSingleOffer) {
    return res.status(400).json({ error: 'No offer selected. Run select first.' });
  }

  let orderItems: Array<{ item_id: string; offer_id: string; quantity: number }>;
  let providerId: string;
  let targetBppUri: string;
  let targetBppId: string;
  let isExternalBpp: boolean;

  if (isBulkMode) {
    // ==================== BULK MODE ====================
    // Build items array from all selected offers
    orderItems = txState.selectedOffers!.map(s => ({
      item_id: s.offer.item_id,
      offer_id: s.offer.id,
      quantity: s.quantity,
    }));

    // Use first offer for BPP routing (all should be local BPP for bulk)
    const firstOffer = txState.selectedOffers![0].offer;
    providerId = firstOffer.provider_id;
    targetBppUri = firstOffer.bpp_uri || config.bpp.uri;
    targetBppId = firstOffer.bpp_id || firstOffer.provider_id;
    isExternalBpp = !!firstOffer.bpp_uri && firstOffer.bpp_uri !== config.bpp.uri;

    logger.info(`Bulk init: ${orderItems.length} items, total ${txState.bulkSelection?.totalQuantity} kWh`, {
      transaction_id,
    });
  } else {
    // ==================== SINGLE OFFER MODE ====================
    const offer = txState.selectedOffer!;
    const selectedQuantity = txState.selectedQuantity || offer.maxQuantity;

    orderItems = [{
      item_id: offer.item_id,
      offer_id: offer.id,
      quantity: selectedQuantity,
    }];

    providerId = offer.provider_id;
    targetBppUri = offer.bpp_uri || config.bpp.uri;
    targetBppId = offer.bpp_id || offer.provider_id;
    isExternalBpp = !!offer.bpp_uri && offer.bpp_uri !== config.bpp.uri;
  }

  // Create context with correct BPP info
  const context = createContext({
    action: 'init',
    transaction_id,
    bap_id: config.bap.id,
    bap_uri: config.bap.uri,
    bpp_id: targetBppId,
    bpp_uri: targetBppUri,
  });

  // Build init message with Beckn v2 wire format
  const initWireOrder = buildWireOrder({
    sellerId: providerId,
    buyerId: txState.buyerId || 'buyer',
    bapId: config.bap.id,
    bppId: targetBppId,
    buyerUtilityId: config.utility?.id,
    items: orderItems.map(oi => ({
      itemId: oi.item_id,
      quantity: oi.quantity,
      offerId: oi.offer_id,
      offerPrice: 0, // Will be calculated by BPP
      offerCurrency: 'INR',
      offerProvider: providerId,
      offerItems: [oi.item_id],
    })),
  });

  // Add fulfillment stub for init
  (initWireOrder as any)['beckn:fulfillment'] = {
    '@context': 'https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/main/schema/core/v2/context.jsonld',
    '@type': 'beckn:Fulfillment',
    'beckn:id': `fulfillment-${context.transaction_id.slice(0, 8)}`,
    'beckn:mode': 'DELIVERY',
  };

  const initMessage = {
    context,
    message: { order: initWireOrder },
  };

  logger.info(`init: ${orderItems.length} items`);

  await logEvent(transaction_id, context.message_id, 'init', 'OUTBOUND', JSON.stringify(initMessage));

  try {
    // Route to the correct BPP based on offer's bpp_uri
    const targetUrl = isExternalBpp ? `${targetBppUri}/init` : `${config.urls.bpp}/init`;


    // Use secureAxios for external BPPs (handles Beckn HTTP signatures)
    const response = isExternalBpp
      ? await secureAxios.post(targetUrl, initMessage)
      : await axios.post(targetUrl, initMessage);

    res.json({
      status: 'ok',
      transaction_id,
      message_id: context.message_id,
      bulkMode: isBulkMode,
      itemCount: orderItems.length,
      ack: response.data,
    });
  } catch (error: any) {
    logger.error(`Init request failed: ${error.message}`, {
      transaction_id,
      status: error.response?.status,
      data: error.response?.data,
    });
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/confirm - Confirm order
 * Supports both single order and bulk orders (confirms all orders in bulk group)
 */
router.post('/api/confirm', authMiddleware, async (req: Request, res: Response) => {
  const { transaction_id, order_id } = req.body as { transaction_id: string; order_id?: string };

  // Check for Consumption VC before allowing purchase
  const consumptionVC = await prisma.userCredential.findFirst({
    where: {
      userId: req.user!.id,
      credentialType: 'CONSUMPTION_PROFILE',
      verified: true,
    },
  });

  if (!consumptionVC) {
    return res.status(403).json({
      error: 'Consumption credential required',
      requiresVC: 'CONSUMPTION_PROFILE',
      message: 'Upload a Consumption Profile VC to purchase energy',
    });
  }

  const txState = await getTransaction(transaction_id);

  if (!txState) {
    return res.status(400).json({ error: 'Transaction not found' });
  }

  // Check for bulk orders mode
  const hasBulkOrders = txState.bulkOrders && txState.bulkOrders.length > 0;

  if (hasBulkOrders) {
    // ==================== BULK ORDERS CONFIRMATION ====================
    logger.info(`Confirming ${txState.bulkOrders!.length} bulk orders`, {
      transaction_id,
      orderIds: txState.bulkOrders!.map(o => o.id),
    });

    const confirmedOrders: string[] = [];
    const failedOrders: Array<{ id: string; error: string }> = [];
    const targetUrl = `${config.urls.bpp}/confirm`;

    // Confirm each order in parallel
    await Promise.all(txState.bulkOrders!.map(async (bulkOrder) => {
      try {
        // bulkOrder may have transaction_id (snake_case from toOrder) or transactionId (camelCase from type)
        const bulkTxnId = bulkOrder.transactionId || (bulkOrder as any).transaction_id;
        const context = createContext({
          action: 'confirm',
          transaction_id: bulkTxnId,
          bap_id: config.bap.id,
          bap_uri: config.bap.uri,
          bpp_id: config.bpp.id,
          bpp_uri: config.bpp.uri,
        });

        const confirmMessage: ConfirmMessage = {
          context,
          message: {
            order: { id: bulkOrder.id },
          },
        };

        await logEvent(bulkTxnId, context.message_id, 'confirm', 'OUTBOUND', JSON.stringify(confirmMessage));
        await axios.post(targetUrl, confirmMessage);
        confirmedOrders.push(bulkOrder.id);

        logger.info(`Bulk order confirmed: ${bulkOrder.id}`, { transaction_id: bulkTxnId });
      } catch (error: any) {
        logger.error(`Failed to confirm bulk order ${bulkOrder.id}: ${error.message}`);
        failedOrders.push({ id: bulkOrder.id, error: error.message });
      }
    }));

    // Return result
    res.json({
      status: failedOrders.length === 0 ? 'ok' : 'partial',
      transaction_id,
      bulk_mode: true,
      confirmed_orders: confirmedOrders,
      failed_orders: failedOrders.length > 0 ? failedOrders : undefined,
      total_confirmed: confirmedOrders.length,
      total_failed: failedOrders.length,
    });
    return;
  }

  // ==================== SINGLE ORDER CONFIRMATION (original flow) ====================
  const orderId = order_id || txState.order?.id;

  if (!orderId) {
    return res.status(400).json({ error: 'No order ID available. Run init first or provide order_id.' });
  }

  // Determine BPP routing - use offer's bpp_uri if available (external), otherwise use local BPP
  const offer = txState.selectedOffer;
  const targetBppUri = offer?.bpp_uri || config.bpp.uri;
  const targetBppId = offer?.bpp_id || offer?.provider_id || config.bpp.id;
  const isExternalBpp = !!offer?.bpp_uri && offer.bpp_uri !== config.bpp.uri;

  // Create context with correct BPP info
  const context = createContext({
    action: 'confirm',
    transaction_id,
    bap_id: config.bap.id,
    bap_uri: config.bap.uri,
    bpp_id: targetBppId,
    bpp_uri: targetBppUri,
  });

  // Build confirm message with Beckn v2 wire format
  const confirmMessage = {
    context,
    message: {
      order: { 'beckn:id': orderId },
    },
  } as any;

  logger.info(`confirm: ${orderId}`);

  await logEvent(transaction_id, context.message_id, 'confirm', 'OUTBOUND', JSON.stringify(confirmMessage));

  try {
    // Route to the correct BPP based on offer's bpp_uri
    const targetUrl = isExternalBpp ? `${targetBppUri}/confirm` : `${config.urls.bpp}/confirm`;


    // Use secureAxios for external BPPs (handles Beckn HTTP signatures)
    const response = isExternalBpp
      ? await secureAxios.post(targetUrl, confirmMessage)
      : await axios.post(targetUrl, confirmMessage);

    // Respond immediately so the client is not blocked by settlement or BPP async processing
    res.json({
      status: 'ok',
      transaction_id,
      message_id: context.message_id,
      order_id: orderId,
      ack: response.data,
    });

    // Best-effort settlement initiation (idempotent, non-blocking)
    try {
      const txState = await getTransaction(transaction_id);
      const order = txState?.order;
      const tradeId = order?.id || orderId;
      const orderPrice = Number(order?.quote?.price?.value ?? 0);
      const quantity = Number(order?.quote?.totalQuantity ?? txState?.selectedQuantity ?? 1);
      const unitPrice = Number(txState?.selectedOffer?.price?.value ?? 0);
      const principalValue = orderPrice || roundMoney(unitPrice * quantity);

      if (tradeId && principalValue > 0) {
        const existing = await getSettlementRecord(tradeId);
        if (!existing) {
          const fee = computeFee(principalValue);
          const total = roundMoney(principalValue + fee);
          const expiresAt = new Date(Date.now() + DEFAULT_ESCROW_DURATION_SEC * 1000).toISOString();
          const record: SettlementRecord = {
            tradeId,
            orderId: order?.id || orderId || null,
            transactionId: transaction_id,
            buyerId: config.bap.id,
            sellerId: order?.items?.[0]?.provider_id || txState?.selectedOffer?.provider_id || null,
            principal: roundMoney(principalValue),
            fee,
            total,
            expiresAt,
            status: 'INITIATED',
            verificationOutcome: null,
            fundedReceipt: null,
            payoutReceipt: null,
            fundedAt: null,
            verifiedAt: null,
            payoutAt: null,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          };
          logger.info('=== [STEP 1] TE -> Bank: Request to block funds', {
            tradeId,
            orderId: record.orderId,
            principal: record.principal,
            fee: record.fee,
            total: record.total,
          });
          await insertSettlementRecord(record);
        }
      }
    } catch (error: any) {
      logger.warn(`Settlement initiation skipped: ${error.message}`, { transaction_id });
    }
  } catch (error: any) {
    logger.error(`Confirm request failed: ${error.message}`, { transaction_id });
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * POST /api/status - Get order status
 */
router.post('/api/status', async (req: Request, res: Response) => {
  const { transaction_id, order_id } = req.body as { transaction_id: string; order_id?: string };

  const txState = await getTransaction(transaction_id);

  if (!txState) {
    return res.status(400).json({ error: 'Transaction not found' });
  }

  const orderId = order_id || txState.order?.id || '';

  // Determine BPP routing - use offer's bpp_uri if available (external), otherwise use local BPP
  const offer = txState.selectedOffer;
  const targetBppUri = offer?.bpp_uri || config.bpp.uri;
  const targetBppId = offer?.bpp_id || offer?.provider_id || config.bpp.id;
  const isExternalBpp = !!offer?.bpp_uri && offer.bpp_uri !== config.bpp.uri;

  // Create context with correct BPP info
  const context = createContext({
    action: 'status',
    transaction_id,
    bap_id: config.bap.id,
    bap_uri: config.bap.uri,
    bpp_id: targetBppId,
    bpp_uri: targetBppUri,
  });

  // Build status message with Beckn v2 wire format
  const statusMessage = {
    context,
    message: {
      order: { 'beckn:id': orderId },
    },
  } as any;

  logger.info(`status: ${orderId}`);

  await logEvent(transaction_id, context.message_id, 'status', 'OUTBOUND', JSON.stringify(statusMessage));

  try {
    // Route to the correct BPP based on offer's bpp_uri
    const targetUrl = isExternalBpp ? `${targetBppUri}/status` : `${config.urls.bpp}/status`;


    // Use secureAxios for external BPPs (handles Beckn HTTP signatures)
    const response = isExternalBpp
      ? await secureAxios.post(targetUrl, statusMessage)
      : await axios.post(targetUrl, statusMessage);

    res.json({
      status: 'ok',
      transaction_id,
      message_id: context.message_id,
      ack: response.data,
    });
  } catch (error: any) {
    logger.error(`Status request failed: ${error.message}`, {
      transaction_id,
      status: error.response?.status,
      data: error.response?.data,
    });
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/transactions - Create a new transaction
 */
router.post('/api/transactions', async (req: Request, res: Response) => {
  const txnId = uuidv4();
  await createTransaction(txnId);
  logger.info('Created new transaction', { transaction_id: txnId });
  res.json({ transaction_id: txnId });
});

/**
 * GET /api/transactions - List all transactions
 */
router.get('/api/transactions', async (req: Request, res: Response) => {
  const transactions = await getAllTransactions();
  res.json({ transactions });
});

/**
 * GET /api/transactions/:id - Get transaction details
 */
router.get('/api/transactions/:id', async (req: Request, res: Response) => {
  const txState = await getTransaction(req.params.id);

  if (!txState) {
    return res.status(404).json({ error: 'Transaction not found' });
  }

  res.json(txState);
});

/**
 * GET /api/settlement/:tradeId - Get settlement progress for UI
 */
router.get('/api/settlement/:tradeId', async (req: Request, res: Response) => {
  const tradeId = req.params.tradeId;

  try {
    const record = await getSettlementRecord(tradeId);
    if (!record) {
      return res.status(404).json({ error: 'Settlement record not found' });
    }
    const steps = buildPaymentSteps(record);
    res.json({
      tradeId,
      record,
      steps,
      escrow: buildEscrowInstructions(record),
      payout: buildPayoutInstruction(record, record.verificationOutcome),
    });
  } catch (error: any) {
    logger.error(`Settlement status read failed: ${error.message}`, { tradeId });
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/settlement/initiate - Create settlement record (manual escrow)
 */
router.post('/api/settlement/initiate', async (req: Request, res: Response) => {
  const { tradeId, order_id, transaction_id, durationSec } = req.body as {
    tradeId?: string;
    order_id?: string;
    transaction_id?: string;
    durationSec?: number;
  };

  const txState = transaction_id ? await getTransaction(transaction_id) : null;
  const order = txState?.order;
  const resolvedTradeId = tradeId || order?.id || order_id;

  if (!resolvedTradeId) {
    return res.status(400).json({ error: 'tradeId or order_id is required' });
  }

  const existing = await getSettlementRecord(resolvedTradeId);
  if (existing) {
    return res.json({
      status: 'ok',
      record: existing,
      steps: buildPaymentSteps(existing),
      escrow: buildEscrowInstructions(existing),
      payout: buildPayoutInstruction(existing, existing.verificationOutcome),
    });
  }

  const principalFromOrder = Number(order?.quote?.price?.value ?? 0);
  const quantity = Number(order?.quote?.totalQuantity ?? txState?.selectedQuantity ?? 1);
  const priceFromOffer = Number(txState?.selectedOffer?.price?.value ?? 0);
  const principal = principalFromOrder || roundMoney(priceFromOffer * quantity);

  if (!principal || principal <= 0) {
    return res.status(400).json({ error: 'Unable to determine principal amount' });
  }

  const fee = computeFee(principal);
  const total = roundMoney(principal + fee);
  const expiresAt = new Date(Date.now() + (durationSec || DEFAULT_ESCROW_DURATION_SEC) * 1000).toISOString();

  const record: SettlementRecord = {
    tradeId: resolvedTradeId,
    orderId: order?.id || order_id || null,
    transactionId: transaction_id || null,
    buyerId: config.bap.id,
    sellerId: order?.items?.[0]?.provider_id || txState?.selectedOffer?.provider_id || null,
    principal: roundMoney(principal),
    fee,
    total,
    expiresAt,
    status: 'INITIATED',
    verificationOutcome: null,
    fundedReceipt: null,
    payoutReceipt: null,
    fundedAt: null,
    verifiedAt: null,
    payoutAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  logger.info('=== [STEP 1] TE -> Bank: Request to block funds', {
    tradeId: record.tradeId,
    orderId: record.orderId,
    principal: record.principal,
    fee: record.fee,
    total: record.total,
    expiresAt: record.expiresAt,
  });

  await insertSettlementRecord(record);

  res.json({
    status: 'ok',
    record,
    steps: buildPaymentSteps(record),
    escrow: buildEscrowInstructions(record),
    payout: buildPayoutInstruction(record, record.verificationOutcome),
  });
});

/**
 * POST /api/settlement/confirm-funded - Record escrow funding receipt (idempotent)
 */
router.post('/api/settlement/confirm-funded', async (req: Request, res: Response) => {
  const { tradeId, receipt } = req.body as { tradeId?: string; receipt?: string };
  if (!tradeId || !receipt) {
    return res.status(400).json({ error: 'tradeId and receipt are required' });
  }

  const record = await getSettlementRecord(tradeId);
  if (!record) {
    return res.status(404).json({ error: 'Settlement record not found', status: 'ERROR_NO_RECORD' });
  }

  if (record.status === 'RELEASED' || record.status === 'REFUNDED' || record.status === 'FUNDED') {
    return res.json({ status: 'ok', record, steps: buildPaymentSteps(record) });
  }

  await updateSettlementRecord(tradeId, {
    status: 'FUNDED',
    fundedReceipt: receipt,
    fundedAt: nowIso(),
  });

  const updated = await getSettlementRecord(tradeId);
  logger.info('=== [STEP 2] Bank (internal): Block funds in buyer account', { tradeId });
  logger.info('=== [STEP 3] Bank -> TE: Block confirmed', { tradeId, receipt });
  logger.info('=== [STEP 4] Bank -> Buyer: Funds blocked notification', { tradeId });

  res.json({ status: 'ok', record: updated, steps: buildPaymentSteps(updated) });
});

/**
 * POST /api/settlement/verify-outcome - Decide release/refund
 * Supports both manual outcome and VC-based verification
 * 
 * Body options:
 * 1. Manual: { tradeId, outcome: 'SUCCESS' | 'FAIL' }
 * 2. VC-based: { tradeId, credential: VerifiableCredential, verificationOptions?: VerificationOptions }
 */
router.post('/api/settlement/verify-outcome', async (req: Request, res: Response) => {
  const { tradeId, outcome, credential, verificationOptions } = req.body as {
    tradeId?: string;
    outcome?: SettlementOutcome;
    credential?: unknown;
    verificationOptions?: VerificationOptions;
  };

  if (!tradeId) {
    return res.status(400).json({ error: 'tradeId is required' });
  }

  // Must provide either manual outcome OR credential for VC verification
  if (!outcome && !credential) {
    return res.status(400).json({
      error: 'Either outcome (SUCCESS|FAIL) or credential (VC) is required',
      usage: {
        manual: '{ tradeId, outcome: "SUCCESS" | "FAIL" }',
        vcBased: '{ tradeId, credential: {...}, verificationOptions?: {...} }',
      },
    });
  }

  const record = await getSettlementRecord(tradeId);
  if (!record) {
    return res.status(404).json({ error: 'Settlement record not found', status: 'ERROR_NO_RECORD' });
  }

  if (record.status === 'RELEASED' || record.status === 'REFUNDED') {
    return res.json({ status: 'ok', record, payout: buildPayoutInstruction(record, record.verificationOutcome) });
  }

  if (record.status !== 'FUNDED') {
    return res.status(400).json({ error: 'Escrow not funded yet' });
  }

  const expired = new Date(record.expiresAt!).getTime() < Date.now();
  if (expired) {
    await updateSettlementRecord(tradeId, { status: 'ERROR_EXPIRED' });
    const updated = await getSettlementRecord(tradeId);
    return res.status(400).json({ error: 'Settlement expired', record: updated, status: 'ERROR_EXPIRED' });
  }

  let finalOutcome: SettlementOutcome;
  let verificationResult = null;
  let vcMetadata: { vcId?: string; vcIssuer?: string; vcClaims?: string } = {};

  if (credential) {
    // VC-based verification
    try {
      verificationResult = await verifyCredential(credential, verificationOptions);
      finalOutcome = verificationResult.verified ? 'SUCCESS' : 'FAIL';

      const vc = credential as VerifiableCredential;
      vcMetadata = {
        vcId: vc.id || `vc-${Date.now()}`,
        vcIssuer: getIssuerId(vc.issuer),
        vcClaims: JSON.stringify(verificationResult.claims || {}),
      };

      logger.info('=== [STEP 5] VC-based verification complete', {
        tradeId,
        vcVerified: verificationResult.verified,
        vcId: vcMetadata.vcId,
        issuer: vcMetadata.vcIssuer,
        checksRun: verificationResult.checks.length,
        checksFailed: verificationResult.checks.filter(c => c.status === 'failed').length,
      });
    } catch (error: any) {
      logger.error(`VC verification failed: ${error.message}`, { tradeId });
      return res.status(400).json({
        error: `VC verification failed: ${error.message}`,
        tradeId,
      });
    }
  } else {
    // Manual outcome
    if (outcome !== 'SUCCESS' && outcome !== 'FAIL') {
      return res.status(400).json({ error: 'outcome must be SUCCESS or FAIL' });
    }
    finalOutcome = outcome;
    logger.info('=== [STEP 5] Manual verification outcome set', { tradeId, outcome: finalOutcome });
  }

  // Update settlement record
  await updateSettlementRecord(tradeId, {
    verificationOutcome: finalOutcome,
    verifiedAt: nowIso(),
  });

  // Try to store VC metadata if available (fields may not exist yet)
  if (vcMetadata.vcId) {
    try {
      await prisma.settlementRecord.update({
        where: { tradeId },
        data: {
          vcId: vcMetadata.vcId,
          vcIssuer: vcMetadata.vcIssuer,
          vcVerifiedAt: new Date().toISOString(),
          vcClaims: vcMetadata.vcClaims,
        },
      });
    } catch (e) {
      // Fields may not exist yet if migration hasn't run - that's OK
      logger.debug('Could not store VC metadata fields - schema may need migration');
    }
  }

  const updated = await getSettlementRecord(tradeId);
  logger.info('=== [STEP 6] TE -> Bank: Execute settlement instruction', {
    tradeId,
    action: finalOutcome === 'SUCCESS' ? 'RELEASE' : 'REFUND',
    method: credential ? 'VC-based' : 'manual',
  });

  res.json({
    status: 'ok',
    method: credential ? 'vc-based' : 'manual',
    record: updated,
    payout: buildPayoutInstruction(updated, finalOutcome),
    steps: buildPaymentSteps(updated),
    verificationResult: verificationResult || undefined,
  });
});

/**
 * POST /api/settlement/confirm-payout - Record payout receipt (idempotent)
 */
router.post('/api/settlement/confirm-payout', async (req: Request, res: Response) => {
  const { tradeId, receipt, action } = req.body as { tradeId?: string; receipt?: string; action?: 'RELEASE' | 'REFUND' };
  if (!tradeId || !receipt) {
    return res.status(400).json({ error: 'tradeId and receipt are required' });
  }

  const record = await getSettlementRecord(tradeId);
  if (!record) {
    return res.status(404).json({ error: 'Settlement record not found', status: 'ERROR_NO_RECORD' });
  }

  if (record.status === 'RELEASED' || record.status === 'REFUNDED') {
    return res.json({ status: 'ok', record, steps: buildPaymentSteps(record) });
  }

  const outcomeAction =
    action ||
    (record.verificationOutcome === 'SUCCESS' ? 'RELEASE' : record.verificationOutcome === 'FAIL' ? 'REFUND' : null);

  if (!outcomeAction) {
    return res.status(400).json({ error: 'Verification outcome missing; provide action=RELEASE|REFUND' });
  }

  const newStatus: SettlementStatus = outcomeAction === 'RELEASE' ? 'RELEASED' : 'REFUNDED';
  await updateSettlementRecord(tradeId, {
    status: newStatus,
    payoutReceipt: receipt,
    payoutAt: nowIso(),
  });

  const updated = await getSettlementRecord(tradeId);
  logger.info('=== [STEP 7] Bank (internal): Unblock & transfer/refund', { tradeId, action: outcomeAction });
  logger.info('=== [STEP 8] Bank -> Seller/Buyer: Payout recorded', { tradeId, action: outcomeAction, receipt });
  logger.info('=== [STEP 9] Bank -> Buyer: Settlement complete', { tradeId, status: newStatus });

  res.json({ status: 'ok', record: updated, steps: buildPaymentSteps(updated) });
});

/**
 * POST /api/settlement/auto-run - Fully automated settlement simulation
 * Runs the complete flow: INITIATED -> FUNDED -> VERIFIED -> RELEASED/REFUNDED
 * with realistic delays and auto-generated receipts
 */
router.post('/api/settlement/auto-run', async (req: Request, res: Response) => {
  const { tradeId, scenario } = req.body as { tradeId?: string; scenario?: 'SUCCESS' | 'FAIL' };

  if (!tradeId) {
    return res.status(400).json({ error: 'tradeId is required' });
  }

  const finalOutcome: SettlementOutcome = scenario === 'FAIL' ? 'FAIL' : 'SUCCESS';

  const record = await getSettlementRecord(tradeId);
  if (!record) {
    return res.status(404).json({ error: 'Settlement record not found. Initiate settlement first.' });
  }

  // If already in progress or completed, just return current state
  if (record.status === 'RELEASED' || record.status === 'REFUNDED') {
    return res.json({ status: 'ok', message: 'Settlement already completed', record });
  }

  logger.info('=== [AUTO-RUN] Starting automated settlement simulation', { tradeId, scenario: finalOutcome });

  // Respond immediately - processing happens async
  res.json({ status: 'ok', message: 'Auto-run started', tradeId, scenario: finalOutcome });

  // Run the simulation in background
  (async () => {
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const genUtr = () => `UTR${Date.now()}${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`;
    const genPayout = () => `PAYOUT${Date.now()}${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`;

    try {
      // Step 1-4: Escrow funding (3 seconds)
      // Transfer: Buyer -> Escrow (total = principal + fee)
      if (record.status === 'INITIATED') {
        logger.info('=== [AUTO-RUN STEP 2-4] Simulating buyer -> escrow transfer...', { tradeId, amount: record.total });
        await delay(3000);

        // BALANCE TRANSFER: Buyer pays total (principal + fee) to Escrow
        transferMoney('buyer', 'escrow', record.total, 'Buyer → Escrow (funding)');

        const fundedReceipt = genUtr();
        await updateSettlementRecord(tradeId, {
          status: 'FUNDED',
          fundedReceipt,
          fundedAt: nowIso(),
        });
        logger.info('=== [AUTO-RUN STEP 2-4] Escrow funded', { tradeId, receipt: fundedReceipt, amount: record.total });
      }

      // Step 5-6: Verification - wait longer so escrow balance is visible (5 seconds)
      logger.info('=== [AUTO-RUN STEP 5] Simulating trade verification (escrow holding funds)...', { tradeId, outcome: finalOutcome });
      await delay(5000);
      await updateSettlementRecord(tradeId, {
        verificationOutcome: finalOutcome,
        verifiedAt: nowIso(),
      });
      logger.info('=== [AUTO-RUN STEP 5-6] Verification complete', { tradeId, outcome: finalOutcome });

      // Step 7-9: Payout (3 seconds)
      logger.info('=== [AUTO-RUN STEP 7-9] Simulating escrow -> ' + (finalOutcome === 'SUCCESS' ? 'seller' : 'buyer refund') + '...', { tradeId });
      await delay(3000);

      if (finalOutcome === 'SUCCESS') {
        // BALANCE TRANSFER: Escrow pays principal to Seller, fee stays as platform revenue
        transferMoney('escrow', 'seller', record.principal, 'Escrow → Seller (principal)');
        transferMoney('escrow', 'platform', record.fee, 'Escrow → Platform (fee)');
      } else {
        // BALANCE TRANSFER: Escrow refunds total (principal + fee) to Buyer
        transferMoney('escrow', 'buyer', record.total, 'Escrow → Buyer (refund)');
      }

      const payoutReceipt = genPayout();
      const newStatus: SettlementStatus = finalOutcome === 'SUCCESS' ? 'RELEASED' : 'REFUNDED';
      await updateSettlementRecord(tradeId, {
        status: newStatus,
        payoutReceipt,
        payoutAt: nowIso(),
      });
      logger.info('=== [AUTO-RUN COMPLETE] Settlement finished', { tradeId, status: newStatus, receipt: payoutReceipt });

    } catch (error: any) {
      logger.error('=== [AUTO-RUN ERROR] Settlement simulation failed', { tradeId, error: error.message });
    }
  })();
});

/**
 * POST /api/settlement/reset - Clear settlement records (demo reset)
 */
router.post('/api/settlement/reset', async (req: Request, res: Response) => {
  await prisma.settlementRecord.deleteMany({});
  logger.info('Cleared settlement_records for demo reset');
  res.json({ status: 'ok' });
});

/**
 * DELETE /api/transactions - Clear all in-memory transactions
 */
router.delete('/api/transactions', async (req: Request, res: Response) => {
  const transactions = await getAllTransactions();
  const count = transactions.length;
  await clearAllTransactions();
  logger.info(`Cleared ${count} transactions from Redis`);
  res.json({ status: 'ok', cleared: count });
});

// ==================== DEMO ACCOUNT ENDPOINTS ====================

/**
 * GET /api/demo/accounts - Get all demo account balances and transactions
 */
router.get('/api/demo/accounts', (req: Request, res: Response) => {
  const accounts = getAllDemoAccounts();
  const transactions = getAllDemoTransactions();
  res.json({ accounts, transactions });
});

/**
 * GET /api/demo/accounts/:id - Get specific demo account
 */
router.get('/api/demo/accounts/:id', (req: Request, res: Response) => {
  const account = getDemoAccount(req.params.id);
  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }
  res.json({ account });
});

/**
 * GET /api/demo/transactions - Get transaction history
 */
router.get('/api/demo/transactions', (req: Request, res: Response) => {
  const transactions = getAllDemoTransactions();
  res.json({ transactions });
});

/**
 * POST /api/demo/accounts/reset - Reset all demo accounts to initial balances
 */
router.post('/api/demo/accounts/reset', (req: Request, res: Response) => {
  initializeDemoAccounts();
  const accounts = getAllDemoAccounts();
  res.json({ status: 'ok', message: 'Demo accounts reset to initial balances', accounts });
});

/**
 * POST /api/demo/reset-all - Reset everything for a fresh demo
 */
router.post('/api/demo/reset-all', async (req: Request, res: Response) => {
  // Reset in-memory transactions
  await clearAllTransactions();

  // Reset demo accounts
  initializeDemoAccounts();

  logger.info('=== DEMO RESET === All data cleared, accounts reset');

  res.json({
    status: 'ok',
    message: 'Full demo reset complete',
    accounts: getAllDemoAccounts(),
  });
});

/**
 * POST /api/db/reset - Full database reset (clears all trading data)
 * WARNING: This will delete all orders, offers, items, and reset user balances
 */
router.post('/api/db/reset', async (req: Request, res: Response) => {
  try {
    logger.info('=== DATABASE RESET STARTED ===');

    // Clear in correct order for foreign key constraints
    const deleteCounts = {
      offerBlocks: 0,
      paymentRecords: 0,
      orders: 0,
      events: 0,
      catalogOffers: 0,
      catalogItems: 0,
      settlementRecords: 0,
      discomFeedback: 0,
      trustScoreHistory: 0,
    };

    // 1. Clear offer blocks
    const blocks = await prisma.offerBlock.deleteMany();
    deleteCounts.offerBlocks = blocks.count;

    // 2. Clear payment records
    const payments = await prisma.paymentRecord.deleteMany();
    deleteCounts.paymentRecords = payments.count;

    // 3. Clear DISCOM feedback
    const feedback = await prisma.discomFeedback.deleteMany();
    deleteCounts.discomFeedback = feedback.count;

    // 4. Clear orders
    const orders = await prisma.order.deleteMany();
    deleteCounts.orders = orders.count;

    // 5. Clear events
    const events = await prisma.event.deleteMany();
    deleteCounts.events = events.count;

    // 6. Clear catalog offers
    const offers = await prisma.catalogOffer.deleteMany();
    deleteCounts.catalogOffers = offers.count;

    // 7. Clear catalog items
    const items = await prisma.catalogItem.deleteMany();
    deleteCounts.catalogItems = items.count;

    // 8. Clear settlement records
    const settlements = await prisma.settlementRecord.deleteMany();
    deleteCounts.settlementRecords = settlements.count;

    // 9. Clear trust score history
    const trustHistory = await prisma.trustScoreHistory.deleteMany();
    deleteCounts.trustScoreHistory = trustHistory.count;

    // 10. Reset user balances, trust scores, and meter verification (but keep accounts)
    await prisma.user.updateMany({
      data: {
        balance: 1000, // Reset to default balance
        trustScore: 0.5, // Reset to default trust
        allowedTradeLimit: 10,
        productionCapacity: null, // Reset to null (not 0) so UI doesn't render "0"
        meterVerifiedCapacity: null, // Reset meter verification
        meterDataAnalyzed: false, // Reset meter analyzed flag
        meterPdfUrl: null, // Clear uploaded PDF
        providerId: null, // Unlink providers (they were deleted)
      },
    });

    // 11. Clear providers
    const providers = await prisma.provider.deleteMany();

    // 12. Clear Redis transaction states
    await clearAllTransactions();

    // 13. Reset demo accounts
    initializeDemoAccounts();

    // 14. Clean up uploaded meter PDF files
    try {
      const fs = await import('fs');
      const path = await import('path');
      const uploadsDir = path.join(process.cwd(), 'uploads', 'meter-pdfs');
      if (fs.existsSync(uploadsDir)) {
        const files = fs.readdirSync(uploadsDir);
        for (const file of files) {
          fs.unlinkSync(path.join(uploadsDir, file));
        }
        logger.info(`Cleared ${files.length} meter PDF files from uploads`);
      }
    } catch (cleanupErr: any) {
      logger.warn(`Could not clean meter PDFs: ${cleanupErr.message}`);
    }

    logger.info('=== DATABASE RESET COMPLETE ===', deleteCounts);

    res.json({
      status: 'ok',
      message: 'Database reset complete',
      deleted: deleteCounts,
      providersDeleted: providers.count,
    });
  } catch (error: any) {
    logger.error(`Database reset failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ==================== VERIFIABLE CREDENTIALS ENDPOINTS ====================

/**
 * POST /api/vc/verify - Verify a Verifiable Credential
 * Accepts raw VC JSON and returns verification result
 */
router.post('/api/vc/verify', async (req: Request, res: Response) => {
  const { credential, options } = req.body as {
    credential?: unknown;
    options?: VerificationOptions;
  };

  if (!credential) {
    return res.status(400).json({ error: 'credential is required in request body' });
  }

  try {
    const result = await verifyCredential(credential, options);

    logger.info('VC verification completed', {
      verified: result.verified,
      credentialId: result.credentialId,
      issuer: result.issuer,
      checksRun: result.checks.length,
      checksFailed: result.checks.filter(c => c.status === 'failed').length,
    });

    res.json({
      status: 'ok',
      result,
    });
  } catch (error: any) {
    logger.error(`VC verification failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/vc/verify-json - Verify a VC from JSON string
 * Useful when receiving VC as a string (e.g., from file upload)
 */
router.post('/api/vc/verify-json', async (req: Request, res: Response) => {
  const { json, options } = req.body as {
    json?: string;
    options?: VerificationOptions;
  };

  if (!json || typeof json !== 'string') {
    return res.status(400).json({ error: 'json string is required in request body' });
  }

  try {
    const result = await parseAndVerifyCredential(json, options);

    logger.info('VC JSON verification completed', {
      verified: result.verified,
      credentialId: result.credentialId,
    });

    res.json({
      status: 'ok',
      result,
    });
  } catch (error: any) {
    logger.error(`VC JSON verification failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/vc/verify-generation-profile - Verify a Generation Profile VC
 * Specialized endpoint for energy generation credentials
 */
router.post('/api/vc/verify-generation-profile', async (req: Request, res: Response) => {
  const { credential, expectedProviderId, options } = req.body as {
    credential?: unknown;
    expectedProviderId?: string;
    options?: VerificationOptions;
  };

  if (!credential) {
    return res.status(400).json({ error: 'credential is required in request body' });
  }

  try {
    const result = await verifyGenerationProfile(credential, options);

    // If provider ID verification is requested, add that check
    if (expectedProviderId && result.verified) {
      const providerCheck = validateProviderMatch(
        credential as VerifiableCredential,
        expectedProviderId
      );
      result.checks.push(providerCheck);

      // Update verified status if provider check failed
      if (providerCheck.status === 'failed') {
        result.verified = false;
        result.error = 'Provider ID mismatch';
      }
    }

    logger.info('Generation Profile VC verification completed', {
      verified: result.verified,
      credentialId: result.credentialId,
      providerId: result.generationProfile?.providerId,
      sourceType: result.generationProfile?.sourceType,
      capacityKW: result.generationProfile?.installedCapacityKW,
    });

    res.json({
      status: 'ok',
      result,
      generationProfile: result.generationProfile,
    });
  } catch (error: any) {
    logger.error(`Generation Profile verification failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/vc/verify-and-settle/:tradeId - Verify VC and update settlement
 * Combines VC verification with settlement outcome update
 */
router.post('/api/vc/verify-and-settle/:tradeId', async (req: Request, res: Response) => {
  const { tradeId } = req.params;
  const { credential, options } = req.body as {
    credential?: unknown;
    options?: VerificationOptions;
  };

  if (!credential) {
    return res.status(400).json({ error: 'credential is required in request body' });
  }

  // Get settlement record
  const record = await getSettlementRecord(tradeId);
  if (!record) {
    return res.status(404).json({ error: 'Settlement record not found', status: 'ERROR_NO_RECORD' });
  }

  if (record.status === 'RELEASED' || record.status === 'REFUNDED') {
    return res.json({
      status: 'ok',
      message: 'Settlement already completed',
      record,
    });
  }

  if (record.status !== 'FUNDED') {
    return res.status(400).json({ error: 'Escrow not funded yet - cannot verify' });
  }

  try {
    // Verify the credential
    const verificationResult = await verifyCredential(credential, options);
    const vc = credential as VerifiableCredential;

    // Determine settlement outcome based on verification
    const outcome: SettlementOutcome = verificationResult.verified ? 'SUCCESS' : 'FAIL';

    // Check if settlement has expired
    const expired = new Date(record.expiresAt!).getTime() < Date.now();
    if (expired) {
      await updateSettlementRecord(tradeId, { status: 'ERROR_EXPIRED' });
      const updated = await getSettlementRecord(tradeId);
      return res.status(400).json({
        error: 'Settlement expired',
        record: updated,
        status: 'ERROR_EXPIRED',
        verificationResult,
      });
    }

    // Update settlement with VC verification info
    await updateSettlementRecord(tradeId, {
      verificationOutcome: outcome,
      verifiedAt: nowIso(),
      // Store VC metadata in the existing fields (we'll extend schema later)
    });

    // Also store VC details via separate update for the new fields
    try {
      await prisma.settlementRecord.update({
        where: { tradeId },
        data: {
          vcId: vc.id || `vc-${Date.now()}`,
          vcIssuer: getIssuerId(vc.issuer),
          vcVerifiedAt: new Date().toISOString(),
          vcClaims: JSON.stringify(verificationResult.claims || {}),
        },
      });
    } catch (e) {
      // Fields may not exist yet if migration hasn't run
      logger.warn('Could not store VC metadata - schema may need migration');
    }

    const updated = await getSettlementRecord(tradeId);

    logger.info('=== [VC SETTLEMENT] Verification complete', {
      tradeId,
      outcome,
      vcVerified: verificationResult.verified,
      vcId: vc.id,
      issuer: getIssuerId(vc.issuer),
    });

    res.json({
      status: 'ok',
      tradeId,
      outcome,
      verificationResult,
      record: updated,
      payout: buildPayoutInstruction(updated!, outcome),
      steps: buildPaymentSteps(updated),
    });
  } catch (error: any) {
    logger.error(`VC settlement verification failed: ${error.message}`, { tradeId });
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/vc/schemas - Get information about supported VC schemas
 */
router.get('/api/vc/schemas', (req: Request, res: Response) => {
  res.json({
    schemas: [
      {
        type: 'GenerationProfileCredential',
        description: 'Energy generation profile credential for prosumers/providers',
        requiredClaims: ['providerId', 'installedCapacityKW', 'sourceType', 'gridConnectionStatus'],
        optionalClaims: ['providerName', 'authorizedCapacityKW', 'meterId', 'distributionUtility', 'location', 'certifications'],
        contextUrl: 'https://github.com/nfh-trust-labs/vc-schemas/tree/ies-vcs/energy-credentials/generation-profile-vc',
      },
      {
        type: 'GridConnectionCredential',
        description: 'Grid connection credential for energy assets',
        requiredClaims: ['connectionId', 'meterId', 'sanctionedLoad', 'distributionUtility', 'connectionType', 'voltageLevel', 'phaseType', 'tariffCategory', 'status'],
        optionalClaims: ['contractDemand', 'division', 'circle', 'billingCycle', 'connectionDate'],
        contextUrl: 'https://github.com/India-Energy-Stack/ies-specs/tree/main/energy-credentials',
      },
    ],
    verificationEndpoints: {
      verify: 'POST /api/vc/verify',
      verifyJson: 'POST /api/vc/verify-json',
      verifyGenerationProfile: 'POST /api/vc/verify-generation-profile',
      verifyAndSettle: 'POST /api/vc/verify-and-settle/:tradeId',
    },
    vcPortal: config.external.vcPortal,
  });
});

/**
 * GET /api/my-orders - Get orders for the authenticated buyer
 */
router.get('/api/my-orders', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const orders = await (prisma.order as any).findMany({
      where: { buyerId: userId },
      orderBy: { createdAt: 'desc' },
      include: {
        provider: true,
        selectedOffer: {
          include: {
            item: true,
          },
        },
        blocks: {
          include: {
            provider: true,
            offer: true,
          },
        },
      },
    });

    // Transform to API format - need to use Promise.all since we may need async
    // lookups
    const formattedOrders = await Promise.all(orders.map(async (order: any) => {
      let items: any[] = [];
      let quote: any = {};

      try {
        items = JSON.parse(order.itemsJson || '[]');
      } catch {
        items = [];
      }

      try {
        quote = JSON.parse(order.quoteJson || '{}');
      } catch {
        quote = {};
      }

      const selectedOffer = order.selectedOffer;
      const totalQty = order.totalQty || items[0]?.quantity?.value || 0;

      // Detect bulk order: multiple items or multiple unique providers in blocks
      const isBulkOrder = items.length > 1 || (order.blocks && new Set(order.blocks.map((b: any) => b.providerId)).size > 1);
      const totalItemCount = items.length;

      // Get all unique providers from blocks (for bulk orders)
      const providersMap = new Map<string, { id: string; name: string }>();
      if (order.blocks && order.blocks.length > 0) {
        for (const block of order.blocks) {
          if (block.provider && !providersMap.has(block.provider.id)) {
            providersMap.set(block.provider.id, {
              id: block.provider.id,
              name: block.provider.name,
            });
          }
        }
      }
      // Fallback to order.provider if no blocks
      if (providersMap.size === 0 && order.provider) {
        providersMap.set(order.provider.id, {
          id: order.provider.id,
          name: order.provider.name,
        });
      }
      const providers = Array.from(providersMap.values());

      // Calculate price_per_kwh: prefer offer value, fallback to calculating
      // from quote
      let pricePerKwh = selectedOffer?.priceValue || 0;
      if (pricePerKwh === 0 && quote.price?.value && totalQty > 0) {
        pricePerKwh = quote.price.value / totalQty;
      }

      // For bulk orders, calculate average price from blocks
      if (isBulkOrder && order.blocks && order.blocks.length > 0) {
        const totalBlockPrice = order.blocks.reduce((sum: number, b: any) => sum + (b.priceValue || 0), 0);
        const blockCount = order.blocks.length;
        if (blockCount > 0) {
          pricePerKwh = totalBlockPrice / blockCount;
        }
      }

      // Get source_type: prefer offer, then stored items, then lookup from catalog
      // For bulk orders, collect all unique source types
      let sourceType = selectedOffer?.item?.sourceType || items[0]?.source_type;
      const sourceTypes = new Set<string>();

      if (isBulkOrder && items.length > 0) {
        for (const item of items) {
          if (item.source_type && item.source_type !== 'UNKNOWN') {
            sourceTypes.add(item.source_type);
          }
        }
      }

      if ((!sourceType || sourceType === 'UNKNOWN') && sourceTypes.size === 0) {
        // Fallback: lookup from catalog item directly
        const itemId = items[0]?.item_id || selectedOffer?.itemId;
        if (itemId) {
          const catalogItem = await prisma.catalogItem.findUnique({
            where: { id: itemId },
            select: { sourceType: true },
          });
          sourceType = catalogItem?.sourceType || 'UNKNOWN';
        }
      }

      // For bulk orders with mixed sources, show 'MIXED'
      if (sourceTypes.size > 1) {
        sourceType = 'MIXED';
      } else if (sourceTypes.size === 1) {
        sourceType = Array.from(sourceTypes)[0];
      }

      // An order is part of a bulk purchase if it has a bulkGroupId
      const isPartOfBulkPurchase = !!order.bulkGroupId;

      return {
        id: order.id,
        status: order.status,
        created_at: order.createdAt.toISOString(),
        quote: quote.price ? {
          price: quote.price,
          totalQuantity: totalQty,
        } :
          undefined,
        paymentStatus: order.paymentStatus || 'PENDING',
        cancellation: order.status === 'CANCELLED' ? {
          cancelledAt: order.cancelledAt?.toISOString(),
          cancelledBy: order.cancelledBy,
          reason: order.cancelReason,
          penalty: order.cancelledBy?.startsWith('SELLER:') ? null : order.cancelPenalty,
          refund: order.cancelRefund,
        } : undefined,
        // For single-offer orders, return single provider; for bulk, return first provider
        provider: providers.length > 0 ? providers[0] : undefined,
        // For bulk orders, return all providers
        providers: isBulkOrder ? providers : undefined,
        itemInfo: {
          item_id: items[0]?.item_id || selectedOffer?.itemId || null,
          offer_id: items[0]?.offer_id || order.selectedOfferId || null,
          source_type: sourceType || 'UNKNOWN',
          price_per_kwh: pricePerKwh,
          quantity: totalQty,
        },
        // Bulk order info - isBulkOrder means single order with multiple items (legacy)
        // isPartOfBulkPurchase means this is one of multiple separate orders from bulk buy
        isBulkOrder,
        isPartOfBulkPurchase,
        bulkGroupId: order.bulkGroupId || undefined,
        totalItemCount: isBulkOrder ? totalItemCount : undefined,
        totalProviderCount: isBulkOrder ? providers.length : undefined,
      };
    }));

    res.json({ orders: formattedOrders });
  } catch (error: any) {
    logger.error(`Failed to get buyer orders: ${error.message}`);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

/**
 * POST /api/cancel - Cancel an order (buyer-initiated)
 * 
 * Business logic:
 * - Buyer can cancel ACTIVE orders before DISCOM verification
 * - Escrowed funds are refunded to buyer
 * - Blocks are released back to available inventory
 * - Seller is notified via order status update
 */
router.post('/api/cancel', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { transaction_id, order_id, reason } = req.body;
    const buyerId = req.user!.id;

    if (!order_id && !transaction_id) {
      return res.status(400).json({
        status: 'error',
        error: 'Either order_id or transaction_id is required',
      });
    }

    // Find the order
    let order;
    if (order_id) {
      order = await prisma.order.findUnique({
        where: { id: order_id },
        include: {
          payments: true,
          blocks: true,
        },
      });
    } else if (transaction_id) {
      order = await prisma.order.findFirst({
        where: { transactionId: transaction_id },
        include: {
          payments: true,
          blocks: true,
        },
      });
    }

    if (!order) {
      return res.status(404).json({
        status: 'error',
        error: 'Order not found',
      });
    }

    // Verify the buyer owns this order
    if (order.buyerId !== buyerId) {
      return res.status(403).json({
        status: 'error',
        error: 'You can only cancel your own orders',
      });
    }

    // Check if order can be cancelled
    const cancelableStatuses = ['ACTIVE', 'PENDING', 'INITIALIZED'];
    if (!cancelableStatuses.includes(order.status)) {
      return res.status(400).json({
        status: 'error',
        error: `Cannot cancel order with status: ${order.status}. Only ACTIVE, PENDING, or INITIALIZED orders can be cancelled.`,
      });
    }

    // Check if we're within 30 minutes of delivery start time
    // Get delivery start time from the selected offer
    let deliveryStartTime: Date | null = null;
    if (order.selectedOfferId) {
      const selectedOffer = await prisma.catalogOffer.findUnique({
        where: { id: order.selectedOfferId },
        select: { timeWindowStart: true },
      });
      deliveryStartTime = selectedOffer?.timeWindowStart || null;
    }

    // If no selectedOfferId, try to get from order items
    if (!deliveryStartTime) {
      try {
        const items = JSON.parse(order.itemsJson || '[]');
        const firstItem = items[0];
        if (firstItem?.time_window?.start) {
          deliveryStartTime = new Date(firstItem.time_window.start);
        }
      } catch (e) {
        // Ignore parse errors
      }
    }

    // Prevent cancellation within 30 minutes of delivery start
    if (deliveryStartTime) {
      const minCancelBufferMs = 30 * 60 * 1000; // 30 minutes
      const timeUntilDelivery = deliveryStartTime.getTime() - Date.now();

      if (timeUntilDelivery < minCancelBufferMs && timeUntilDelivery > 0) {
        const minutesRemaining = Math.max(0, Math.floor(timeUntilDelivery / 60000));
        return res.status(400).json({
          status: 'error',
          error: `Cancellation not allowed within 30 minutes of delivery start. Only ${minutesRemaining} minutes remaining until delivery.`,
        });
      }
    }

    // Calculate cancellation penalty and seller compensation
    const orderTotal = order.totalPrice || 0;
    const cancellationPenaltyRate = 0.10; // 10% cancellation penalty
    const sellerCompensationRate = 0.05; // 5% goes to seller
    const cancellationPenalty = Math.round(orderTotal * cancellationPenaltyRate * 100) / 100;
    const sellerCompensation = Math.round(orderTotal * sellerCompensationRate * 100) / 100;
    const buyerRefund = orderTotal - cancellationPenalty; // Buyer gets 90% back

    // Start cancellation transaction
    await prisma.$transaction(async (tx) => {
      // 1. Update order status to CANCELLED with penalty info
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledBy: `BUYER:${buyerId}`,
          cancelReason: reason || 'Buyer cancelled',
          cancelPenalty: cancellationPenalty,
          cancelRefund: buyerRefund,
        },
      });

      // 2. Handle payment refund with penalty
      if (order.paymentStatus === 'ESCROWED') {
        const escrowPayment = order.payments.find((p: any) => p.type === 'ESCROW');
        if (escrowPayment) {
          // Refund 90% to buyer (minus cancellation penalty)
          await tx.user.update({
            where: { id: buyerId },
            data: { balance: { increment: buyerRefund } },
          });

          // Pay seller 5% compensation for the cancelled order
          if (escrowPayment.sellerId) {
            await tx.user.update({
              where: { id: escrowPayment.sellerId },
              data: { balance: { increment: sellerCompensation } },
            });
          }

          // Update payment status
          await tx.paymentRecord.update({
            where: { id: escrowPayment.id },
            data: { status: 'REFUNDED' },
          });

          // Create refund record for buyer
          await tx.paymentRecord.create({
            data: {
              type: 'REFUND',
              orderId: order.id,
              buyerId,
              sellerId: escrowPayment.sellerId,
              totalAmount: buyerRefund,
              platformFee: cancellationPenalty - sellerCompensation, // Platform keeps 5%
              status: 'COMPLETED',
              completedAt: new Date(),
            },
          });

          // Create compensation record for seller
          if (escrowPayment.sellerId) {
            await tx.paymentRecord.create({
              data: {
                type: 'CANCEL_COMPENSATION',
                orderId: order.id,
                buyerId,
                sellerId: escrowPayment.sellerId,
                totalAmount: sellerCompensation,
                platformFee: 0,
                status: 'COMPLETED',
                completedAt: new Date(),
              },
            });
          }

          logger.info(`Cancellation processed: buyer refund ${buyerRefund}, seller compensation ${sellerCompensation}`, {
            orderId: order.id,
            totalAmount: orderTotal,
            penalty: cancellationPenalty,
          });
        }

        // Update order payment status
        await tx.order.update({
          where: { id: order.id },
          data: { paymentStatus: 'REFUNDED' },
        });
      }

      // 3. Update buyer trust score (penalty for cancellation)
      const buyer = await tx.user.findUnique({ where: { id: buyerId } });
      if (buyer) {
        const cancelledQty = order.totalQty || 0;
        const trustPenalty = Math.min(0.05, cancelledQty * 0.002); // 0.2% per kWh, max 5%
        const newTrustScore = Math.max(0.1, buyer.trustScore - trustPenalty);
        const newTradeLimit = Math.max(5, Math.round(buyer.allowedTradeLimit * 0.95)); // Reduce by 5%

        await tx.user.update({
          where: { id: buyerId },
          data: {
            trustScore: newTrustScore,
            allowedTradeLimit: newTradeLimit,
          },
        });

        // Record trust history
        await tx.trustScoreHistory.create({
          data: {
            userId: buyerId,
            previousScore: buyer.trustScore,
            newScore: newTrustScore,
            previousLimit: buyer.allowedTradeLimit,
            newLimit: newTradeLimit,
            reason: 'BUYER_CANCEL',
            orderId: order.id,
            metadata: JSON.stringify({
              cancelledQty,
              trustPenalty,
              refundAmount: buyerRefund,
            }),
          },
        });

        logger.info(`Buyer trust updated after cancellation: ${buyer.trustScore.toFixed(3)} → ${newTrustScore.toFixed(3)}`, {
          buyerId,
          orderId: order.id,
        });
      }

      // 3. Release blocks back to available inventory
      await tx.offerBlock.updateMany({
        where: { orderId: order.id },
        data: {
          status: 'AVAILABLE',
          orderId: null,
          transactionId: null,
        },
      });

      logger.info(`Released blocks for cancelled order ${order.id}`);
    });

    // 4. Republish catalog to CDS if we have local offers (non-blocking)
    // Parse items from JSON to get offer_id
    let items: any[] = [];
    try {
      items = JSON.parse(order.itemsJson || '[]');
    } catch (e) {
      // Ignore parse errors
    }
    const firstItem = items[0];
    if (firstItem?.offer_id) {
      (async () => {
        try {
          const offer = await prisma.catalogOffer.findUnique({
            where: { id: firstItem.offer_id },
            include: { item: true },
          });
          if (offer && offer.item) {
            logger.info('Republishing catalog after order cancellation', {
              offerId: offer.id,
            });
            // Note: Full catalog republish happens in seller-routes.ts cancellation handlers
          }
        } catch (err: any) {
          logger.error(`Failed to republish after cancel: ${err.message}`);
        }
      })();
    }

    logger.info(`Order ${order.id} cancelled by buyer ${buyerId}`, {
      reason: reason || 'No reason provided',
    });

    res.json({
      status: 'success',
      message: 'Order cancelled successfully. Escrowed funds have been refunded.',
      order_id: order.id,
    });
  } catch (error: any) {
    logger.error(`Failed to cancel order: ${error.message}`);
    res.status(500).json({
      status: 'error',
      error: 'Failed to cancel order',
    });
  }
});

// ==================== Diagnostic Endpoint (temporary) ====================

interface DiagnosticTest {
  name: string;
  endpoint: string;
  method: string;
  category: 'internal' | 'external' | 'protocol' | 'auth';
  status: number | null;
  ok: boolean;
  latencyMs: number;
  requestBody?: any; // Added for debugging
  response?: string;
  error?: string;
  hint?: string;
}

router.get('/api/diagnosis', async (req: Request, res: Response) => {
  const requestId = `diag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Use localhost for self-calls to avoid going through the public proxy (which deadlocks)
  const localBase = `http://localhost:${config.ports.bap}`;
  const ledgerUrl = config.external.ledger;
  const cdsUrl = config.cds.uri;
  const vcUrl = config.external.vcPortal;

  function getHint(name: string, status: number | null, error?: string): string | undefined {
    if (error === 'ECONNREFUSED') return 'Service is not running or port is blocked';
    if (error === 'ETIMEDOUT' || error === 'ECONNABORTED') return 'Service is slow or unreachable — check network/firewall';
    if (status === 401) return 'Authentication failed — check API keys or session tokens';
    if (status === 403) return 'Access denied — check permissions and CORS settings';
    if (status === 404) return 'Endpoint not found — check URL configuration';
    if (status === 500) return 'Server error — check service logs for details';
    if (name.includes('CDS') && status === 401) return 'CDS auth failed — check BECKN signing keys are registered in DEDI';
    if (name.includes('Ledger') && !status) return 'DEG Ledger unreachable — check LEDGER_URL env var';
    return undefined;
  }

  async function test(
    name: string,
    endpoint: string,
    method: 'GET' | 'POST',
    url: string,
    category: DiagnosticTest['category'] = 'internal',
    body?: any,
    headers?: Record<string, string>
  ): Promise<DiagnosticTest> {
    const start = Date.now();
    try {
      // For external endpoints (CDS, Ledger), use signed headers like ONIX
      let finalHeaders: Record<string, string> = { 'Content-Type': 'application/json', ...headers };
      if (category === 'external' && method === 'POST' && body) {
        const keyPair = getKeyPair();
        if (keyPair) {
          const signedHeaders = createSignedHeaders(body, keyPair);
          finalHeaders = { ...finalHeaders, ...signedHeaders };
        }
      }

      const resp = method === 'GET'
        ? await axios.get(url, { timeout: 8000, headers: finalHeaders, validateStatus: () => true })
        : await axios.post(url, body, { timeout: 8000, headers: finalHeaders, validateStatus: () => true });
      const latency = Date.now() - start;
      const responseStr = typeof resp.data === 'string' ? resp.data.substring(0, 300) : JSON.stringify(resp.data).substring(0, 300);
      const ok = resp.status >= 200 && resp.status < 300;
      return { name, endpoint, method, category, status: resp.status, ok, latencyMs: latency, requestBody: body, response: responseStr, hint: ok ? undefined : getHint(name, resp.status) };
    } catch (err: any) {
      const hint = getHint(name, null, err.code || err.message);
      return { name, endpoint, method, category, status: null, ok: false, latencyMs: Date.now() - start, requestBody: body, error: err.code || err.message, hint };
    }
  }

  // Generate valid UUIDs for CDS schema validation
  const diagMsgId = crypto.randomUUID();
  const diagTxnId = crypto.randomUUID();

  const becknCtx = {
    version: '2.0.0', action: 'select', timestamp: new Date().toISOString(),
    message_id: diagMsgId, transaction_id: diagTxnId,
    bap_id: config.bap.id, bap_uri: config.bap.uri, bpp_id: config.bpp.id, bpp_uri: config.bpp.uri,
    ttl: 'PT30S', domain: 'beckn.one:deg:p2p-trading-interdiscom:2.0.0',
  };

  // --- Auth status check ---
  const authToken = req.headers.authorization?.replace('Bearer ', '');
  let authStatus: { authenticated: boolean; userId?: string; userName?: string; sessionExpiry?: string; error?: string } = { authenticated: false };
  if (authToken) {
    try {
      const session = await prisma.session.findFirst({
        where: { token: authToken, expiresAt: { gt: new Date() } },
        include: { user: { select: { id: true, name: true, trustScore: true, profileComplete: true } } },
      });
      if (session?.user) {
        authStatus = {
          authenticated: true,
          userId: session.user.id,
          userName: session.user.name || undefined,
          sessionExpiry: session.expiresAt.toISOString(),
        };
      } else {
        authStatus = { authenticated: false, error: authToken ? 'Session expired or invalid' : 'No token provided' };
      }
    } catch {
      authStatus = { authenticated: false, error: 'Auth check failed' };
    }
  }

  // --- DB connectivity check ---
  let dbStatus: { ok: boolean; latencyMs: number; error?: string } = { ok: false, latencyMs: 0 };
  {
    const start = Date.now();
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbStatus = { ok: true, latencyMs: Date.now() - start };
    } catch (err: any) {
      dbStatus = { ok: false, latencyMs: Date.now() - start, error: err.message };
    }
  }

  // Run ALL tests in parallel to stay within Railway's timeout
  const results = await Promise.all([
    // Internal APIs (via localhost)
    test('Health Check', '/health', 'GET', `${localBase}/health`, 'internal'),
    test('API Discover', '/api/discover', 'POST', `${localBase}/api/discover`, 'internal', {
      quantity: 5, maxPrice: 10,
      requestedTimeWindow: { startTime: new Date(Date.now() + 86400000).toISOString(), endTime: new Date(Date.now() + 86400000 + 14400000).toISOString() },
    }),
    test('API Select (no txn)', '/api/select', 'POST', `${localBase}/api/select`, 'internal', { transaction_id: 'diag-no-txn', quantity: 5 }),
    test('API Init (no txn)', '/api/init', 'POST', `${localBase}/api/init`, 'internal', { transaction_id: 'diag-no-txn' }),
    test('API Confirm (no txn)', '/api/confirm', 'POST', `${localBase}/api/confirm`, 'internal', { transaction_id: 'diag-no-txn' }),
    test('API Status (no txn)', '/api/status', 'POST', `${localBase}/api/status`, 'internal', { transaction_id: 'diag-no-txn' }),

    // Seller Management (via localhost)
    test('Seller Offers', '/seller/offers', 'GET', `${localBase}/seller/offers`, 'internal'),
    test('Seller Items', '/seller/items', 'GET', `${localBase}/seller/items`, 'internal'),
    test('Seller CDS Status', '/seller/cds-status', 'GET', `${localBase}/seller/cds-status`, 'internal'),

    // BPP Protocol (via localhost)
    test('BPP /select', '/select', 'POST', `${localBase}/select`, 'protocol', { context: { ...becknCtx, action: 'select' }, message: { order: { 'beckn:orderItems': [] } } }),
    test('BPP /init', '/init', 'POST', `${localBase}/init`, 'protocol', { context: { ...becknCtx, action: 'init' }, message: { order: { 'beckn:orderItems': [] } } }),
    test('BPP /confirm', '/confirm', 'POST', `${localBase}/confirm`, 'protocol', { context: { ...becknCtx, action: 'confirm' }, message: { order: { 'beckn:orderItems': [] } } }),
    test('BPP /status', '/status', 'POST', `${localBase}/status`, 'protocol', { context: { ...becknCtx, action: 'status' }, message: { order_id: 'diag-order' } }),

    // Callbacks (via localhost)
    test('Callback on_discover', '/callbacks/on_discover', 'POST', `${localBase}/callbacks/on_discover`, 'protocol', { context: { ...becknCtx, action: 'on_discover' }, message: { catalog: { providers: [] } } }),
    test('Callback on_update', '/callbacks/on_update', 'POST', `${localBase}/callbacks/on_update`, 'protocol', { context: { ...becknCtx, action: 'on_update' }, message: { order: { 'beckn:orderStatus': 'INPROGRESS' } } }),

    // External: DEG Ledger (include all required fields per spec)
    test('Ledger /ledger/put', '/ledger/put', 'POST', `${ledgerUrl}/ledger/put`, 'external', {
      role: 'BUYER', transactionId: diagTxnId, orderItemId: `order-${diagTxnId.slice(0, 8)}`,
      platformIdBuyer: config.bap.id, platformIdSeller: config.bpp.id,
      discomIdBuyer: 'DISCOM_BLR', discomIdSeller: 'DISCOM_BLR',
      buyerId: 'diag-buyer', sellerId: 'diag-seller',
      tradeTime: new Date().toISOString(),
      tradeDetails: [{ tradeType: 'ENERGY', tradeQty: 1, tradeUnit: 'KWH' }],
    }),
    test('Ledger /ledger/get', '/ledger/get', 'POST', `${ledgerUrl}/ledger/get`, 'external', { transactionId: diagTxnId, limit: 1 }),

    // External: CDS - Full realistic discover request for debugging
    test('CDS /beckn/discover', '/beckn/discover', 'POST', `${cdsUrl}/discover`, 'external', {
      context: {
        ...becknCtx,
        action: 'discover',
        bpp_id: undefined,
        bpp_uri: undefined,
        location: {
          city: { code: 'BLR', name: 'Bangalore' },
          country: { code: 'IND', name: 'India' },
        },
        schema_context: [
          'https://raw.githubusercontent.com/beckn/protocol-specifications-new/refs/heads/p2p-trading/schema/EnergyResource/v0.2/context.jsonld',
        ],
      },
      message: {
        filters: {
          type: 'jsonpath',
          expression: "$[?('p2p-interdiscom-trading-pilot-network' == @.beckn:networkId)]",
          expressionType: 'jsonpath',
        },
        intent: {
          item: { descriptor: { name: 'Energy' } },
          fulfillment: {
            time: {
              startTime: new Date(Date.now() + 3600000).toISOString(), // +1 hour
              endTime: new Date(Date.now() + 18000000).toISOString(),  // +5 hours
            },
          },
          quantity: { value: 5 },
        },
      },
    }),

    // External: VC Portal
    test('VC Portal reachable', '/', 'GET', vcUrl, 'external'),
  ]);

  const configSnapshot = {
    bapId: config.bap.id,
    bapUri: config.bap.uri,
    bppId: config.bpp.id,
    bppUri: config.bpp.uri,
    cdsUri: config.cds.uri,
    externalCds: config.external.cds,
    ledgerUrl: config.external.ledger,
    vcPortal: config.external.vcPortal,
    enableLedgerWrites: config.external.enableLedgerWrites,
    matchingWeights: config.matching.weights,
    env: config.env.nodeEnv,
  };

  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;

  // Group by category for structured output
  const byCategory = {
    internal: results.filter(r => r.category === 'internal'),
    protocol: results.filter(r => r.category === 'protocol'),
    external: results.filter(r => r.category === 'external'),
  };

  // Identify critical failures
  const criticalFailures = results
    .filter(r => !r.ok && (r.name === 'Health Check' || r.category === 'external'))
    .map(r => ({ name: r.name, error: r.error || `HTTP ${r.status}`, hint: r.hint }));

  res.json({
    requestId,
    timestamp: new Date().toISOString(),
    summary: { total: results.length, passed, failed, health: failed === 0 ? 'HEALTHY' : criticalFailures.length > 0 ? 'DEGRADED' : 'PARTIAL' },
    auth: authStatus,
    database: dbStatus,
    config: configSnapshot,
    criticalFailures: criticalFailures.length > 0 ? criticalFailures : undefined,
    results,
    byCategory,
  });
});

export default router;

