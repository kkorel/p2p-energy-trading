/**
 * Trading Agent — Creates offers and reports earnings/listings for sellers.
 * Supports language-aware responses (English / Hindi).
 */

import { prisma, createLogger, publishOfferToCDS, config, snapTimeWindow, checkTradeWindow, validateQuantity, roundQuantity, checkBuyerCapacity } from '@p2p/shared';
import { registerProvider, addCatalogItem, addOffer } from '../seller-catalog';
import axios from 'axios';

const logger = createLogger('TradingAgent');

/**
 * Helper: Look up provider's user utility info for CDS publishing
 */
async function getProviderUtilityInfo(providerId: string): Promise<{ utilityId: string; utilityCustomerId: string }> {
  try {
    const user = await prisma.user.findFirst({
      where: { providerId },
      select: { consumerNumber: true },
    });
    return {
      utilityId: config.utility.id,
      utilityCustomerId: user?.consumerNumber || 'UNKNOWN',
    };
  } catch {
    return { utilityId: config.utility.id, utilityCustomerId: 'UNKNOWN' };
  }
}

type LangOption = string | undefined;
function ht(lang: LangOption, en: string, hi: string): string {
  return lang === 'hi-IN' ? hi : en;
}

// Translate order status to user-friendly text
function translateStatus(status: string, lang?: string): string {
  const statusMap: Record<string, { en: string; hi: string }> = {
    'PENDING': { en: '⏳ Pending', hi: '⏳ रुका हुआ' },
    'CONFIRMED': { en: '✅ Confirmed', hi: '✅ पक्का' },
    'COMPLETED': { en: '✅ Delivered', hi: '✅ मिल गया' },
    'CANCELLED': { en: '❌ Cancelled', hi: '❌ रद्द' },
    'ACTIVE': { en: '🔵 Active', hi: '🔵 चालू' },
    'FAILED': { en: '❌ Failed', hi: '❌ असफल' },
  };
  const entry = statusMap[status] || { en: status, hi: status };
  return lang === 'hi-IN' ? entry.hi : entry.en;
}

/** Structured listing data for UI card display */
export interface ListingData {
  id: string;
  quantity: number;
  pricePerKwh: number;
  startTime: string;
  endTime: string;
  energyType: string;
}

export interface ListingsCardData {
  listings: ListingData[];
  totalListed: number;
  totalSold: number;
  userName: string;
}

/**
 * Get structured listings data for card display in the frontend.
 */
export async function getActiveListingsData(userId: string): Promise<ListingsCardData | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { providerId: true, name: true },
  });

  if (!user?.providerId) {
    return null;
  }

  const offers = await prisma.catalogOffer.findMany({
    where: { providerId: user.providerId },
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: {
      item: { select: { sourceType: true } },
    },
  });

  // Get total sold from orders
  const orders = await prisma.order.findMany({
    where: {
      providerId: user.providerId,
      status: { in: ['ACTIVE', 'COMPLETED'] },
    },
    select: { totalQty: true },
  });
  const totalSold = orders.reduce((sum, o) => sum + (o.totalQty || 0), 0);
  const totalListed = offers.reduce((sum, o) => sum + o.maxQty, 0);

  return {
    listings: offers.map(o => ({
      id: o.id,
      quantity: o.maxQty,
      pricePerKwh: o.priceValue,
      startTime: o.timeWindowStart.toISOString(),
      endTime: o.timeWindowEnd.toISOString(),
      energyType: o.item?.sourceType || 'SOLAR',
    })),
    totalListed,
    totalSold,
    userName: user.name || 'Seller',
  };
}

