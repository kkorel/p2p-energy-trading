/**
 * Solar Advisor
 * Provides maintenance recommendations based on weather and performance
 */

import { prisma } from '../db';
import {
  getWeatherForAddress,
  checkRainExpected,
  getDailyWeatherSummary,
} from './weather-integration';
import { createLogger } from '@p2p/shared';

const logger = createLogger('SolarAdvisor');

export interface SolarAdvisory {
  userId: string;
  type: 'cleaning_recommended' | 'performance_drop' | 'rain_cleaning' | 'dust_storm' | 'good_conditions';
  message: string;
  messageHi: string;
  priority: 'low' | 'medium' | 'high';
}

/**
 * Check solar advisories for all sellers with auto-trade enabled
 */
export async function checkSolarAdvisories(): Promise<SolarAdvisory[]> {
  logger.info('Checking solar advisories...');

  const sellers = await prisma.sellerAutoTradeConfig.findMany({
    where: { enabled: true },
    include: {
      user: {
        select: {
          id: true,
          installationAddress: true,
        },
      },
    },
  });

  const advisories: SolarAdvisory[] = [];

  for (const seller of sellers) {
    try {
      const advisory = await checkSellerAdvisory(seller);
      if (advisory) {
        advisories.push(advisory);
      }
    } catch (error) {
      logger.error(`Failed to check advisory for user ${seller.userId}:`, error);
    }
  }

  logger.info(`Generated ${advisories.length} solar advisories`);
  return advisories;
}

/**
 * Check advisory for a single seller
 */
async function checkSellerAdvisory(seller: {
  id: string;
  userId: string;
  capacityKwh: number;
  user: {
    id: string;
    installationAddress: string | null;
  };
}): Promise<SolarAdvisory | null> {
  if (!seller.user.installationAddress) {
    return null;
  }

  const forecast = await getWeatherForAddress(seller.user.installationAddress);
  if (!forecast) {
    return null;
  }

  // 1. Check for dust storm / high wind in past 24 hours (PRIORITY - needs immediate cleaning)
  const dustStormDetected = checkDustStormYesterday(forecast);
  if (dustStormDetected) {
    return {
      userId: seller.userId,
      type: 'dust_storm',
      message: '🌪️ High winds detected in the past 24 hours! Dust and debris may have settled on your panels. Please clean them today for optimal performance.',
      messageHi: '🌪️ पिछले 24 घंटों में तेज़ हवा चली! धूल और कचरा पैनल पर जम सकता है। आज साफ करो ताकि अच्छी बिजली बने।',
      priority: 'high',
    };
  }

  // 2. Check for rain-based cleaning opportunity
  const rainExpected = checkRainExpected(forecast);
  if (rainExpected) {
    return {
      userId: seller.userId,
      type: 'rain_cleaning',
      message: 'Rain expected! This is a good natural cleaning opportunity. After rain, check your panels for any residue and wipe if needed.',
      messageHi: 'बारिश आने वाली है! यह प्राकृतिक सफाई का अच्छा मौका है। बारिश के बाद पैनल चेक करो और ज़रूरत हो तो पोंछ लो।',
      priority: 'low',
    };
  }

  // 3. Check if cleaning is due (no cleaning in last 30 days)
  const lastCleaning = await prisma.solarMaintenanceLog.findFirst({
    where: {
      userId: seller.userId,
      action: 'cleaned',
    },
    orderBy: { performedAt: 'desc' },
  });

  const daysSinceCleaning = lastCleaning
    ? Math.floor((Date.now() - lastCleaning.performedAt.getTime()) / (1000 * 60 * 60 * 24))
    : 999;

  const weatherSummary = getDailyWeatherSummary(forecast);

  if (daysSinceCleaning > 30 && weatherSummary.avgCloudCover < 30) {
    return {
      userId: seller.userId,
      type: 'cleaning_recommended',
      message: `Panel cleaning recommended! It's been ${daysSinceCleaning} days since last cleaning. Clear weather today is perfect for cleaning and maximizing output.`,
      messageHi: `पैनल साफ करने का समय! पिछली सफाई के ${daysSinceCleaning} दिन हो गए। आज मौसम साफ है - सफाई करने का बढ़िया मौका।`,
      priority: 'medium',
    };
  }

  // 4. Check for performance drop
  const performanceDrop = await detectPerformanceDrop(seller.userId, seller.capacityKwh);
  if (performanceDrop > 20) {
    return {
      userId: seller.userId,
      type: 'performance_drop',
      message: `Performance drop detected! Your output is ${performanceDrop}% below expected. This could indicate dirty panels, shading issues, or equipment problems. Please inspect your system.`,
      messageHi: `परफॉर्मेंस गिरावट! आपका आउटपुट उम्मीद से ${performanceDrop}% कम है। यह गंदे पैनल, छाया, या उपकरण समस्या हो सकती है। सिस्टम चेक करो।`,
      priority: 'high',
    };
  }

  // 5. If conditions are good, return a positive advisory
  if (weatherSummary.solarMultiplier >= 0.75) {
    return {
      userId: seller.userId,
      type: 'good_conditions',
      message: `Great conditions today! ${weatherSummary.condition} - expect strong solar production.`,
      messageHi: `आज मौसम बढ़िया है! ${weatherSummary.condition} - अच्छी सोलर प्रोडक्शन होगी।`,
      priority: 'low',
    };
  }

  return null;
}

