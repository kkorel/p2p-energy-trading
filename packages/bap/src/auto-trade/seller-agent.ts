/**
 * Seller Auto-Trade Agent
 * Automatically creates daily energy listings based on weather conditions
 */

import { prisma } from '../db';
import { addCatalogItem, addOffer, getProviderOffers } from '../seller-catalog';
import {
  getWeatherForAddress,
  calculateSolarMultiplier,
  getTomorrowWeatherSummary,
  type DailyWeatherSummary,
} from './weather-integration';
import { createLogger, calculateAllowedLimit } from '@p2p/shared';

const logger = createLogger('SellerAutoTrade');

export interface SellerAutoTradeResult {
  userId: string;
  configId: string;
  status: 'success' | 'warning_oversell' | 'skipped' | 'error';
  effectiveCapacity: number;
  listedQuantity: number;
  weatherMultiplier: number;
  warningMessage?: string;
  offerId?: string;
  error?: string;
}

/**
 * Run auto-trade for all enabled seller configurations
 */
export async function runSellerAutoTrades(): Promise<SellerAutoTradeResult[]> {
  logger.info('Starting seller auto-trades...');

  const configs = await prisma.sellerAutoTradeConfig.findMany({
    where: { enabled: true },
    include: {
      user: {
        include: {
          provider: true,
        },
      },
    },
  });

  logger.info(`Found ${configs.length} enabled seller auto-trade configs`);

  const results: SellerAutoTradeResult[] = [];

  for (const config of configs) {
    try {
      const result = await executeSellerAutoTrade(config);
      results.push(result);

      // Log execution
      await prisma.sellerAutoTradeExecution.create({
        data: {
          configId: config.id,
          userId: config.userId,
          weatherMultiplier: result.weatherMultiplier,
          effectiveCapacity: result.effectiveCapacity,
          listedQuantity: result.listedQuantity,
          priceUsed: config.pricePerKwh,
          status: result.status,
          warningMessage: result.warningMessage,
          offerId: result.offerId,
        },
      });

      logger.info(`Auto-trade for user ${config.userId}: ${result.status}`, {
        effectiveCapacity: result.effectiveCapacity,
        listedQuantity: result.listedQuantity,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`Auto-trade failed for user ${config.userId}:`, error);

      results.push({
        userId: config.userId,
        configId: config.id,
        status: 'error',
        effectiveCapacity: 0,
        listedQuantity: 0,
        weatherMultiplier: 0,
        error: errorMessage,
      });
    }
  }

  logger.info(`Completed ${results.length} seller auto-trades`);
  return results;
}

/**
 * Execute auto-trade for a single seller
 */
async function executeSellerAutoTrade(
  config: {
    id: string;
    userId: string;
    capacityKwh: number;
    pricePerKwh: number;
    minPrice: number | null;
    energyType: string;
    user: {
      id: string;
      trustScore: number;
      installationAddress: string | null;
      provider: { id: string } | null;
    };
  }
): Promise<SellerAutoTradeResult> {
  const { user } = config;

  // Get provider ID (seller must be registered as provider)
  if (!user.provider) {
    return {
      userId: config.userId,
      configId: config.id,
      status: 'skipped',
      effectiveCapacity: 0,
      listedQuantity: 0,
      weatherMultiplier: 0,
      warningMessage: 'User is not registered as a provider',
    };
  }

  const providerId = user.provider.id;

  // Get trade limit from trust score
  const trustScore = user.trustScore ?? 0.3;
  const tradeLimit = calculateAllowedLimit(trustScore);

  // Get weather forecast
  let weatherMultiplier = 0.7; // Default if weather unavailable
  let weatherSummary: DailyWeatherSummary | null = null;

  if (user.installationAddress) {
    const forecast = await getWeatherForAddress(user.installationAddress);
    if (forecast) {
      // Use TOMORROW's weather since we're listing for tomorrow
      weatherSummary = getTomorrowWeatherSummary(forecast);
      weatherMultiplier = weatherSummary.solarMultiplier;
    }
  }

  // Calculate effective capacity
  // First convert monthly capacity to daily (divide by 30)
  // Then: dailyEffective = (tradeLimit / 100) × dailyCapacity × weatherMultiplier
  // IMPORTANT: Orders can only be placed in integer units, so always round DOWN
  const dailyCapacity = config.capacityKwh / 30;
  const targetCapacity = (tradeLimit / 100) * dailyCapacity * weatherMultiplier;
  const roundedTarget = Math.floor(targetCapacity); // Round DOWN to integer

  // Get existing offers to calculate delta
  const existingOffers = await getProviderOffers(providerId);

  // Calculate tomorrow's date range
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStart = new Date(tomorrow);
  tomorrowStart.setHours(0, 0, 0, 0);
  const tomorrowEnd = new Date(tomorrow);
  tomorrowEnd.setHours(23, 59, 59, 999);

  // Filter offers for tomorrow only
  const tomorrowOffers = existingOffers.filter(o => {
    if (!o.timeWindow?.startTime) return false;
    const offerStart = new Date(o.timeWindow.startTime);
    return offerStart >= tomorrowStart && offerStart <= tomorrowEnd;
  });

  const alreadyListed = tomorrowOffers.reduce(
    (sum, o) => sum + (o.blockStats?.activeCommitment ?? o.maxQuantity),
    0
  );

  // Calculate delta - only list what's needed (integer units only)
  const deltaToList = Math.max(0, roundedTarget - alreadyListed);
  const roundedDelta = Math.floor(deltaToList); // Round DOWN to integer

  let status: 'success' | 'warning_oversell' | 'skipped' = 'success';
  let warningMessage: string | undefined;

  // Check if total would exceed daily capacity
  const totalActiveCommitment = existingOffers.reduce(
    (sum, o) => sum + (o.blockStats?.activeCommitment ?? o.maxQuantity),
    0
  );

  if ((totalActiveCommitment + roundedDelta) > dailyCapacity * 1.1) { // 10% buffer
    status = 'warning_oversell';
    warningMessage = `Warning: Total commitment (${totalActiveCommitment + roundedDelta} units) exceeds daily capacity (${Math.floor(dailyCapacity)} units).`;
    logger.warn(`Over-sell warning for user ${config.userId}: ${warningMessage}`);
  }

  // Skip if nothing more to list (already have enough for tomorrow)
  if (roundedDelta < 1) {
    return {
      userId: config.userId,
      configId: config.id,
      status: 'skipped',
      effectiveCapacity: roundedTarget,
      listedQuantity: 0,
      weatherMultiplier,
      warningMessage: alreadyListed > 0
        ? `Already have ${alreadyListed} units listed for tomorrow (target: ${roundedTarget} units)`
        : 'Effective capacity too low to list (< 1 unit)',
    };
  }

  // Create the offer for tomorrow (6am - 6pm)
  const offerStart = new Date(tomorrow);
  offerStart.setHours(6, 0, 0, 0);
  const offerEnd = new Date(tomorrow);
  offerEnd.setHours(18, 0, 0, 0);

  // Create catalog item
  // Map energyType to valid SourceType (default to SOLAR for 'OTHER')
  const validSourceTypes = ['SOLAR', 'WIND', 'HYDRO', 'BIOMASS', 'GRID'] as const;
  const sourceType = validSourceTypes.includes(config.energyType as typeof validSourceTypes[number])
    ? (config.energyType as typeof validSourceTypes[number])
    : 'SOLAR';

  const item = await addCatalogItem(
    providerId,
    sourceType,
    'SCHEDULED',
    roundedDelta,
    [],
    `auto-${config.userId}-${Date.now()}`
  );

  // Create offer with the delta amount
  const offer = await addOffer(
    item.id,
    providerId,
    config.pricePerKwh,
    'INR',
    roundedDelta,
    {
      startTime: offerStart.toISOString(),
      endTime: offerEnd.toISOString(),
    }
  );

  logger.info(`Auto-trade listing created for ${config.userId}:`, {
    target: roundedTarget,
    alreadyListed,
    delta: roundedDelta,
    weatherMultiplier,
  });

  return {
    userId: config.userId,
    configId: config.id,
    status,
    effectiveCapacity: roundedTarget,
    listedQuantity: roundedDelta,
    weatherMultiplier,
    warningMessage: alreadyListed > 0
      ? `Added ${roundedDelta} units (already had ${alreadyListed} units listed)`
      : undefined,
    offerId: offer.id,
  };
}

/**
 * Create or update seller auto-trade configuration
 */
export async function setupSellerAutoTrade(
  userId: string,
  capacityKwh: number,
  pricePerKwh: number,
  options?: {
    minPrice?: number;
    energyType?: string;
  }
): Promise<{ success: boolean; configId?: string; error?: string }> {
  try {
    const config = await prisma.sellerAutoTradeConfig.upsert({
      where: { userId },
      create: {
        userId,
        enabled: true,
        capacityKwh,
        pricePerKwh,
        minPrice: options?.minPrice,
        energyType: options?.energyType ?? 'SOLAR',
      },
      update: {
        enabled: true,
        capacityKwh,
        pricePerKwh,
        minPrice: options?.minPrice,
        energyType: options?.energyType ?? 'SOLAR',
      },
    });

    return { success: true, configId: config.id };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to setup seller auto-trade:', error);
    return { success: false, error: errorMessage };
  }
}

/**
 * Run auto-trade immediately for a single user (called on "Start Now")
 * This creates the first listing right away instead of waiting for 6 AM
 */
export async function runSingleSellerAutoTrade(userId: string): Promise<SellerAutoTradeResult | null> {
  const config = await prisma.sellerAutoTradeConfig.findUnique({
    where: { userId },
    include: {
      user: {
        include: {
          provider: true,
        },
      },
    },
  });

  if (!config || !config.enabled) {
    return null;
  }

  try {
    const result = await executeSellerAutoTrade(config);

    // Log execution
    await prisma.sellerAutoTradeExecution.create({
      data: {
        configId: config.id,
        userId: config.userId,
        weatherMultiplier: result.weatherMultiplier,
        effectiveCapacity: result.effectiveCapacity,
        listedQuantity: result.listedQuantity,
        priceUsed: config.pricePerKwh,
        status: result.status,
        warningMessage: result.warningMessage,
        offerId: result.offerId,
      },
    });

    logger.info(`[Immediate] Auto-trade for user ${userId}: ${result.status}`, {
      effectiveCapacity: result.effectiveCapacity,
      listedQuantity: result.listedQuantity,
    });

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Immediate] Auto-trade failed for user ${userId}:`, error);
    return {
      userId,
      configId: config.id,
      status: 'error',
      effectiveCapacity: 0,
      listedQuantity: 0,
      weatherMultiplier: 0,
      error: errorMessage,
    };
  }
}

/**
 * Disable seller auto-trade
 */
export async function disableSellerAutoTrade(userId: string): Promise<boolean> {
  try {
    await prisma.sellerAutoTradeConfig.update({
      where: { userId },
      data: { enabled: false },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get seller auto-trade status
 */
export async function getSellerAutoTradeStatus(userId: string): Promise<{
  enabled: boolean;
  config?: {
    capacityKwh: number;
    pricePerKwh: number;
    energyType: string;
  };
  lastExecution?: {
    executedAt: Date;
    status: string;
    listedQuantity: number;
    weatherMultiplier: number;
  };
}> {
  const config = await prisma.sellerAutoTradeConfig.findUnique({
    where: { userId },
  });

  if (!config) {
    return { enabled: false };
  }

  const lastExecution = await prisma.sellerAutoTradeExecution.findFirst({
    where: { userId },
    orderBy: { executedAt: 'desc' },
  });

  return {
    enabled: config.enabled,
    config: {
      capacityKwh: config.capacityKwh,
      pricePerKwh: config.pricePerKwh,
      energyType: config.energyType,
    },
    lastExecution: lastExecution
      ? {
          executedAt: lastExecution.executedAt,
          status: lastExecution.status,
          listedQuantity: lastExecution.listedQuantity,
          weatherMultiplier: lastExecution.weatherMultiplier,
        }
      : undefined,
  };
}

/**
 * Preview what would be listed today (for chat display)
 */
export async function previewAutoTrade(userId: string): Promise<{
  effectiveCapacity: number;
  weatherMultiplier: number;
  condition: string;
  bestWindow: { start: string; end: string } | null;
  wouldOverSell: boolean;
  currentCommitment: number;
} | null> {
  const config = await prisma.sellerAutoTradeConfig.findUnique({
    where: { userId },
    include: {
      user: {
        include: { provider: true },
      },
    },
  });

  if (!config) return null;

  const { user } = config;
  if (!user.provider) return null;

  const trustScore = user.trustScore ?? 0.3;
  const tradeLimit = calculateAllowedLimit(trustScore);

  let weatherMultiplier = 0.7;
  let condition = 'Weather unavailable';
  let bestWindow: { start: string; end: string } | null = null;

  if (user.installationAddress) {
    const forecast = await getWeatherForAddress(user.installationAddress);
    if (forecast) {
      // Use TOMORROW's weather for preview since listing is for tomorrow
      const summary = getTomorrowWeatherSummary(forecast);
      weatherMultiplier = summary.solarMultiplier;
      condition = summary.condition;
      bestWindow = summary.bestWindow;
    }
  }

  // Convert monthly capacity to daily (integer units only)
  const dailyCapacity = config.capacityKwh / 30;
  const effectiveCapacity = Math.floor((tradeLimit / 100) * dailyCapacity * weatherMultiplier);

  const existingOffers = await getProviderOffers(user.provider.id);
  const currentCommitment = existingOffers.reduce(
    (sum, o) => sum + (o.blockStats?.activeCommitment ?? o.maxQuantity),
    0
  );

  const wouldOverSell = (currentCommitment + effectiveCapacity) > dailyCapacity;

  return {
    effectiveCapacity,
    weatherMultiplier,
    condition,
    bestWindow,
    wouldOverSell,
    currentCommitment,
  };
}