export const mockTradingAgent = {
  /**
   * Create a default sell offer for a newly onboarded user.
   */
  async createDefaultOffer(
    userId: string
  ): Promise<{
    success: boolean;
    offer?: { quantity: number; pricePerKwh: number; startTime: string; endTime: string };
    error?: string;
  }> {
    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return { success: false, error: 'User not found' };

      let providerId = user.providerId;
      if (!providerId) {
        const providerName = `${user.name || 'Solar'} Energy`;
        const provider = await registerProvider(providerName);
        providerId = provider.id;
        await prisma.user.update({
          where: { id: userId },
          data: { providerId },
        });
      }

      const capacity = user.productionCapacity || 100;
      const tradeLimit = (capacity * (user.allowedTradeLimit || 10)) / 100;
      const offerQty = Math.max(1, Math.floor(tradeLimit * 0.5));
      const pricePerKwh = 6.0;

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(6, 0, 0, 0);
      const endTime = new Date(tomorrow);
      endTime.setHours(18, 0, 0, 0);

      const item = await addCatalogItem(
        providerId,
        'SOLAR',
        'SCHEDULED',
        offerQty,
        [],
        ''
      );

      const offer = await addOffer(
        item.id,
        providerId,
        pricePerKwh,
        'INR',
        offerQty,
        { startTime: tomorrow.toISOString(), endTime: endTime.toISOString() }
      );

      // Publish to CDS so the offer appears in discovery/buy page
      const providerName = user.name ? `${user.name} Energy` : 'Solar Energy';
      const utilityInfo = await getProviderUtilityInfo(providerId);
      publishOfferToCDS(
        { id: providerId, name: providerName, trust_score: user.trustScore || 0.5 },
        {
          id: item.id,
          provider_id: item.provider_id,
          source_type: item.source_type,
          delivery_mode: item.delivery_mode,
          available_qty: item.available_qty,
          production_windows: item.production_windows,
          meter_id: item.meter_id,
          utility_id: utilityInfo.utilityId,
          utility_customer_id: utilityInfo.utilityCustomerId,
        },
        {
          id: offer.id,
          item_id: offer.item_id,
          provider_id: offer.provider_id,
          price_value: offer.price.value,
          currency: offer.price.currency,
          max_qty: offer.maxQuantity,
          time_window: offer.timeWindow,
          pricing_model: offer.offerAttributes.pricingModel,
          settlement_type: offer.offerAttributes.settlementType,
        }
      ).then(success => {
        if (success) logger.info(`Offer published to CDS`, { offerId: offer.id });
        else logger.warn(`CDS publish returned false`, { offerId: offer.id });
      }).catch(err => logger.error(`Failed to publish offer to CDS`, { offerId: offer.id, error: err.message }));

      logger.info(`Created default offer for user ${userId}: ${offerQty}kWh at Rs${pricePerKwh}/kWh`);

      return {
        success: true,
        offer: {
          quantity: offerQty,
          pricePerKwh,
          startTime: tomorrow.toISOString(),
          endTime: endTime.toISOString(),
        },
      };
    } catch (error: any) {
      logger.error(`Failed to create default offer: ${error.message}`);
      return { success: false, error: error.message };
    }
  },

  /**
   * Create a custom sell offer with user-specified parameters.
   * Falls back to defaults for any missing values.
   */
  async createCustomOffer(
    userId: string,
    options: { pricePerKwh?: number; quantity?: number; timeDesc?: string }
  ): Promise<{
    success: boolean;
    offer?: { quantity: number; pricePerKwh: number; startTime: string; endTime: string };
    error?: string;
  }> {
    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return { success: false, error: 'User not found' };

      let providerId = user.providerId;
      if (!providerId) {
        const providerName = `${user.name || 'Solar'} Energy`;
        const provider = await registerProvider(providerName);
        providerId = provider.id;
        await prisma.user.update({
          where: { id: userId },
          data: { providerId },
        });
      }

      const capacity = user.productionCapacity || 100;
      const tradeLimit = (capacity * (user.allowedTradeLimit || 10)) / 100;
      const maxQty = Math.max(1, Math.floor(tradeLimit));
      const offerQty = options.quantity ? Math.min(options.quantity, maxQty) : Math.max(1, Math.floor(tradeLimit * 0.5));
      const pricePerKwh = options.pricePerKwh || 6.0;

      // Parse time — default to tomorrow 6AM-6PM
      const startTime = new Date();
      startTime.setDate(startTime.getDate() + 1);
      startTime.setHours(6, 0, 0, 0);
      const endTime = new Date(startTime);
      endTime.setHours(18, 0, 0, 0);

      // Adjust if user specified a time like "today"
      if (options.timeDesc) {
        const td = options.timeDesc.toLowerCase();
        if (td.includes('today') || td.includes('aaj')) {
          const now = new Date();
          startTime.setDate(now.getDate());
          endTime.setDate(now.getDate());
          // If already past 6AM, start from next hour
          if (now.getHours() >= 6) {
            startTime.setHours(now.getHours() + 1, 0, 0, 0);
          }
        }
      }

      const item = await addCatalogItem(
        providerId,
        'SOLAR',
        'SCHEDULED',
        offerQty,
        [],
        ''
      );

      const offer = await addOffer(
        item.id,
        providerId,
        pricePerKwh,
        'INR',
        offerQty,
        { startTime: startTime.toISOString(), endTime: endTime.toISOString() }
      );

      // Publish to CDS
      const providerName = user.name ? `${user.name} Energy` : 'Solar Energy';
      const utilityInfo = await getProviderUtilityInfo(providerId);
      publishOfferToCDS(
        { id: providerId, name: providerName, trust_score: user.trustScore || 0.5 },
        {
          id: item.id,
          provider_id: item.provider_id,
          source_type: item.source_type,
          delivery_mode: item.delivery_mode,
          available_qty: item.available_qty,
          production_windows: item.production_windows,
          meter_id: item.meter_id,
          utility_id: utilityInfo.utilityId,
          utility_customer_id: utilityInfo.utilityCustomerId,
        },
        {
          id: offer.id,
          item_id: offer.item_id,
          provider_id: offer.provider_id,
          price_value: offer.price.value,
          currency: offer.price.currency,
          max_qty: offer.maxQuantity,
          time_window: offer.timeWindow,
          pricing_model: offer.offerAttributes.pricingModel,
          settlement_type: offer.offerAttributes.settlementType,
        }
      ).then(success => {
        if (success) logger.info(`Custom offer published to CDS`, { offerId: offer.id });
        else logger.warn(`CDS publish returned false`, { offerId: offer.id });
      }).catch(err => logger.error(`Failed to publish custom offer to CDS`, { offerId: offer.id, error: err.message }));

      logger.info(`Created custom offer for user ${userId}: ${offerQty}kWh at Rs${pricePerKwh}/kWh`);

      return {
        success: true,
        offer: {
          quantity: offerQty,
          pricePerKwh,
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
        },
      };
    } catch (error: any) {
      logger.error(`Failed to create custom offer: ${error.message}`);
      return { success: false, error: error.message };
    }
  },

  /**
   * Get earnings summary for a user.
   */
  async getEarningsSummary(userId: string, lang?: string): Promise<string> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { providerId: true, balance: true, name: true },
    });

    if (!user?.providerId) {
      return ht(lang,
        'You have not started selling yet. Would you like me to set up trading for you?',
        'Aapne abhi tak selling shuru nahi ki. Kya main trading set up kar dun?'
      );
    }

    const completedOrders = await prisma.order.findMany({
      where: {
        providerId: user.providerId,
        status: { in: ['ACTIVE', 'COMPLETED'] },
      },
      select: { totalPrice: true, totalQty: true },
    });

    const totalEarnings = completedOrders.reduce((sum, o) => sum + (o.totalPrice || 0), 0);
    const totalKwh = completedOrders.reduce((sum, o) => sum + (o.totalQty || 0), 0);
    const name = user.name || ht(lang, 'friend', 'dost');

    if (completedOrders.length === 0) {
      return ht(lang,
        `No sales yet, ${name}. Your offers are live and waiting for buyers! Wallet: Rs ${user.balance.toFixed(2)}.`,
        `अभी तक कोई बिक्री नहीं हुई, ${name}। आपके ऑफर लाइव हैं, खरीदारों का इंतज़ार कर रहे हैं! वॉलेट: ₹${user.balance.toFixed(2)}`
      );
    }

    return ht(lang,
      `Your earnings, ${name}:\n- Orders: ${completedOrders.length}\n- Energy sold: ${totalKwh.toFixed(1)} kWh\n- Earnings: Rs ${totalEarnings.toFixed(2)}\n- Wallet: Rs ${user.balance.toFixed(2)}`,
      `आपकी कमाई, ${name}:\n- ऑर्डर: ${completedOrders.length}\n- एनर्जी बेची: ${totalKwh.toFixed(1)} kWh\n- कमाई: ₹${totalEarnings.toFixed(2)}\n- वॉलेट: ₹${user.balance.toFixed(2)}`
    );
  },

  /**
   * Get structured earnings data for EarningsCard UI.
   */
  async getEarningsData(userId: string): Promise<{
    userName: string;
    hasStartedSelling: boolean;
    totalOrders: number;
    totalEnergySold: number;
    totalEarnings: number;
    walletBalance: number;
  } | null> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { providerId: true, balance: true, name: true },
    });

    if (!user) return null;

    const userName = user.name || 'Friend';

    if (!user.providerId) {
      return {
        userName,
        hasStartedSelling: false,
        totalOrders: 0,
        totalEnergySold: 0,
        totalEarnings: 0,
        walletBalance: user.balance,
      };
    }

    const completedOrders = await prisma.order.findMany({
      where: {
        providerId: user.providerId,
        status: { in: ['ACTIVE', 'COMPLETED'] },
      },
      select: { totalPrice: true, totalQty: true },
    });

    const totalEarnings = completedOrders.reduce((sum, o) => sum + (o.totalPrice || 0), 0);
    const totalKwh = completedOrders.reduce((sum, o) => sum + (o.totalQty || 0), 0);

    return {
      userName,
      hasStartedSelling: true,
      totalOrders: completedOrders.length,
      totalEnergySold: totalKwh,
      totalEarnings,
      walletBalance: user.balance,
    };
  },

  /**
   * Get order status summary.
   */
  async getOrdersSummary(userId: string, lang?: string): Promise<string> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { providerId: true, name: true, id: true },
    });

    // Check as seller
    if (user?.providerId) {
      const orders = await prisma.order.findMany({
        where: { providerId: user.providerId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, status: true, totalQty: true, totalPrice: true, createdAt: true },
      });

      if (orders.length > 0) {
        const lines = orders.map(
          (o, i) =>
            `${i + 1}. ${o.totalQty || 0} kWh — Rs ${(o.totalPrice || 0).toFixed(2)} — ${translateStatus(o.status, lang)}`
        );
        return ht(lang,
          `Your recent orders (as seller):\n${lines.join('\n')}`,
          `Aapke recent orders (seller):\n${lines.join('\n')}`
        );
      }
    }

    // Check as buyer
    const buyerOrders = await prisma.order.findMany({
      where: { buyerId: userId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, status: true, totalQty: true, totalPrice: true, createdAt: true },
    });

    if (buyerOrders.length > 0) {
      const lines = buyerOrders.map(
        (o, i) =>
          `${i + 1}. ${o.totalQty || 0} kWh — Rs ${(o.totalPrice || 0).toFixed(2)} — ${translateStatus(o.status, lang)}`
      );
      return ht(lang,
        `Your recent orders (as buyer):\n${lines.join('\n')}`,
        `Aapke recent orders (buyer):\n${lines.join('\n')}`
      );
    }

    return ht(lang,
      'No orders yet. Your offers are live — buyers will find them soon!',
      'Abhi tak koi order nahi. Aapke offers live hain — jaldi buyers aayenge!'
    );
  },

  /**
   * Get active listings (catalog offers) for a seller.
   * Also shows total listed vs sold summary.
   */
  async getActiveListings(userId: string, lang?: string): Promise<string> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { providerId: true, name: true },
    });

    if (!user?.providerId) {
      return ht(lang,
        'You have no listings yet. Would you like me to create one?',
        'आपकी कोई लिस्टिंग नहीं है। क्या मैं एक बना दूं?'
      );
    }

    const offers = await prisma.catalogOffer.findMany({
      where: { providerId: user.providerId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        maxQty: true,
        priceValue: true,
        timeWindowStart: true,
        timeWindowEnd: true,
        createdAt: true,
      },
    });

    // Get total sold from orders
    const orders = await prisma.order.findMany({
      where: {
        providerId: user.providerId,
        status: { in: ['ACTIVE', 'COMPLETED'] },
      },
      select: { totalQty: true },
    });
    const totalSold = orders.reduce((sum, o) => sum + (o.totalQty || 0), 0);

    if (offers.length === 0) {
      return ht(lang,
        'No active listings. Would you like me to create an offer?',
        'Koi active listing nahi. Kya main ek offer bana dun?'
      );
    }

    const totalListed = offers.reduce((sum, o) => sum + o.maxQty, 0);
    const lines = offers.map((o, i) => {
      const start = new Date(o.timeWindowStart).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      const startTime = new Date(o.timeWindowStart).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
      const endTime = new Date(o.timeWindowEnd).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
      return `${i + 1}. ${o.maxQty} kWh @ Rs ${o.priceValue}/unit — ${start} ${startTime}-${endTime}`;
    });

    return ht(lang,
      `Your listings (${offers.length}):\nTotal listed: ${totalListed} kWh | Sold: ${totalSold} kWh\n\n${lines.join('\n')}`,
      `आपकी लिस्टिंग (${offers.length}):\nकुल लिस्टेड: ${totalListed} यूनिट | बिका: ${totalSold} यूनिट\n\n${lines.join('\n')}`
    );
  },

  /**
   * Get sales summary for a specific time period.
   */
  async getSalesByPeriod(userId: string, startDate: Date, endDate: Date, periodLabel: string, lang?: string): Promise<string> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { providerId: true, name: true },
    });

    if (!user?.providerId) {
      return ht(lang,
        'You have not started selling yet.',
        'Aapne abhi tak selling shuru nahi ki.'
      );
    }

    const orders = await prisma.order.findMany({
      where: {
        providerId: user.providerId,
        status: { in: ['ACTIVE', 'COMPLETED'] },
        createdAt: { gte: startDate, lte: endDate },
      },
      select: { totalPrice: true, totalQty: true },
    });

    const totalEarnings = orders.reduce((sum, o) => sum + (o.totalPrice || 0), 0);
    const totalKwh = orders.reduce((sum, o) => sum + (o.totalQty || 0), 0);

    if (orders.length === 0) {
      return ht(lang,
        `No sales ${periodLabel}.`,
        `${periodLabel} mein koi sale nahi hui.`
      );
    }

    return ht(lang,
      `Sales ${periodLabel}:\n- ${orders.length} order(s)\n- ${totalKwh.toFixed(1)} kWh sold\n- Rs ${totalEarnings.toFixed(2)} earned`,
      `${periodLabel} ki sales:\n- ${orders.length} order\n- ${totalKwh.toFixed(1)} kWh biki\n- Rs ${totalEarnings.toFixed(2)} kamayi`
    );
  },
};

