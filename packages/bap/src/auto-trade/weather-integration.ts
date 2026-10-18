/**
 * Weather Integration for Auto-Trade Agent
 * Wraps the shared weather service for auto-trade specific use cases
 */

import {
  getWeatherForecast as fetchForecast,
  getSolarMultiplier as getSolarMult,
  getWindMultiplier as getWindMult,
  getWeatherConditionString,
  findBestTradingWindow,
  geocodeAddress,
  type WeatherForecast,
  type SourceType,
} from '@p2p/shared';

export { type WeatherForecast, type SourceType };

/**
 * Get weather forecast for a location
 */
export async function getWeatherForecast(lat: number, lon: number): Promise<WeatherForecast | null> {
  return fetchForecast(lat, lon);
}

/**
 * Get weather forecast from an address string
 */
export async function getWeatherForAddress(address: string): Promise<WeatherForecast | null> {
  const location = await geocodeAddress(address);
  if (!location) return null;
  return fetchForecast(location.lat, location.lon);
}

/**
 * Calculate solar multiplier based on cloud cover
 * Returns 0.25-1.0 based on cloud conditions
 */
export function calculateSolarMultiplier(cloudCover: number): number {
  return getSolarMult(cloudCover);
}

/**
 * Calculate wind multiplier based on wind speed
 */
export function calculateWindMultiplier(windSpeed: number): number {
  return getWindMult(windSpeed);
}

/**
 * Get average cloud cover from forecast for a time window
 */
export function getAverageCloudCover(
  forecast: WeatherForecast,
  startHour: number = 6,
  endHour: number = 18
): number {
  const today = new Date();
  today.setHours(startHour, 0, 0, 0);
  const end = new Date();
  end.setHours(endHour, 0, 0, 0);

  const relevantHours = forecast.hourly.filter(h =>
    h.time >= today && h.time <= end
  );

  if (relevantHours.length === 0) return 50; // Default to 50% if no data

  return relevantHours.reduce((sum, h) => sum + h.cloudCover, 0) / relevantHours.length;
}

/**
 * Get weather condition string for display
 */
export function getConditionString(forecast: WeatherForecast): string {
  const avgCloud = getAverageCloudCover(forecast);
  const avgWind = forecast.hourly.reduce((sum, h) => sum + h.windSpeed, 0) / forecast.hourly.length;
  return getWeatherConditionString(avgCloud, avgWind);
}

/**
 * Find the best time window to buy energy (when solar supply is highest)
 * Returns the window with lowest cloud cover (highest solar production)
 */
export function findBestBuyingWindow(
  forecast: WeatherForecast,
  date: Date = new Date()
): { start: string; end: string; multiplier: number } | null {
  return findBestTradingWindow(forecast, 'SOLAR', date);
}

/**
 * Get best time to buy advice message
 */
export function getBestTimeToBuyAdvice(forecast: WeatherForecast, isHindi: boolean = false): string {
  const bestWindow = findBestBuyingWindow(forecast);

  if (!bestWindow) {
    return isHindi
      ? 'आज के मौसम का डेटा उपलब्ध नहीं है।'
      : 'Weather data not available for today.';
  }

  if (bestWindow.multiplier >= 0.75) {
    return isHindi
      ? `खरीदने का सबसे अच्छा समय: ${bestWindow.start} - ${bestWindow.end} (साफ आसमान, ज्यादा सोलर = कम दाम)`
      : `Best time to buy: ${bestWindow.start} - ${bestWindow.end} (clear skies, high solar supply = lower prices)`;
  }

  if (bestWindow.multiplier >= 0.45) {
    return isHindi
      ? `ठीक-ठाक समय: ${bestWindow.start} - ${bestWindow.end} (कुछ बादल, सामान्य दाम)`
      : `Decent window: ${bestWindow.start} - ${bestWindow.end} (partly cloudy, normal prices)`;
  }

  return isHindi
    ? 'आज बादल हैं - दाम थोड़े ज्यादा रहेंगे। कल बेहतर हो सकता है।'
    : 'Cloudy today - expect higher prices. Tomorrow might be better.';
}

/**
 * Check if there's rain expected (good for natural panel cleaning)
 */
export function checkRainExpected(forecast: WeatherForecast): boolean {
  const next24Hours = forecast.hourly.slice(0, 24);
  return next24Hours.some(h => h.precipitation > 5);
}

/**
 * Get weather summary for auto-trade
 */
export interface DailyWeatherSummary {
  avgCloudCover: number;
  solarMultiplier: number;
  condition: string;
  bestWindow: { start: string; end: string } | null;
  rainExpected: boolean;
}

/**
 * Get weather summary for a specific date (default: today)
 */
export function getDailyWeatherSummary(forecast: WeatherForecast, date: Date = new Date()): DailyWeatherSummary {
  const avgCloudCover = getAverageCloudCoverForDate(forecast, date);
  const solarMultiplier = calculateSolarMultiplier(avgCloudCover);
  const condition = getConditionStringForDate(forecast, date);
  const bestWindow = findBestBuyingWindow(forecast, date);
  const rainExpected = checkRainExpectedForDate(forecast, date);

  return {
    avgCloudCover,
    solarMultiplier,
    condition,
    bestWindow: bestWindow ? { start: bestWindow.start, end: bestWindow.end } : null,
    rainExpected,
  };
}

/**
 * Get tomorrow's weather summary (for auto-sell listings)
 */
export function getTomorrowWeatherSummary(forecast: WeatherForecast): DailyWeatherSummary {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return getDailyWeatherSummary(forecast, tomorrow);
}

/**
 * Get average cloud cover for a specific date
 */
function getAverageCloudCoverForDate(
  forecast: WeatherForecast,
  date: Date,
  startHour: number = 6,
  endHour: number = 18
): number {
  const dayStart = new Date(date);
  dayStart.setHours(startHour, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(endHour, 0, 0, 0);

  const relevantHours = forecast.hourly.filter(h =>
    h.time >= dayStart && h.time <= dayEnd
  );

  if (relevantHours.length === 0) return 50; // Default to 50% if no data

  return relevantHours.reduce((sum, h) => sum + h.cloudCover, 0) / relevantHours.length;
}

/**
 * Get weather condition string for a specific date
 */
function getConditionStringForDate(forecast: WeatherForecast, date: Date): string {
  const avgCloud = getAverageCloudCoverForDate(forecast, date);
  const dayStart = new Date(date);
  dayStart.setHours(6, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(18, 0, 0, 0);

  const relevantHours = forecast.hourly.filter(h =>
    h.time >= dayStart && h.time <= dayEnd
  );
  const avgWind = relevantHours.length > 0
    ? relevantHours.reduce((sum, h) => sum + h.windSpeed, 0) / relevantHours.length
    : 10;

  return getWeatherConditionString(avgCloud, avgWind);
}

/**
 * Check if rain is expected for a specific date
 */
function checkRainExpectedForDate(forecast: WeatherForecast, date: Date): boolean {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(23, 59, 59, 999);

  const dayHours = forecast.hourly.filter(h =>
    h.time >= dayStart && h.time <= dayEnd
  );
  return dayHours.some(h => h.precipitation > 5);
}
