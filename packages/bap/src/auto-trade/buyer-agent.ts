/**
 * Buyer Auto-Trade Agent
 * Automatically purchases energy when prices are lowest (high solar supply)
 */

import { prisma } from '../db';
import { executePurchase, type PurchaseResult } from '../chat/trading-agent';
import {
  getWeatherForAddress,
  getBestTimeToBuyAdvice,
  getDailyWeatherSummary,
  type DailyWeatherSummary,
} from './weather-integration';
import { createLogger } from '@p2p/shared';

const logger = createLogger('BuyerAutoTrade');

export interface BuyerAutoTradeResult {
  userId: string;
  configId: string;
  status: 'success' | 'no_deals' | 'price_too_high' | 'skipped' | 'error';
  quantityBought: number;
  pricePerUnit: number;
  totalSpent: number;
  orderId?: string;
  error?: string;
}

/**
 * Run auto-trade for all enabled buyer configurations
 */
export async function runBuyerAutoTrades(): Promise<BuyerAutoTradeResult[]> {
  logger.info('Starting buyer auto-trades...');

  const configs = await prisma.buyerAutoTradeConfig.findMany({
    where: { enabled: true },
    include: {
      user: true,
    },
  });

  logger.info(`Found ${configs.length} enabled buyer auto-trade configs`);

  const results: BuyerAutoTradeResult[] = [];

  for (const config of configs) {
    try {
      const result = await executeBuyerAutoTrade(config);
      results.push(result);

      // Log execution
      await prisma.buyerAutoTradeExecution.create({
        data: {
          configId: config.id,
          userId: config.userId,
          quantityBought: result.quantityBought,
          pricePerUnit: result.pricePerUnit,
          totalSpent: result.totalSpent,
          status: result.status,
          orderId: result.orderId,
          error: result.error,
        },
      });

      logger.info(`Auto-trade for user ${config.userId}: ${result.status}`, {
        quantityBought: result.quantityBought,
        pricePerUnit: result.pricePerUnit,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`Auto-trade failed for user ${config.userId}:`, error);

      results.push({
        userId: config.userId,
        configId: config.id,
        status: 'error',
        quantityBought: 0,
        pricePerUnit: 0,
        totalSpent: 0,
        error: errorMessage,
      });
    }
  }

  logger.info(`Completed ${results.length} buyer auto-trades`);
  return results;
}

/**
 * Execute auto-trade for a single buyer
 */
async function executeBuyerAutoTrade(
  config: {
    id: string;
    userId: string;
    targetQuantity: number;
    maxPrice: number;
    preferredTime: string | null;
    user: {
      id: string;
      balance: number;
      installationAddress: string | null;
    };
  }
): Promise<BuyerAutoTradeResult> {
  const { user } = config;

  // Check if user has sufficient balance
  const estimatedCost = config.targetQuantity * config.maxPrice;
  if (user.balance < estimatedCost) {
    return {
      userId: config.userId,
      configId: config.id,
      status: 'skipped',
      quantityBought: 0,
      pricePerUnit: 0,
      totalSpent: 0,
      error: `Insufficient balance. Need ₹${estimatedCost.toFixed(0)}, have ₹${user.balance.toFixed(0)}`,
    };
  }

  // Attempt to purchase
  const purchaseResult = await executePurchase(config.userId, {
    quantity: config.targetQuantity,
    maxPrice: config.maxPrice,
  });

  if (!purchaseResult.success) {
    // Determine the specific failure reason
    const error = purchaseResult.error?.toLowerCase() || '';

    if (error.includes('no offers') || error.includes('no deals')) {
      return {
        userId: config.userId,
        configId: config.id,
        status: 'no_deals',
        quantityBought: 0,
        pricePerUnit: 0,
        totalSpent: 0,
        error: purchaseResult.error,
      };
    }

    if (error.includes('price') || error.includes('expensive')) {
      return {
        userId: config.userId,
        configId: config.id,
        status: 'price_too_high',
        quantityBought: 0,
        pricePerUnit: 0,
        totalSpent: 0,
        error: purchaseResult.error,
      };
    }

    return {
      userId: config.userId,
      configId: config.id,
      status: 'error',
      quantityBought: 0,
      pricePerUnit: 0,
      totalSpent: 0,
      error: purchaseResult.error,
    };
  }

  // Success!
  const order = purchaseResult.order!;
  return {
    userId: config.userId,
    configId: config.id,
    status: 'success',
    quantityBought: order.quantity,
    pricePerUnit: order.pricePerKwh,
    totalSpent: order.totalPrice,
    orderId: order.orderId,
  };
}

/**
 * Create or update buyer auto-trade configuration
 */
export async function setupBuyerAutoTrade(
  userId: string,
  targetQuantity: number,
  maxPrice: number,
  options?: {
    preferredTime?: string; // 'morning', 'afternoon', 'evening'
  }
): Promise<{ success: boolean; configId?: string; error?: string }> {
  try {
    const config = await prisma.buyerAutoTradeConfig.upsert({
      where: { userId },
      create: {
        userId,
        enabled: true,
        targetQuantity,
        maxPrice,
        preferredTime: options?.preferredTime,
      },
      update: {
        enabled: true,
        targetQuantity,
        maxPrice,
        preferredTime: options?.preferredTime,
      },
    });

    return { success: true, configId: config.id };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to setup buyer auto-trade:', error);
    return { success: false, error: errorMessage };
  }
}

/**
 * Run auto-trade immediately for a single buyer (called on "Start Now")
 * Attempts to find and execute a purchase right away
 */
export async function runSingleBuyerAutoTrade(userId: string): Promise<BuyerAutoTradeResult | null> {
  const config = await prisma.buyerAutoTradeConfig.findUnique({
    where: { userId },
    include: { user: true },
  });

  if (!config || !config.enabled) {
    return null;
  }

  try {
    const result = await executeBuyerAutoTrade(config);

    // Log execution
    await prisma.buyerAutoTradeExecution.create({
      data: {
        configId: config.id,
        userId: config.userId,
        quantityBought: result.quantityBought,
        pricePerUnit: result.pricePerUnit,
        totalSpent: result.totalSpent,
        status: result.status,
        orderId: result.orderId,
        error: result.error,
      },
    });

    logger.info(`[Immediate] Buyer auto-trade for user ${userId}: ${result.status}`, {
      quantityBought: result.quantityBought,
      pricePerUnit: result.pricePerUnit,
    });

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Immediate] Buyer auto-trade failed for user ${userId}:`, error);
    return {
      userId,
      configId: config.id,
      status: 'error',
      quantityBought: 0,
      pricePerUnit: 0,
      totalSpent: 0,
      error: errorMessage,
    };
  }
}

/**
 * Disable buyer auto-trade
 */
export async function disableBuyerAutoTrade(userId: string): Promise<boolean> {
  try {
    await prisma.buyerAutoTradeConfig.update({
      where: { userId },
      data: { enabled: false },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get buyer auto-trade status
 */
export async function getBuyerAutoTradeStatus(userId: string): Promise<{
  enabled: boolean;
  config?: {
    targetQuantity: number;
    maxPrice: number;
    preferredTime: string | null;
  };
  lastExecution?: {
    executedAt: Date;
    status: string;
    quantityBought: number;
    pricePerUnit: number;
    totalSpent: number;
    error?: string | null;
  };
}> {
  const config = await prisma.buyerAutoTradeConfig.findUnique({
    where: { userId },
  });

  if (!config) {
    return { enabled: false };
  }

  const lastExecution = await prisma.buyerAutoTradeExecution.findFirst({
    where: { userId },
    orderBy: { executedAt: 'desc' },
  });

  return {
    enabled: config.enabled,
    config: {
      targetQuantity: config.targetQuantity,
      maxPrice: config.maxPrice,
      preferredTime: config.preferredTime,
    },
    lastExecution: lastExecution
      ? {
          executedAt: lastExecution.executedAt,
          status: lastExecution.status,
          quantityBought: lastExecution.quantityBought,
          pricePerUnit: lastExecution.pricePerUnit,
          totalSpent: lastExecution.totalSpent,
          error: lastExecution.error,
        }
      : undefined,
  };
}

/**
 * Get best time to buy advice for a user
 */
export async function getBuyAdvice(userId: string, isHindi: boolean = false): Promise<{
  advice: string;
  weatherSummary?: DailyWeatherSummary;
}> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { installationAddress: true },
  });

  // If no address, provide general buying advice without weather personalization
  if (!user?.installationAddress) {
    return {
      advice: isHindi
        ? '💡 *खरीदने की सलाह*\n\n' +
          '• सबसे अच्छा समय: सुबह 10 बजे से दोपहर 2 बजे तक\n' +
          '• इस समय सोलर प्रोडक्शन सबसे ज्यादा = सप्लाई ज्यादा = दाम कम\n' +
          '• बारिश/बादल वाले दिन दाम थोड़े ज्यादा हो सकते हैं'
        : '💡 *Best Time to Buy*\n\n' +
          '• Best window: 10 AM - 2 PM (peak solar hours)\n' +
          '• High solar production = more supply = lower prices\n' +
          '• Cloudy/rainy days may have slightly higher prices',
    };
  }

  const forecast = await getWeatherForAddress(user.installationAddress);
  if (!forecast) {
    return {
      advice: isHindi
        ? 'मौसम का डेटा उपलब्ध नहीं है। आम तौर पर सुबह 10 बजे से दोपहर 2 बजे तक खरीदना सबसे अच्छा है।'
        : 'Weather data not available. Generally, 10 AM - 2 PM is the best time to buy.',
    };
  }

  const weatherSummary = getDailyWeatherSummary(forecast);
  const advice = getBestTimeToBuyAdvice(forecast, isHindi);

  return { advice, weatherSummary };
}

/**
 * Preview what would happen with auto-buy today
 */
export async function previewBuyerAutoTrade(userId: string, isHindi: boolean = false): Promise<{
  advice: string;
  config?: {
    targetQuantity: number;
    maxPrice: number;
  };
  estimatedCost: number;
  canAfford: boolean;
  balance: number;
} | null> {
  const config = await prisma.buyerAutoTradeConfig.findUnique({
    where: { userId },
    include: { user: true },
  });

  if (!config) return null;

  const { advice } = await getBuyAdvice(userId, isHindi);
  const estimatedCost = config.targetQuantity * config.maxPrice;
  const canAfford = config.user.balance >= estimatedCost;

  return {
    advice,
    config: {
      targetQuantity: config.targetQuantity,
      maxPrice: config.maxPrice,
    },
    estimatedCost,
    canAfford,
    balance: config.user.balance,
  };
}