// --- Buyer-side purchase execution ---

export interface SmartBuyOffer {
  offerId: string;
  providerId: string;
  providerName: string;
  price: number;
  quantity: number;
  subtotal: number;
  timeWindow: string;
}

export interface SmartBuySummary {
  totalQuantity: number;
  totalPrice: number;
  averagePrice: number;
  fullyFulfilled: boolean;
  shortfall: number;
  offersUsed: number;
}

export interface PurchaseResult {
  success: boolean;
  order?: {
    orderId: string;
    transactionId: string;
    quantity: number;
    pricePerKwh: number;
    totalPrice: number;
    providerName: string;
    timeWindow: string;
  };
  // Multi-offer purchase result
  bulkResult?: {
    confirmedCount: number;
    failedCount: number;
  };
  error?: string;
}

export interface DiscoveryResult {
  success: boolean;
  transactionId?: string;
  selectionType?: 'single' | 'multiple';
  // For single offer
  discoveredOffer?: {
    offerId: string;
    providerId: string;
    providerName: string;
    price: number;
    quantity: number;
    timeWindow: string;
  };
  // For smart buy (single or multiple)
  discoveredOffers?: SmartBuyOffer[];
  summary?: SmartBuySummary;
  error?: string;
  // Populated when no eligible offers found — suggests alternative time windows
  availableWindows?: Array<{ startTime: string; endTime: string }>;
  filterReasons?: string[];
  // Auth expired
  authExpired?: boolean;
}

/**
 * Build a time window from a natural language description.
 * Returns { startTime, endTime } ISO strings.
 */
function buildTimeWindow(timeDesc?: string): { startTime: string; endTime: string } {
  const now = new Date();
  const startTime = new Date(now);
  const endTime = new Date(now);

  if (!timeDesc) {
    // Default: tomorrow 6AM-6PM
    startTime.setDate(startTime.getDate() + 1);
    startTime.setHours(6, 0, 0, 0);
    endTime.setDate(endTime.getDate() + 1);
    endTime.setHours(18, 0, 0, 0);
    return { startTime: startTime.toISOString(), endTime: endTime.toISOString() };
  }

  const td = timeDesc.toLowerCase();

  // --- Parse specific hour ranges: "1-6 AM", "6 AM to 6 PM", "2 to 8 PM", "1 se 6 baje" ---
  // Capture AM/PM for both start and end hours separately
  const hourRangeMatch = td.match(
    /(\d{1,2})\s*(am|pm|baje)?\s*(?:-|to|se)\s*(\d{1,2})\s*(am|pm|baje)?/i
  );

  if (hourRangeMatch) {
    let startH = parseInt(hourRangeMatch[1]);
    let endH = parseInt(hourRangeMatch[3]);
    const startSuffix = (hourRangeMatch[2] || '').toLowerCase();
    const endSuffix = (hourRangeMatch[4] || '').toLowerCase();

    // If both start and end have explicit AM/PM, apply individually
    if (startSuffix && endSuffix && startSuffix !== 'baje' && endSuffix !== 'baje') {
      if (startSuffix === 'pm' && startH < 12) startH += 12;
      if (startSuffix === 'am' && startH === 12) startH = 0;
      if (endSuffix === 'pm' && endH < 12) endH += 12;
      if (endSuffix === 'am' && endH === 12) endH = 0;
    } else {
      // Only one or no suffix — use context words to determine AM/PM
      const suffix = endSuffix || startSuffix;
      const hasPm = suffix === 'pm'
        || td.includes('shaam') || td.includes('sham') || td.includes('dopahar')
        || td.includes('evening') || td.includes('afternoon');
      const hasAm = suffix === 'am'
        || td.includes('subah') || td.includes('savere') || td.includes('morning');

      if (hasPm && !hasAm) {
        if (startH < 12) startH += 12;
        if (endH < 12) endH += 12;
      } else if (hasAm && !hasPm) {
        if (startH === 12) startH = 0;
        if (endH === 12) endH = 0;
      }
    }

    const isToday = td.includes('today') || td.includes('aaj');
    const isTomorrow = td.includes('tomorrow') || td.includes('kal');

    // Try to parse an explicit date like "2 Feb 2026", "Feb 2", "3rd March"
    const monthNames: Record<string, number> = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };
    // "2 Feb 2026" or "2nd Feb" or "2 February 2026"
    const dateDMY = td.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*(?:\s+(\d{4}))?/i);
    // "Feb 2" or "February 2, 2026"
    const dateMDY = td.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?/i);
    const dateMatch = dateDMY || dateMDY;

    if (dateMatch) {
      let day: number, month: number, year: number;
      if (dateDMY) {
        day = parseInt(dateDMY[1]);
        month = monthNames[dateDMY[2].substring(0, 3).toLowerCase()];
        year = dateDMY[3] ? parseInt(dateDMY[3]) : now.getFullYear();
      } else {
        month = monthNames[dateMDY![1].substring(0, 3).toLowerCase()];
        day = parseInt(dateMDY![2]);
        year = dateMDY![3] ? parseInt(dateMDY![3]) : now.getFullYear();
      }
      startTime.setFullYear(year, month, day);
      endTime.setFullYear(year, month, day);
      startTime.setHours(startH, 0, 0, 0);
      endTime.setHours(endH, 0, 0, 0);
    } else if (isToday) {
      startTime.setHours(startH, 0, 0, 0);
      endTime.setHours(endH, 0, 0, 0);
      // If the window is already past, fall back to tomorrow
      if (endTime <= now) {
        startTime.setDate(startTime.getDate() + 1);
        endTime.setDate(endTime.getDate() + 1);
      }
    } else if (isTomorrow) {
      startTime.setDate(startTime.getDate() + 1);
      endTime.setDate(endTime.getDate() + 1);
      startTime.setHours(startH, 0, 0, 0);
      endTime.setHours(endH, 0, 0, 0);
    } else {
      // No day specified — default to tomorrow
      startTime.setDate(startTime.getDate() + 1);
      endTime.setDate(endTime.getDate() + 1);
      startTime.setHours(startH, 0, 0, 0);
      endTime.setHours(endH, 0, 0, 0);
    }

    return { startTime: startTime.toISOString(), endTime: endTime.toISOString() };
  }

  // Parse time-of-day keywords: morning, afternoon, evening, night
  let startHour: number | null = null;
  let endHour: number | null = null;
  if (td.includes('morning') || td.includes('subah') || td.includes('savere')) {
    startHour = 6; endHour = 12;
  } else if (td.includes('afternoon') || td.includes('dopahar')) {
    startHour = 12; endHour = 17;
  } else if (td.includes('evening') || td.includes('shaam') || td.includes('sham')) {
    startHour = 17; endHour = 21;
  } else if (td.includes('night') || td.includes('raat')) {
    startHour = 21; endHour = 23;
  }

  const isToday = td.includes('today') || td.includes('aaj');
  const isTomorrow = td.includes('tomorrow') || td.includes('kal');

  // Try to parse an explicit date (e.g. "2 Feb 2026", "Feb 2", "3rd March")
  const kwMonths: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  const kwDateDMY = td.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*(?:\s+(\d{4}))?/i);
  const kwDateMDY = !kwDateDMY ? td.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?/i) : null;
  const kwDateMatch = kwDateDMY || kwDateMDY;

  if (kwDateMatch) {
    let day: number, month: number, year: number;
    if (kwDateDMY) {
      day = parseInt(kwDateDMY[1]);
      month = kwMonths[kwDateDMY[2].substring(0, 3).toLowerCase()];
      year = kwDateDMY[3] ? parseInt(kwDateDMY[3]) : now.getFullYear();
    } else {
      month = kwMonths[kwDateMDY![1].substring(0, 3).toLowerCase()];
      day = parseInt(kwDateMDY![2]);
      year = kwDateMDY![3] ? parseInt(kwDateMDY![3]) : now.getFullYear();
    }
    startTime.setFullYear(year, month, day);
    endTime.setFullYear(year, month, day);
    startTime.setHours(startHour ?? 6, 0, 0, 0);
    endTime.setHours(endHour ?? 18, 0, 0, 0);
  } else if (isToday) {
    const dayStart = startHour != null ? startHour : Math.max(now.getHours() + 1, 6);
    const dayEnd = endHour != null ? endHour : 23;
    startTime.setHours(dayStart, 0, 0, 0);
    endTime.setHours(dayEnd, 59, 59, 0);
    // Guard: if endTime <= startTime (e.g., late at night), fall back to tomorrow
    if (endTime <= startTime) {
      startTime.setDate(startTime.getDate() + 1);
      startTime.setHours(6, 0, 0, 0);
      endTime.setDate(endTime.getDate() + 1);
      endTime.setHours(18, 0, 0, 0);
    }
  } else if (isTomorrow || !startHour) {
    // Default to tomorrow
    startTime.setDate(startTime.getDate() + 1);
    startTime.setHours(startHour ?? 6, 0, 0, 0);
    endTime.setDate(endTime.getDate() + 1);
    endTime.setHours(endHour ?? 18, 0, 0, 0);
  } else {
    // Only time-of-day given, no day — assume tomorrow
    startTime.setDate(startTime.getDate() + 1);
    startTime.setHours(startHour, 0, 0, 0);
    endTime.setDate(endTime.getDate() + 1);
    endTime.setHours(endHour, 0, 0, 0);
  }
  // Snap to 1-hour delivery blocks within 06:00-18:00 per trade rules
  return snapTimeWindow(startTime.toISOString(), endTime.toISOString());
}