/**
 * Detect performance drop by comparing actual vs expected output
 */
async function detectPerformanceDrop(userId: string, expectedCapacity: number): Promise<number> {
  // Get last 7 days of executions
  const recentExecutions = await prisma.sellerAutoTradeExecution.findMany({
    where: {
      userId,
      executedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      status: 'success',
    },
  });

  if (recentExecutions.length < 3) return 0; // Not enough data

  // Calculate average actual output
  const avgActual = recentExecutions.reduce((sum, e) => sum + e.listedQuantity, 0) / recentExecutions.length;

  // Calculate expected output (accounting for weather)
  const avgExpected = recentExecutions.reduce((sum, e) => sum + e.effectiveCapacity, 0) / recentExecutions.length;

  if (avgExpected === 0) return 0;

  const dropPercent = Math.round(((avgExpected - avgActual) / avgExpected) * 100);
  return Math.max(0, dropPercent);
}

/**
 * Check if there was a dust storm / high wind event in the past 24 hours
 * High winds (>40 km/h) can carry dust and debris onto panels
 */
function checkDustStormYesterday(forecast: { hourly: Array<{ time: Date; windSpeed: number }> }): boolean {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // Check past 24 hours for high wind events (dust storm indicator)
  const past24Hours = forecast.hourly.filter(h =>
    h.time >= yesterday && h.time <= now
  );

  // Wind speed > 40 km/h is considered high enough to carry dust
  const highWindThreshold = 40;
  const hasHighWind = past24Hours.some(h => h.windSpeed > highWindThreshold);

  // Also check for sustained moderate winds (>25 km/h for 3+ hours)
  const moderateWindThreshold = 25;
  let consecutiveModerateHours = 0;
  for (const hour of past24Hours) {
    if (hour.windSpeed > moderateWindThreshold) {
      consecutiveModerateHours++;
      if (consecutiveModerateHours >= 3) return true;
    } else {
      consecutiveModerateHours = 0;
    }
  }

  return hasHighWind;
}

/**
 * Log when user reports panel cleaning
 */
export async function logPanelCleaning(userId: string, notes?: string): Promise<void> {
  await prisma.solarMaintenanceLog.create({
    data: {
      userId,
      action: 'cleaned',
      reportedBy: 'user',
      notes,
    },
  });
  logger.info(`Panel cleaning logged for user ${userId}`);
}

/**
 * Log panel inspection
 */
export async function logPanelInspection(userId: string, notes?: string): Promise<void> {
  await prisma.solarMaintenanceLog.create({
    data: {
      userId,
      action: 'inspected',
      reportedBy: 'user',
      notes,
    },
  });
  logger.info(`Panel inspection logged for user ${userId}`);
}

/**
 * Get maintenance history for a user
 */
export async function getMaintenanceHistory(userId: string, limit: number = 10): Promise<{
  action: string;
  performedAt: Date;
  notes: string | null;
}[]> {
  const logs = await prisma.solarMaintenanceLog.findMany({
    where: { userId },
    orderBy: { performedAt: 'desc' },
    take: limit,
    select: {
      action: true,
      performedAt: true,
      notes: true,
    },
  });

  return logs;
}

/**
 * Get advisory for a specific user (for chat)
 */
