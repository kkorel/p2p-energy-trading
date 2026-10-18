/**
 * Auto-Trade Agent System
 * Exports all auto-trade functionality
 */

// Scheduler
export {
  initAutoTradeScheduler,
  triggerSellerAutoTrades,
  triggerBuyerAutoTrades,
  triggerSolarAdvisories,
  isSchedulerInitialized,
} from './scheduler';

// Seller Agent
export {
  runSellerAutoTrades,
  runSingleSellerAutoTrade,
  setupSellerAutoTrade,
  disableSellerAutoTrade,
  getSellerAutoTradeStatus,
  previewAutoTrade,
  type SellerAutoTradeResult,
} from './seller-agent';

// Buyer Agent
export {
  runBuyerAutoTrades,
  runSingleBuyerAutoTrade,
  setupBuyerAutoTrade,
  disableBuyerAutoTrade,
  getBuyerAutoTradeStatus,
  getBuyAdvice,
  previewBuyerAutoTrade,
  type BuyerAutoTradeResult,
} from './buyer-agent';

// Solar Advisor
export {
  checkSolarAdvisories,
  logPanelCleaning,
  logPanelInspection,
  getMaintenanceHistory,
  getUserSolarAdvisory,
  getSolarTips,
  type SolarAdvisory,
} from './solar-advisor';

// Weather Integration
export {
  getWeatherForecast,
  getWeatherForAddress,
  calculateSolarMultiplier,
  calculateWindMultiplier,
  getBestTimeToBuyAdvice,
  getDailyWeatherSummary,
  getTomorrowWeatherSummary,
  type DailyWeatherSummary,
} from './weather-integration';