/**
 * Get a valid auth token for a user (from their latest session).
 */
async function getUserAuthToken(userId: string): Promise<string | null> {
  const session = await prisma.session.findFirst({
    where: { userId, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    select: { token: true },
  });
  return session?.token || null;
}

/**
 * Small helper: wait for ms milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Phase 1: Discover available offers and select the best match.
 * Returns the best offer info and transactionId without completing the purchase.
 */
export async function discoverBestOffer(
  userId: string,
  params: { quantity: number; maxPrice?: number; timeDesc?: string }
): Promise<DiscoveryResult> {
  const baseUrl = `http://localhost:${config.ports.bap}`;

  const token = await getUserAuthToken(userId);
  if (!token) {
    return { success: false, error: 'No valid session found. Please log in again.' };
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  // Validate quantity (min 1 kWh, round to 2 decimals)
  const qtyError = validateQuantity(params.quantity);
  if (qtyError) {
    return { success: false, error: qtyError };
  }
  params.quantity = roundQuantity(params.quantity);

  const timeWindow = buildTimeWindow(params.timeDesc);

  // Gate closure check: reject if within 4h of delivery start
  const tradeCheck = checkTradeWindow(timeWindow.startTime);
  if (!tradeCheck.allowed) {
    return { success: false, error: tradeCheck.reason || 'Trade not allowed for this time window' };
  }

  // Buyer sanctioned load check
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { sanctionedLoadKW: true } });
  const buyerCapError = checkBuyerCapacity(params.quantity, user?.sanctionedLoadKW);
  if (buyerCapError) {
    return { success: false, error: buyerCapError };
  }

  try {
    // Step 1: Discover available offers (use minQuantity: 1 to get ALL offers,
    // then let /api/select with smartBuy combine multiple offers to fulfill the total quantity)
    logger.info(`[BuyFlow:Discover] Discovering offers for user ${userId}: ${params.quantity} kWh`);
    const discoverRes = await axios.post(`${baseUrl}/api/discover`, {
      minQuantity: 1,
      timeWindow,
    }, { headers, timeout: 20000 });

    const txId = discoverRes.data.transaction_id;
    if (!txId) {
      return { success: false, error: 'Discovery failed — no transaction ID returned.' };
    }

    const catalog = discoverRes.data.catalog
      || discoverRes.data.ack?.message?.catalog
      || null;
    const providers = catalog?.providers || [];
    const allOffers: any[] = [];
    for (const p of providers) {
      for (const item of (p.items || [])) {
        for (const offer of (item.offers || [])) {
          allOffers.push({
            ...offer,
            providerName: p.descriptor?.name || 'Unknown Seller',
            providerId: p.id,
          });
        }
      }
    }

    if (allOffers.length === 0) {
      return { success: false, error: 'No energy offers found matching your requirements. Try different quantity or time.' };
    }

    // Step 2: Smart buy — automatically picks single or multiple offers
    logger.info(`[BuyFlow:Discover] Smart buy selecting from ${allOffers.length} offers, txId=${txId}`);
    const selectRes = await axios.post(`${baseUrl}/api/select`, {
      transaction_id: txId,
      quantity: params.quantity,
      requestedTimeWindow: { startTime: timeWindow.startTime, endTime: timeWindow.endTime },
      smartBuy: true,
      source: 'chat-agent',
    }, { headers, timeout: 15000 });

    // Handle no_eligible_offers response (200 with suggestions)
    if (selectRes.data.status === 'no_eligible_offers' || (selectRes.data.selectedOffers?.length === 0 && !selectRes.data.error)) {
      return {
        success: false,
        error: selectRes.data.error || 'No matching offers found for your time window.',
        availableWindows: selectRes.data.availableWindows,
        filterReasons: selectRes.data.filterReasons,
      };
    }

    if (selectRes.data.error) {
      return { success: false, error: selectRes.data.error };
    }

    const selectionType: 'single' | 'multiple' = selectRes.data.selectionType || 'single';
    const selectedOffers: any[] = selectRes.data.selectedOffers || [];
    const summary = selectRes.data.summary;

    if (selectedOffers.length === 0) {
      return { success: false, error: 'No matching offer found. Try adjusting quantity or time window.' };
    }

    // Format time window label from the first offer's time window
    const formatTw = (tw: any): string => {
      if (!tw) return 'Flexible';
      try {
        const s = new Date(tw.startTime);
        const e = new Date(tw.endTime);
        return `${s.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} ${s.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}-${e.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
      } catch { return 'Flexible'; }
    };

    // Build discovered offers array
    const discoveredOffers: SmartBuyOffer[] = selectedOffers.map((o: any) => ({
      offerId: o.offer_id,
      providerId: o.provider_id,
      providerName: o.provider_name || 'Seller',
      price: o.unit_price,
      quantity: o.quantity,
      subtotal: o.subtotal,
      timeWindow: formatTw(o.timeWindow),
    }));

    const smartSummary: SmartBuySummary = {
      totalQuantity: summary?.totalQuantity || discoveredOffers.reduce((s, o) => s + o.quantity, 0),
      totalPrice: summary?.totalPrice || discoveredOffers.reduce((s, o) => s + o.subtotal, 0),
      averagePrice: summary?.averagePrice || (summary?.totalPrice / summary?.totalQuantity) || 0,
      fullyFulfilled: summary?.fullyFulfilled ?? true,
      shortfall: summary?.shortfall || 0,
      offersUsed: summary?.offersUsed || discoveredOffers.length,
    };

    // Check max price against average price
    if (params.maxPrice && smartSummary.averagePrice > params.maxPrice) {
      return {
        success: false,
        selectionType,
        discoveredOffers,
        summary: smartSummary,
        transactionId: txId,
        error: `Average price is Rs ${smartSummary.averagePrice.toFixed(2)}/unit, which exceeds your max of Rs ${params.maxPrice}/unit.`,
      };
    }

    // Also build legacy single discoveredOffer for backward compat
    const firstOffer = discoveredOffers[0];
    const discoveredOffer = selectionType === 'single' ? {
      offerId: firstOffer.offerId,
      providerId: firstOffer.providerId,
      providerName: firstOffer.providerName,
      price: firstOffer.price,
      quantity: firstOffer.quantity,
      timeWindow: firstOffer.timeWindow,
    } : undefined;

    logger.info(`[BuyFlow:Discover] Smart buy: ${selectionType} mode, ${smartSummary.offersUsed} offers, ${smartSummary.totalQuantity} kWh @ avg Rs${smartSummary.averagePrice.toFixed(2)}/kWh, txId=${txId}`);

    return {
      success: true,
      transactionId: txId,
      selectionType,
      discoveredOffer,
      discoveredOffers,
      summary: smartSummary,
    };
  } catch (error: any) {
    const status = error.response?.status;
    const msg = error.response?.data?.error || error.message || 'Unknown error';
    logger.error(`[BuyFlow:Discover] Discovery failed: ${msg}`, { userId, status });

    // Detect auth errors
    if (status === 401 || status === 403) {
      return { success: false, error: 'Your session has expired. Please log in again.', authExpired: true };
    }

    return { success: false, error: msg };
  }
}

/**
 * Phase 2: Complete a purchase by running init → confirm on an already-selected offer.
 */
export async function completePurchase(
  userId: string,
  transactionId: string,
  discoveredOffer: DiscoveryResult['discoveredOffer'],
  quantity: number
): Promise<PurchaseResult> {
  const baseUrl = `http://localhost:${config.ports.bap}`;

  const token = await getUserAuthToken(userId);
  if (!token) {
    return { success: false, error: 'No valid session found. Please log in again.' };
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  try {
    // Step 1: Init order
    logger.info(`[BuyFlow:Complete] Init order, txId=${transactionId}`);
    await axios.post(`${baseUrl}/api/init`, {
      transaction_id: transactionId,
    }, { headers, timeout: 15000 });

    // Step 2: Poll transaction state until order is created (like the UI does)
    // The BPP processes init asynchronously and sends on_init callback
    let txState: any = null;
    let orderId: string | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(500);
      try {
        const txRes = await axios.get(`${baseUrl}/api/transactions/${transactionId}`, { headers, timeout: 5000 });
        txState = txRes.data;
        if (txState?.error) {
          return { success: false, error: txState.error };
        }
        // Check if order or bulk orders are ready
        if (txState?.order?.id || (txState?.bulkOrders && txState.bulkOrders.length > 0)) {
          orderId = txState.order?.id;
          break;
        }
      } catch {
        // Polling failure — continue trying
      }
    }

    if (!txState?.order && !txState?.bulkOrders?.length) {
      return { success: false, error: 'Order creation timed out. Please try again.' };
    }

    // Step 3: Confirm order (pass order_id like the UI does)
    logger.info(`[BuyFlow:Complete] Confirming order, txId=${transactionId}, orderId=${orderId}`);
    const confirmRes = await axios.post(`${baseUrl}/api/confirm`, {
      transaction_id: transactionId,
      order_id: orderId,
    }, { headers, timeout: 15000 });

    await sleep(500);

    // Handle bulk mode confirm response
    if (confirmRes.data.bulk_mode) {
      const confirmedCount = confirmRes.data.total_confirmed || 0;
      const failedCount = confirmRes.data.total_failed || 0;
      logger.info(`[BuyFlow:Complete] Bulk purchase: ${confirmedCount} confirmed, ${failedCount} failed, txId=${transactionId}`);

      return {
        success: confirmedCount > 0,
        order: {
          orderId: transactionId,
          transactionId,
          quantity,
          pricePerKwh: discoveredOffer?.price || 0,
          totalPrice: (discoveredOffer?.price || 0) * quantity,
          providerName: discoveredOffer?.providerName || 'Multiple Sellers',
          timeWindow: discoveredOffer?.timeWindow || 'Flexible',
        },
        bulkResult: { confirmedCount, failedCount },
      };
    }

    // Single order confirm response
    const confirmOrderId = confirmRes.data.order_id || orderId;
    const price = discoveredOffer?.price || 0;
    const totalPrice = price * quantity;
    logger.info(`[BuyFlow:Complete] Purchase complete: order=${confirmOrderId}, ${quantity}kWh at Rs${price}/kWh = Rs${totalPrice}`);

    return {
      success: true,
      order: {
        orderId: confirmOrderId || transactionId,
        transactionId,
        quantity,
        pricePerKwh: price,
        totalPrice,
        providerName: discoveredOffer?.providerName || 'Solar Seller',
        timeWindow: discoveredOffer?.timeWindow || 'Flexible',
      },
    };
  } catch (error: any) {
    const status = error.response?.status;
    const msg = error.response?.data?.error || error.message || 'Unknown error';
    logger.error(`[BuyFlow:Complete] Purchase completion failed: ${msg}`, { userId, transactionId, status });

    if (status === 401 || status === 403) {
      return { success: false, error: 'Your session has expired. Please log in again.' };
    }

    return { success: false, error: msg };
  }
}

/**
 * Execute a full buyer purchase flow: discover → select → init → confirm.
 * Convenience wrapper that calls both phases sequentially.
 */
export async function executePurchase(
  userId: string,
  params: { quantity: number; maxPrice?: number; timeDesc?: string }
): Promise<PurchaseResult> {
  const discovery = await discoverBestOffer(userId, params);
  if (!discovery.success || !discovery.transactionId) {
    return {
      success: false,
      error: discovery.error,
    };
  }

  const offer = discovery.discoveredOffer || (discovery.discoveredOffers?.[0] ? {
    offerId: discovery.discoveredOffers[0].offerId,
    providerId: discovery.discoveredOffers[0].providerId,
    providerName: discovery.discoveredOffers[0].providerName,
    price: discovery.discoveredOffers[0].price,
    quantity: discovery.discoveredOffers[0].quantity,
    timeWindow: discovery.discoveredOffers[0].timeWindow,
  } : undefined);

  if (!offer) {
    return { success: false, error: discovery.error || 'No offers found' };
  }

  return completePurchase(userId, discovery.transactionId, offer, params.quantity);
}

/**
 * Parse a time period from natural language.
 * Returns { startDate, endDate, label } or null.
 */
export function parseTimePeriod(message: string): { startDate: Date; endDate: Date; label: string } | null {
  const lower = message.toLowerCase();
  const now = new Date();

  if (lower.includes('today') || lower.includes('aaj')) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { startDate: start, endDate: now, label: 'today' };
  }

  if (lower.includes('yesterday') || lower.includes('kal') || lower.includes('parso')) {
    const start = new Date(now);
    start.setDate(start.getDate() - 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    return { startDate: start, endDate: end, label: 'yesterday' };
  }

  if (lower.includes('this week') || lower.includes('is hafte') || lower.includes('is week')) {
    const start = new Date(now);
    start.setDate(start.getDate() - start.getDay());
    start.setHours(0, 0, 0, 0);
    return { startDate: start, endDate: now, label: 'this week' };
  }

  if (lower.includes('last week') || lower.includes('pichle hafte') || lower.includes('pichhle week')) {
    const start = new Date(now);
    start.setDate(start.getDate() - start.getDay() - 7);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    end.setHours(23, 59, 59, 999);
    return { startDate: start, endDate: end, label: 'last week' };
  }

  if (lower.includes('this month') || lower.includes('is mahine') || lower.includes('is month')) {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return { startDate: start, endDate: now, label: 'this month' };
  }

  if (lower.includes('last month') || lower.includes('pichle mahine') || lower.includes('pichhle month')) {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    return { startDate: start, endDate: end, label: 'last month' };
  }

  // "last N days"
  const daysMatch = lower.match(/last\s+(\d+)\s*days?/);
  if (daysMatch) {
    const days = parseInt(daysMatch[1]);
    const start = new Date(now);
    start.setDate(start.getDate() - days);
    start.setHours(0, 0, 0, 0);
    return { startDate: start, endDate: now, label: `last ${days} days` };
  }

  return null;
}

/**
 * Get a welcome-back data summary for a returning user.
 * Returns structured data (always English) for LLM composition.
 */
export async function getWelcomeBackData(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, balance: true, providerId: true, productionCapacity: true, allowedTradeLimit: true },
  });
  if (!user) return '';

  const parts: string[] = [];
  parts.push(`User name: ${user.name || 'friend'}`);
  parts.push(`Wallet balance: Rs ${user.balance.toFixed(2)}`);

  if (user.providerId) {
    // Active listings
    const offers = await prisma.catalogOffer.findMany({
      where: { providerId: user.providerId },
      select: { maxQty: true, priceValue: true },
    });
    const totalListed = offers.reduce((sum, o) => sum + o.maxQty, 0);
    parts.push(`Active listings: ${offers.length} (total ${totalListed} kWh)`);

    // Recent orders (last 7 days)
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const recentOrders = await prisma.order.findMany({
      where: {
        providerId: user.providerId,
        status: { in: ['ACTIVE', 'COMPLETED'] },
        createdAt: { gte: weekAgo },
      },
      select: { totalPrice: true, totalQty: true },
    });

    if (recentOrders.length > 0) {
      const recentEarnings = recentOrders.reduce((sum, o) => sum + (o.totalPrice || 0), 0);
      const recentKwh = recentOrders.reduce((sum, o) => sum + (o.totalQty || 0), 0);
      parts.push(`Last 7 days: ${recentOrders.length} order(s), ${recentKwh.toFixed(1)} kWh sold, Rs ${recentEarnings.toFixed(2)} earned`);
    } else {
      parts.push('Last 7 days: No new orders');
    }

    // All-time totals
    const allOrders = await prisma.order.findMany({
      where: {
        providerId: user.providerId,
        status: { in: ['ACTIVE', 'COMPLETED'] },
      },
      select: { totalPrice: true, totalQty: true },
    });
    const totalEarnings = allOrders.reduce((sum, o) => sum + (o.totalPrice || 0), 0);
    const totalKwh = allOrders.reduce((sum, o) => sum + (o.totalQty || 0), 0);
    parts.push(`All-time: ${allOrders.length} order(s), ${totalKwh.toFixed(1)} kWh sold, Rs ${totalEarnings.toFixed(2)} total earnings`);
  } else {
    // Buyer — check buyer orders
    const buyerOrders = await prisma.order.findMany({
      where: { buyerId: userId, status: { in: ['ACTIVE', 'COMPLETED'] } },
      select: { totalPrice: true, totalQty: true },
    });
    if (buyerOrders.length > 0) {
      const totalSpent = buyerOrders.reduce((sum, o) => sum + (o.totalPrice || 0), 0);
      const totalKwh = buyerOrders.reduce((sum, o) => sum + (o.totalQty || 0), 0);
      parts.push(`Purchases: ${buyerOrders.length} order(s), ${totalKwh.toFixed(1)} kWh bought, Rs ${totalSpent.toFixed(2)} spent`);
    } else {
      parts.push('No orders yet');
    }
  }

  return parts.join('\n');
}