export async function getUserSolarAdvisory(userId: string, isHindi: boolean = false): Promise<{
  type: string;
  message: string;
  priority: string;
  daysSinceCleaning: number;
} | null> {
  const config = await prisma.sellerAutoTradeConfig.findUnique({
    where: { userId },
    include: {
      user: {
        select: { installationAddress: true },
      },
    },
  });

  if (!config) return null;

  // Get days since last cleaning
  const lastCleaning = await prisma.solarMaintenanceLog.findFirst({
    where: {
      userId,
      action: 'cleaned',
    },
    orderBy: { performedAt: 'desc' },
  });

  const daysSinceCleaning = lastCleaning
    ? Math.floor((Date.now() - lastCleaning.performedAt.getTime()) / (1000 * 60 * 60 * 24))
    : -1; // -1 means never cleaned (or no record)

  // Get weather-based advisory
  if (!config.user.installationAddress) {
    return {
      type: 'no_address',
      message: isHindi
        ? 'पता नहीं है। मौसम के हिसाब से सलाह नहीं दे सकता।'
        : 'No address on file. Cannot provide weather-based advice.',
      priority: 'low',
      daysSinceCleaning,
    };
  }

  const forecast = await getWeatherForAddress(config.user.installationAddress);
  if (!forecast) {
    return {
      type: 'no_weather',
      message: isHindi
        ? 'मौसम का डेटा नहीं मिला।'
        : 'Could not fetch weather data.',
      priority: 'low',
      daysSinceCleaning,
    };
  }

  // Check rain first
  const rainExpected = checkRainExpected(forecast);
  if (rainExpected) {
    return {
      type: 'rain_cleaning',
      message: isHindi
        ? 'बारिश आने वाली है! प्राकृतिक सफाई का मौका। बारिश के बाद पैनल चेक करो।'
        : 'Rain expected! Natural cleaning opportunity. Check panels after rain.',
      priority: 'low',
      daysSinceCleaning,
    };
  }

  // Check if cleaning needed
  if (daysSinceCleaning > 30 || daysSinceCleaning === -1) {
    const daysText = daysSinceCleaning === -1
      ? (isHindi ? 'कभी नहीं' : 'never recorded')
      : `${daysSinceCleaning} ${isHindi ? 'दिन पहले' : 'days ago'}`;

    return {
      type: 'cleaning_recommended',
      message: isHindi
        ? `पैनल साफ करने का समय! आखिरी सफाई: ${daysText}। साफ पैनल से 10-15% ज्यादा बिजली बनती है।`
        : `Time to clean your panels! Last cleaned: ${daysText}. Clean panels produce 10-15% more power.`,
      priority: 'medium',
      daysSinceCleaning,
    };
  }

  // Check performance
  const performanceDrop = await detectPerformanceDrop(userId, config.capacityKwh);
  if (performanceDrop > 20) {
    return {
      type: 'performance_drop',
      message: isHindi
        ? `सावधान! आउटपुट ${performanceDrop}% कम है। पैनल चेक करो - शायद गंदे हैं या कोई समस्या है।`
        : `Warning! Output is ${performanceDrop}% below expected. Check panels - they may be dirty or have issues.`,
      priority: 'high',
      daysSinceCleaning,
    };
  }

  // All good
  const weatherSummary = getDailyWeatherSummary(forecast);
  return {
    type: 'all_good',
    message: isHindi
      ? `सब ठीक है! ${weatherSummary.condition} पिछली सफाई: ${daysSinceCleaning} दिन पहले।`
      : `All good! ${weatherSummary.condition} Last cleaned: ${daysSinceCleaning} days ago.`,
    priority: 'low',
    daysSinceCleaning,
  };
}

/**
 * Get solar tips based on current conditions
 */
export function getSolarTips(isHindi: boolean = false): string[] {
  if (isHindi) {
    return [
      'हर 30 दिन में पैनल साफ करो',
      'सुबह या शाम को साफ करो, दोपहर में गर्म होते हैं',
      'बारिश के बाद भी पैनल चेक करो - कभी-कभी गंदगी रह जाती है',
      'पेड़ों की छाया से बचाओ - एक पैनल पर छाया पूरे सिस्टम को प्रभावित करती है',
      'इन्वर्टर की लाइट रोज़ चेक करो',
    ];
  }

  return [
    'Clean panels every 30 days for optimal performance',
    'Clean in morning or evening - panels get hot in afternoon',
    'Check after rain too - residue can remain',
    'Avoid tree shadows - shade on one panel affects whole system',
    'Check inverter lights daily for any warnings',
  ];
}
