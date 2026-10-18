/**
 * Auto-Trade Scheduler
 * Uses node-cron for daily scheduled execution of auto-trade agents
 */

import cron from 'node-cron';
import { runSellerAutoTrades } from './seller-agent';
import { runBuyerAutoTrades } from './buyer-agent';
import { checkSolarAdvisories } from './solar-advisor';
import { createLogger } from '@p2p/shared';

const logger = createLogger('AutoTradeScheduler');

let isInitialized = false;

/**
 * Initialize the auto-trade scheduler
 * Sets up cron jobs for:
 * - Seller auto-trades at 6:00 AM
 * - Buyer auto-trades at 6:30 AM
 * - Solar advisories at 7:00 AM
 */
export function initAutoTradeScheduler(): void {
  if (isInitialized) {
    logger.warn('Auto-trade scheduler already initialized');
    return;
  }

  // Run seller auto-trades at 6:00 AM daily (IST)
  // Cron format: minute hour day month weekday
  cron.schedule('0 6 * * *', async () => {
    logger.info('[Cron] Running seller auto-trades at 6:00 AM...');
    try {
      const results = await runSellerAutoTrades();
      const successful = results.filter(r => r.status === 'success').length;
      const warnings = results.filter(r => r.status === 'warning_oversell').length;
      const skipped = results.filter(r => r.status === 'skipped').length;
      const errors = results.filter(r => r.status === 'error').length;

      logger.info(`[Cron] Seller auto-trades completed: ${successful} success, ${warnings} warnings, ${skipped} skipped, ${errors} errors`);
    } catch (error) {
      logger.error('[Cron] Seller auto-trades failed:', error);
    }
  }, {
    timezone: 'Asia/Kolkata',
  });

  // Run buyer auto-trades at 6:30 AM daily (after sellers have listed)
  cron.schedule('30 6 * * *', async () => {
    logger.info('[Cron] Running buyer auto-trades at 6:30 AM...');
    try {
      const results = await runBuyerAutoTrades();
      const successful = results.filter(r => r.status === 'success').length;
      const noDeals = results.filter(r => r.status === 'no_deals').length;
      const priceHigh = results.filter(r => r.status === 'price_too_high').length;
      const errors = results.filter(r => r.status === 'error').length;

      logger.info(`[Cron] Buyer auto-trades completed: ${successful} success, ${noDeals} no deals, ${priceHigh} price too high, ${errors} errors`);
    } catch (error) {
      logger.error('[Cron] Buyer auto-trades failed:', error);
    }
  }, {
    timezone: 'Asia/Kolkata',
  });

  // Check solar advisories at 7:00 AM daily
  cron.schedule('0 7 * * *', async () => {
    logger.info('[Cron] Checking solar advisories at 7:00 AM...');
    try {
      const advisories = await checkSolarAdvisories();
      const high = advisories.filter(a => a.priority === 'high').length;
      const medium = advisories.filter(a => a.priority === 'medium').length;
      const low = advisories.filter(a => a.priority === 'low').length;

      logger.info(`[Cron] Solar advisories generated: ${high} high, ${medium} medium, ${low} low priority`);
    } catch (error) {
      logger.error('[Cron] Solar advisories check failed:', error);
    }
  }, {
    timezone: 'Asia/Kolkata',
  });

  isInitialized = true;
  logger.info('Auto-trade scheduler initialized successfully');
  logger.info('Scheduled jobs:');
  logger.info('  - Seller auto-trades: 6:00 AM IST daily');
  logger.info('  - Buyer auto-trades: 6:30 AM IST daily');
  logger.info('  - Solar advisories: 7:00 AM IST daily');
}

/**
 * Manually trigger seller auto-trades (for testing/admin)
 */
export async function triggerSellerAutoTrades(): Promise<void> {
  logger.info('[Manual] Triggering seller auto-trades...');
  const results = await runSellerAutoTrades();
  logger.info(`[Manual] Seller auto-trades completed: ${results.length} processed`);
}

/**
 * Manually trigger buyer auto-trades (for testing/admin)
 */
export async function triggerBuyerAutoTrades(): Promise<void> {
  logger.info('[Manual] Triggering buyer auto-trades...');
  const results = await runBuyerAutoTrades();
  logger.info(`[Manual] Buyer auto-trades completed: ${results.length} processed`);
}

/**
 * Manually trigger solar advisories (for testing/admin)
 */
export async function triggerSolarAdvisories(): Promise<void> {
  logger.info('[Manual] Triggering solar advisories...');
  const advisories = await checkSolarAdvisories();
  logger.info(`[Manual] Solar advisories completed: ${advisories.length} generated`);
}

/**
 * Check if scheduler is running
 */
export function isSchedulerInitialized(): boolean {
  return isInitialized;
}