/**
 * Generate a text-based trading dashboard with key metrics.
 */
export async function generateDashboard(userId: string, lang?: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      name: true,
      balance: true,
      trustScore: true,
      allowedTradeLimit: true,
      providerId: true,
      productionCapacity: true,
    },
  });

  if (!user) {
    return ht(lang, 'Dashboard not available.', 'Dashboard available nahi hai.');
  }

  const trustTier = getTrustTier(user.trustScore);

  // Seller stats
  let sellerSection = '';
  if (user.providerId) {
    const offers = await prisma.catalogOffer.findMany({
      where: { providerId: user.providerId },
      select: { maxQty: true, priceValue: true },
    });

    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const recentOrders = await prisma.order.findMany({
      where: {
        providerId: user.providerId,
        status: { in: ['ACTIVE', 'COMPLETED'] },
        createdAt: { gte: weekAgo },
      },
      select: { totalPrice: true, totalQty: true },
    });

    const allOrders = await prisma.order.findMany({
      where: {
        providerId: user.providerId,
        status: { in: ['ACTIVE', 'COMPLETED'] },
      },
      select: { totalPrice: true, totalQty: true },
    });

    const weeklyEarnings = recentOrders.reduce((sum, o) => sum + (o.totalPrice || 0), 0);
    const weeklyKwh = recentOrders.reduce((sum, o) => sum + (o.totalQty || 0), 0);
    const totalEarnings = allOrders.reduce((sum, o) => sum + (o.totalPrice || 0), 0);
    const totalKwh = allOrders.reduce((sum, o) => sum + (o.totalQty || 0), 0);
    const totalListed = offers.reduce((sum, o) => sum + o.maxQty, 0);

    sellerSection = ht(lang,
      `\n📊 *Seller Stats*\n` +
      `Active Listings: ${offers.length} (${totalListed} kWh)\n` +
      `This Week: ₹${weeklyEarnings.toFixed(0)} earned, ${weeklyKwh.toFixed(1)} kWh\n` +
      `All-Time: ₹${totalEarnings.toFixed(0)} earned, ${totalKwh.toFixed(1)} kWh`,

      `\n📊 *Seller Stats*\n` +
      `Active Listings: ${offers.length} (${totalListed} kWh)\n` +
      `Is Hafte: ₹${weeklyEarnings.toFixed(0)} kamai, ${weeklyKwh.toFixed(1)} kWh\n` +
      `Total: ₹${totalEarnings.toFixed(0)} kamai, ${totalKwh.toFixed(1)} kWh`
    );
  }

  // Buyer stats
  const buyerOrders = await prisma.order.findMany({
    where: {
      buyerId: userId,
      status: { in: ['ACTIVE', 'COMPLETED'] },
    },
    select: { totalPrice: true, totalQty: true },
  });

  let buyerSection = '';
  if (buyerOrders.length > 0) {
    const totalSpent = buyerOrders.reduce((sum, o) => sum + (o.totalPrice || 0), 0);
    const totalBoughtKwh = buyerOrders.reduce((sum, o) => sum + (o.totalQty || 0), 0);

    buyerSection = ht(lang,
      `\n🔋 *Buyer Stats*\n` +
      `Orders: ${buyerOrders.length}\n` +
      `Energy Bought: ${totalBoughtKwh.toFixed(1)} kWh\n` +
      `Total Spent: ₹${totalSpent.toFixed(0)}`,

      `\n🔋 *Buyer Stats*\n` +
      `Orders: ${buyerOrders.length}\n` +
      `Energy Liya: ${totalBoughtKwh.toFixed(1)} kWh\n` +
      `Total Kharch: ₹${totalSpent.toFixed(0)}`
    );
  }

  // Build dashboard
  const dashboard = ht(lang,
    `📊 *Oorja Dashboard*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `👤 ${user.name || 'Trader'}\n` +
    `💰 Balance: ₹${user.balance.toFixed(0)}\n` +
    `🌟 Trust: ${trustTier.name} (${(user.trustScore * 100).toFixed(0)}%)\n` +
    `📈 Trade Limit: ${user.allowedTradeLimit}%` +
    sellerSection +
    buyerSection +
    `\n\n━━━━━━━━━━━━━━━━━━━━`,

    `📊 *Oorja Dashboard*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `👤 ${user.name || 'Trader'}\n` +
    `💰 Balance: ₹${user.balance.toFixed(0)}\n` +
    `🌟 Trust: ${trustTier.name} (${(user.trustScore * 100).toFixed(0)}%)\n` +
    `📈 Trade Limit: ${user.allowedTradeLimit}%` +
    sellerSection +
    buyerSection +
    `\n\n━━━━━━━━━━━━━━━━━━━━`
  );

  return dashboard;
}

// Trust tier helper
function getTrustTier(score: number): { name: string; nameHi: string; emoji: string } {
  if (score >= 0.9) return { name: 'Platinum', nameHi: 'प्लैटिनम', emoji: '💎' };
  if (score >= 0.7) return { name: 'Gold', nameHi: 'गोल्ड', emoji: '🥇' };
  if (score >= 0.5) return { name: 'Silver', nameHi: 'सिल्वर', emoji: '🥈' };
  if (score >= 0.3) return { name: 'Bronze', nameHi: 'ब्रॉन्ज़', emoji: '🥉' };
  return { name: 'Starter', nameHi: 'स्टार्टर', emoji: '🌱' };
}

/** Dashboard data for structured UI rendering */
export interface DashboardData {
  userName: string;
  balance: number;
  trustScore: number;
  trustTier: { name: string; nameHi: string; emoji: string };
  tradeLimit: number;
  productionCapacity?: number;
  seller?: {
    activeListings: number;
    totalListedKwh: number;
    weeklyEarnings: number;
    weeklyKwh: number;
    totalEarnings: number;
    totalKwh: number;
  };
  buyer?: {
    totalOrders: number;
    totalBoughtKwh: number;
    totalSpent: number;
  };
}

/**
 * Generate structured dashboard data for card UI rendering.
 */
export async function generateDashboardData(userId: string): Promise<DashboardData | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      name: true,
      balance: true,
      trustScore: true,
      allowedTradeLimit: true,
      providerId: true,
      productionCapacity: true,
    },
  });

  if (!user) return null;

  const trustTier = getTrustTier(user.trustScore);

  const data: DashboardData = {
    userName: user.name || 'Trader',
    balance: user.balance,
    trustScore: user.trustScore,
    trustTier,
    tradeLimit: user.allowedTradeLimit,
    productionCapacity: user.productionCapacity || undefined,
  };

  // Seller stats
  if (user.providerId) {
    const offers = await prisma.catalogOffer.findMany({
      where: { providerId: user.providerId },
      select: { maxQty: true },
    });

    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const recentOrders = await prisma.order.findMany({
      where: {
        providerId: user.providerId,
        status: { in: ['ACTIVE', 'COMPLETED'] },
        createdAt: { gte: weekAgo },
      },
      select: { totalPrice: true, totalQty: true },
    });

    const allOrders = await prisma.order.findMany({
      where: {
        providerId: user.providerId,
        status: { in: ['ACTIVE', 'COMPLETED'] },
      },
      select: { totalPrice: true, totalQty: true },
    });

    data.seller = {
      activeListings: offers.length,
      totalListedKwh: offers.reduce((sum, o) => sum + o.maxQty, 0),
      weeklyEarnings: recentOrders.reduce((sum, o) => sum + (o.totalPrice || 0), 0),
      weeklyKwh: recentOrders.reduce((sum, o) => sum + (o.totalQty || 0), 0),
      totalEarnings: allOrders.reduce((sum, o) => sum + (o.totalPrice || 0), 0),
      totalKwh: allOrders.reduce((sum, o) => sum + (o.totalQty || 0), 0),
    };
  }

  // Buyer stats
  const buyerOrders = await prisma.order.findMany({
    where: {
      buyerId: userId,
      status: { in: ['ACTIVE', 'COMPLETED'] },
    },
    select: { totalPrice: true, totalQty: true },
  });

  if (buyerOrders.length > 0) {
    data.buyer = {
      totalOrders: buyerOrders.length,
      totalBoughtKwh: buyerOrders.reduce((sum, o) => sum + (o.totalQty || 0), 0),
      totalSpent: buyerOrders.reduce((sum, o) => sum + (o.totalPrice || 0), 0),
    };
  }

  return data;
}

/**
 * Get market insights - current prices, available offers, and trends.
 * Now with personalized recommendations based on user state.
 */
export async function getMarketInsights(lang?: string, userId?: string): Promise<string> {
  const ht = (en: string, hi: string) => lang === 'hi-IN' ? hi : en;

  // Get user data for personalization if available
  let userData: {
    providerId: string | null;
    hasGeneration: boolean;
    hasConsumption: boolean;
    activeListings: number;
    userListingPrice?: number;
  } | null = null;

  if (userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { providerId: true },
    });

    const credentials = await prisma.userCredential.findMany({
      where: { userId },
      select: { credentialType: true },
    });

    const hasGeneration = credentials.some(c => c.credentialType === 'GENERATION_PROFILE');
    const hasConsumption = credentials.some(c => c.credentialType === 'CONSUMPTION_PROFILE');

    let activeListings = 0;
    let userListingPrice: number | undefined;

    if (user?.providerId) {
      const listings = await prisma.catalogOffer.findMany({
        where: { providerId: user.providerId, maxQty: { gt: 0 } },
        select: { priceValue: true },
      });
      activeListings = listings.length;
      if (listings.length > 0) {
        userListingPrice = listings[0].priceValue;
      }
    }

    userData = {
      providerId: user?.providerId || null,
      hasGeneration,
      hasConsumption,
      activeListings,
      userListingPrice,
    };
  }

  // Get all active offers with availability
  const offers = await prisma.catalogOffer.findMany({
    where: { maxQty: { gt: 0 } },
    include: {
      provider: { select: { name: true, trustScore: true } },
      item: { select: { sourceType: true } },
    },
    orderBy: { priceValue: 'asc' },
  });

  if (offers.length === 0) {
    let emptyMessage = ht(
      `📊 *Market Insights*\n\n` +
      `No active offers right now.\n\n` +
      `💡 This is a great time to list your solar energy! You could be the first seller and set competitive prices.\n\n` +
      `DISCOM rate: ₹7.5/kWh\nRecommended P2P price: ₹4-6/kWh`,

      `📊 *Market Insights*\n\n` +
      `Abhi koi active offer nahi hai.\n\n` +
      `💡 Ye bahut accha time hai apni solar energy list karne ka! Aap pehle seller ho sakte ho.\n\n` +
      `DISCOM rate: ₹7.5/kWh\nP2P recommended price: ₹4-6/kWh`
    );

    // Add personalized suggestion
    if (userData?.hasGeneration) {
      emptyMessage += ht(
        `\n\n🎯 *Personalized for You*\nAs a solar producer, this is the perfect time to list energy. No competition means you can set your own prices!`,
        `\n\n🎯 *Aapke Liye Suggestion*\nSolar producer ke taur pe, ye perfect time hai list karne ka. Koi competition nahi - apna price set karo!`
      );
    }

    return emptyMessage;
  }

  // Calculate stats
  const prices = offers.map(o => o.priceValue);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
  const totalAvailable = offers.reduce((sum, o) => sum + o.maxQty, 0);

  // Group by energy type
  const byType: Record<string, { count: number; qty: number; avgPrice: number }> = {};
  for (const offer of offers) {
    const type = offer.item?.sourceType || 'SOLAR';
    if (!byType[type]) byType[type] = { count: 0, qty: 0, avgPrice: 0 };
    byType[type].count++;
    byType[type].qty += offer.maxQty;
    byType[type].avgPrice += offer.priceValue;
  }
  for (const type of Object.keys(byType)) {
    byType[type].avgPrice = byType[type].avgPrice / byType[type].count;
  }

  // Find best deals (top 3 cheapest with good trust score)
  const bestDeals = offers
    .filter(o => (o.provider?.trustScore || 0) >= 0.3)
    .slice(0, 3);

  const discomRate = 7.5;
  const savings = Math.round(((discomRate - avgPrice) / discomRate) * 100);

  let insight = ht(
    `📊 *Market Insights*\n━━━━━━━━━━━━━━━━━━━━\n\n`,
    `📊 *Market Insights*\n━━━━━━━━━━━━━━━━━━━━\n\n`
  );

  insight += ht(
    `📈 *Current Prices*\n` +
    `• Range: ₹${minPrice.toFixed(1)} - ₹${maxPrice.toFixed(1)}/kWh\n` +
    `• Average: ₹${avgPrice.toFixed(1)}/kWh\n` +
    `• DISCOM: ₹${discomRate}/kWh\n` +
    `• You save ~${savings}% vs DISCOM!\n\n`,

    `📈 *Current Prices*\n` +
    `• Range: ₹${minPrice.toFixed(1)} - ₹${maxPrice.toFixed(1)}/kWh\n` +
    `• Average: ₹${avgPrice.toFixed(1)}/kWh\n` +
    `• DISCOM: ₹${discomRate}/kWh\n` +
    `• DISCOM se ~${savings}% bachao!\n\n`
  );

  // Price trend (compared to yesterday - simplified heuristic)
  const trendEmoji = avgPrice <= 5.5 ? '↘️ falling' : avgPrice >= 6.5 ? '↗️ rising' : '→ stable';
  insight += ht(
    `📉 *Price Trend*: ${trendEmoji}\n\n`,
    `📉 *Price Trend*: ${trendEmoji}\n\n`
  );

  insight += ht(
    `⚡ *Available Energy*\n` +
    `• ${offers.length} active offers\n` +
    `• ${totalAvailable.toFixed(0)} kWh total\n`,

    `⚡ *Available Energy*\n` +
    `• ${offers.length} active offers\n` +
    `• ${totalAvailable.toFixed(0)} kWh available\n`
  );

  // Add energy type breakdown if multiple types
  const types = Object.keys(byType);
  if (types.length > 1) {
    for (const type of types) {
      const t = byType[type];
      insight += `  - ${type}: ${t.count} offers, ${t.qty.toFixed(0)} kWh @ ₹${t.avgPrice.toFixed(1)} avg\n`;
    }
  }

  if (bestDeals.length > 0) {
    insight += ht(`\n🏆 *Best Deals*\n`, `\n🏆 *Best Deals*\n`);
    for (const deal of bestDeals) {
      const trust = getTrustTier(deal.provider?.trustScore || 0);
      insight += `• ₹${deal.priceValue}/kWh - ${deal.maxQty} kWh ${trust.emoji}\n`;
    }
  }

  // Personalized recommendations
  if (userData) {
    insight += ht(`\n🎯 *Personalized for You*\n`, `\n🎯 *Aapke Liye*\n`);

    if (userData.hasGeneration) {
      // Seller-focused advice
      if (userData.userListingPrice) {
        const priceDiff = userData.userListingPrice - avgPrice;
        if (priceDiff > 0.5) {
          insight += ht(
            `• Your price (₹${userData.userListingPrice}) is ${Math.round((priceDiff / avgPrice) * 100)}% above average. Consider lowering for faster sales.\n`,
            `• Aapka price (₹${userData.userListingPrice}) average se ${Math.round((priceDiff / avgPrice) * 100)}% zyada hai. Jaldi bikri ke liye kam karo.\n`
          );
        } else if (priceDiff < -0.5) {
          insight += ht(
            `• Great! Your price (₹${userData.userListingPrice}) is competitive - ${Math.round((-priceDiff / avgPrice) * 100)}% below average!\n`,
            `• Bahut badhiya! Aapka price (₹${userData.userListingPrice}) competitive hai - ${Math.round((-priceDiff / avgPrice) * 100)}% kam!\n`
          );
        } else {
          insight += ht(
            `• Your price (₹${userData.userListingPrice}) is right at market average. Well priced!\n`,
            `• Aapka price (₹${userData.userListingPrice}) market average pe hai. Perfect!\n`
          );
        }
      } else {
        insight += ht(
          `• As a seller: Price at ₹${(avgPrice - 0.5).toFixed(1)}-${avgPrice.toFixed(1)} for quick sales\n`,
          `• Seller ke taur pe: ₹${(avgPrice - 0.5).toFixed(1)}-${avgPrice.toFixed(1)} pe jaldi bikri hogi\n`
        );
      }
    }

    if (userData.hasConsumption) {
      // Buyer-focused advice
      insight += ht(
        `• As a buyer: Prices are ${savings >= 20 ? 'very low' : savings >= 10 ? 'good' : 'moderate'} right now - ${savings >= 20 ? 'great time to buy!' : savings >= 10 ? 'good time to buy' : 'prices may drop soon'}\n`,
        `• Buyer ke taur pe: Prices ${savings >= 20 ? 'bahut kam' : savings >= 10 ? 'acche' : 'theek'} hain - ${savings >= 20 ? 'buy karne ka best time!' : savings >= 10 ? 'buy kar sakte ho' : 'prices aur gir sakti'}\n`
      );
    }
  } else {
    // Generic tips
    insight += ht(
      `\n💡 *Tips*\n` +
      `• Buy now to lock in low prices\n` +
      `• Sellers: Price at ₹${(avgPrice - 0.5).toFixed(1)}-${avgPrice.toFixed(1)} for quick sales`,

      `\n💡 *Tips*\n` +
      `• Abhi khareed lo - prices low hain\n` +
      `• Sellers: ₹${(avgPrice - 0.5).toFixed(1)}-${avgPrice.toFixed(1)} pe jaldi bikri hogi`
    );
  }

  return insight;
}

/**
 * Get combined activity summary - orders, earnings, and wallet in one view.
 * Perfect for "track orders and earnings" requests.
 */
export async function getActivitySummary(userId: string, lang?: string): Promise<string> {
  const ht = (en: string, hi: string) => lang === 'hi-IN' ? hi : en;

  // Get user balance and provider info
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { balance: true, name: true, providerId: true },
  });

  const balance = user?.balance || 0;
  const userName = user?.name || 'User';
  const providerId = user?.providerId;

  // Get today's date range
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const thisWeekStart = new Date(today);
  thisWeekStart.setDate(thisWeekStart.getDate() - 7);

  // Get earnings data (as seller through provider)
  let orders: { totalPrice: number | null; status: string; createdAt: Date }[] = [];
  if (providerId) {
    orders = await prisma.order.findMany({
      where: {
        providerId: providerId,
        status: { in: ['CONFIRMED', 'COMPLETED'] },
      },
      select: {
        totalPrice: true,
        status: true,
        createdAt: true,
      },
    });
  }

  // Calculate earnings
  const completedOrders = orders.filter(o => o.status === 'COMPLETED');
  const todayEarnings = completedOrders
    .filter(o => new Date(o.createdAt) >= today)
    .reduce((sum, o) => sum + (o.totalPrice || 0), 0);
  const weekEarnings = completedOrders
    .filter(o => new Date(o.createdAt) >= thisWeekStart)
    .reduce((sum, o) => sum + (o.totalPrice || 0), 0);
  const totalEarnings = completedOrders.reduce((sum, o) => sum + (o.totalPrice || 0), 0);

  // Get pending orders (as both buyer and seller)
  const pendingAsSeller = orders.filter(o => o.status === 'CONFIRMED').length;
  const pendingAsBuyer = await prisma.order.count({
    where: {
      buyerId: userId,
      status: 'CONFIRMED',
    },
  });

  // Get this month's completed orders
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const monthCompletedSelling = completedOrders.filter(o => new Date(o.createdAt) >= monthStart).length;
  const monthCompletedBuying = await prisma.order.count({
    where: {
      buyerId: userId,
      status: 'COMPLETED',
      createdAt: { gte: monthStart },
    },
  });

  // Get active listings count
  let activeListings = 0;
  if (providerId) {
    activeListings = await prisma.catalogOffer.count({
      where: {
        providerId: providerId,
        maxQty: { gt: 0 },
      },
    });
  }

  // Build the activity summary
  const summary = ht(
    `📊 *Your Activity Summary*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `👋 Hey ${userName}!\n\n` +
    `💰 *Earnings*\n` +
    `• Today: ₹${todayEarnings.toFixed(0)}\n` +
    `• This Week: ₹${weekEarnings.toFixed(0)}\n` +
    `• Total: ₹${totalEarnings.toFixed(0)}\n\n` +
    `📦 *Orders*\n` +
    `• ${pendingAsSeller} pending delivery (selling)\n` +
    `• ${pendingAsBuyer} pending delivery (buying)\n` +
    `• ${monthCompletedSelling + monthCompletedBuying} completed this month\n\n` +
    `📋 *Listings*\n` +
    `• ${activeListings} active listing${activeListings !== 1 ? 's' : ''}\n\n` +
    `💼 *Wallet Balance*: ₹${balance.toFixed(0)}`,

    `📊 *आपकी एक्टिविटी समरी*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `👋 नमस्ते ${userName}!\n\n` +
    `💰 *कमाई*\n` +
    `• आज: ₹${todayEarnings.toFixed(0)}\n` +
    `• इस हफ्ते: ₹${weekEarnings.toFixed(0)}\n` +
    `• कुल: ₹${totalEarnings.toFixed(0)}\n\n` +
    `📦 *ऑर्डर*\n` +
    `• ${pendingAsSeller} डिलीवरी पेंडिंग (बेचना)\n` +
    `• ${pendingAsBuyer} डिलीवरी पेंडिंग (खरीदना)\n` +
    `• ${monthCompletedSelling + monthCompletedBuying} इस महीने पूरे हुए\n\n` +
    `📋 *लिस्टिंग*\n` +
    `• ${activeListings} एक्टिव लिस्टिंग\n\n` +
    `💼 *वॉलेट बैलेंस*: ₹${balance.toFixed(0)}`
  );

  return summary;
}

/**
 * Get top deals available in the marketplace.
 * Returns formatted deals with prices and savings vs DISCOM.
 */
export interface TopDeal {
  offerId: string;
  quantity: number;
  pricePerUnit: number;
  totalPrice: number;
  providerName: string;
  trustScore: number;
  energyType: string;
  savings: number; // vs DISCOM
  savingsPercent: number;
}

export async function getTopDeals(limit: number = 3, lang?: string): Promise<{ deals: TopDeal[], message: string }> {
  const ht = (en: string, hi: string) => lang === 'hi-IN' ? hi : en;
  const DISCOM_RATE = 7.5; // Peak DISCOM rate for comparison

  // Get best available offers
  const offers = await prisma.catalogOffer.findMany({
    where: { maxQty: { gt: 0 } },
    include: {
      provider: { select: { name: true, trustScore: true } },
      item: { select: { sourceType: true } },
    },
    orderBy: { priceValue: 'asc' },
    take: limit,
  });

  if (offers.length === 0) {
    return {
      deals: [],
      message: ht(
        '😕 No energy offers available right now.\n\nCheck back later or set an alert to be notified when energy is available.',
        '😕 Abhi koi energy offer nahi hai.\n\nBaad mein check karo ya alert set karo jab energy available ho.'
      ),
    };
  }

  const deals: TopDeal[] = offers.map(offer => {
    const savings = DISCOM_RATE - offer.priceValue;
    const savingsPercent = ((DISCOM_RATE - offer.priceValue) / DISCOM_RATE) * 100;
    const sourceType = offer.item?.sourceType || 'SOLAR';
    const energyEmoji = sourceType === 'SOLAR' ? '☀️' : sourceType === 'WIND' ? '💨' : '💧';

    return {
      offerId: offer.id,
      quantity: Math.round(offer.maxQty),
      pricePerUnit: offer.priceValue,
      totalPrice: offer.priceValue * offer.maxQty,
      providerName: offer.provider?.name || 'Verified Seller',
      trustScore: offer.provider?.trustScore || 0.5,
      energyType: `${energyEmoji} ${sourceType.charAt(0) + sourceType.slice(1).toLowerCase()}`,
      savings: savings,
      savingsPercent: savingsPercent,
    };
  });

  // Build formatted message
  let message = ht(
    `⚡ *Top ${deals.length} Green Energy Deals*\n━━━━━━━━━━━━━━━━━━━━\n\n`,
    `⚡ *Top ${deals.length} Green Energy Deals*\n━━━━━━━━━━━━━━━━━━━━\n\n`
  );

  deals.forEach((deal, i) => {
    const trustStars = '⭐'.repeat(Math.round(deal.trustScore * 5));
    message += ht(
      `${i + 1}️⃣ ${deal.energyType} ${deal.quantity} units @ ₹${deal.pricePerUnit}/unit\n` +
      `   💰 Total: ₹${(deal.pricePerUnit * deal.quantity).toFixed(0)}\n` +
      `   🏷️ Save ₹${deal.savings.toFixed(1)}/unit vs DISCOM (${deal.savingsPercent.toFixed(0)}% off!)\n` +
      `   👤 ${deal.providerName} ${trustStars}\n\n`,

      `${i + 1}️⃣ ${deal.energyType} ${deal.quantity} unit @ ₹${deal.pricePerUnit}/unit\n` +
      `   💰 Total: ₹${(deal.pricePerUnit * deal.quantity).toFixed(0)}\n` +
      `   🏷️ DISCOM se ₹${deal.savings.toFixed(1)}/unit bachao (${deal.savingsPercent.toFixed(0)}% off!)\n` +
      `   👤 ${deal.providerName} ${trustStars}\n\n`
    );
  });

  message += ht(
    '💡 Reply with the deal number to buy, or specify your needs (e.g. "50 units tomorrow")',
    '💡 Deal number reply karo ya apni zaroorat batao (jaise "50 unit kal")'
  );

  return { deals, message };
}

/**
 * Get all available offers formatted as a markdown table for "Browse Market".
 */
export async function getBrowseMarketTable(lang?: string): Promise<string> {
  const offers = await prisma.catalogOffer.findMany({
    where: { maxQty: { gt: 0 } },
    include: {
      provider: { select: { name: true, trustScore: true } },
      item: { select: { sourceType: true } },
    },
    orderBy: { priceValue: 'asc' },
    take: 10,
  });

  if (offers.length === 0) {
    return ht(lang,
      'No active offers in the market right now.',
      'Market mein abhi koi active offer nahi hai.'
    );
  }

  // Enhanced table with trust stars and savings indicators
  const DISCOM_RATE = 7; // Reference DISCOM rate for savings calculation

  const rows = offers.map((o, idx) => {
    // Format time window (simplified)
    const start = new Date(o.timeWindowStart);
    const end = new Date(o.timeWindowEnd);
    const timeStr = `${start.getHours()}h-${end.getHours()}h`;

    const type = o.item?.sourceType === 'SOLAR' ? '☀️' :
      o.item?.sourceType === 'WIND' ? '💨' : '⚡';

    const price = `₹${o.priceValue}`;
    const qty = `${o.maxQty}`;
    const name = (o.provider?.name || 'User').split(' ')[0];

    // Trust level indicator (1-5 stars based on trustScore 0-1)
    const trustScore = o.provider?.trustScore ?? 0.5;
    const stars = trustScore >= 0.9 ? '⭐⭐⭐' :
      trustScore >= 0.7 ? '⭐⭐' :
        trustScore >= 0.5 ? '⭐' : '🆕';

    // Savings percentage vs DISCOM
    const savingsPercent = Math.round(((DISCOM_RATE - o.priceValue) / DISCOM_RATE) * 100);
    const savings = savingsPercent > 0 ? `💚${savingsPercent}%` : '';

    // Best deal badge for lowest price
    const badge = idx === 0 ? '🏆' : '';

    return `| ${badge}${name} | ${stars} | ${type} | ${price} ${savings} | ${qty} | ${timeStr} |`;
  });

  // Updated headers with Trust column
  const headers = ht(lang,
    '| Seller | Trust | ⚡ | Price | Qty | Time |',
    '| Seller | Trust | ⚡ | Rate | Qty | Time |'
  );
  const separator = '|---|:---:|:---:|---|---|---|';

  const title = ht(lang, '🏪 *Market Offers*', '🏪 *बाजार ऑफर*');
  const subtitle = ht(lang,
    '_Sorted by price (lowest first) • 🏆 = Best Deal • 💚 = Savings vs DISCOM_',
    '_कीमत के हिसाब से (सबसे सस्ता पहले) • 🏆 = सबसे अच्छा • 💚 = बचत_'
  );
  const footer = ht(lang,
    '💡 _Type "buy" to purchase or "buy 20 kWh" for specific quantity_',
    '💡 _Kharidne ke liye "buy" likho ya "buy 20 kWh"_'
  );

  return `${title}\n${subtitle}\n\n${headers}\n${separator}\n${rows.join('\n')}\n\n${footer}`;
}
