/**
 * Maintenance Alerts
 * Provides reactive alerts after severe weather events
 */

import type { MaintenanceAlertData } from './types';

// Cooldown period between non-hail alerts (3 days in ms)
const ALERT_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;

// Thresholds for triggering alerts
const HEAVY_RAIN_THRESHOLD_MM = 30;
const HIGH_WIND_THRESHOLD_KMH = 50;

/**
 * Check if enough time has passed since last alert
 */
function isWithinCooldown(lastAlertDate: Date | undefined): boolean {
    if (!lastAlertDate) return false;
    return Date.now() - lastAlertDate.getTime() < ALERT_COOLDOWN_MS;
}

/**
 * Get maintenance alert message based on weather conditions
 * Returns null if no alert is needed
 */
export function getMaintenanceAlert(
    weather: MaintenanceAlertData,
    lastAlertDate?: Date
): string | null {
    // Hail always triggers alert (no cooldown)
    if (weather.hadHail) {
        return `⚠️ Hail detected in your area. Please check your solar panels:
• Inspect panels for cracks or damage
• Check for dents on mounting frames
• Look for debris that may have accumulated
• Consider professional inspection if damage is visible`;
    }

    // Other alerts respect cooldown
    if (isWithinCooldown(lastAlertDate)) {
        return null;
    }

    // Heavy rain alert
    if (weather.precipitation24h > HEAVY_RAIN_THRESHOLD_MM) {
        return `⚠️ Heavy rain detected yesterday. Quick panel check:
• Remove leaves or debris from panels
• Check for water pooling near inverter
• Inspect cable connections for moisture`;
    }

    // Thunderstorm alert
    if (weather.hadThunderstorm) {
        return `⚠️ Thunderstorm detected in your area. Safety check:
• Verify inverter is functioning normally
• Check for any tripped breakers
• Inspect cables for any visible damage`;
    }

    // High wind alert
    if (weather.maxWindSpeed > HIGH_WIND_THRESHOLD_KMH) {
        return `⚠️ High winds detected yesterday. Quick check:
• Ensure panels are securely mounted
• Remove any debris blown onto panels
• Check for loose cables or connections`;
    }

    return null;
}

/**
 * Parse weather forecast to extract maintenance alert data
 */
export function extractMaintenanceData(
    hourlyData: Array<{ precipitation: number; windSpeed: number; weatherCode: number }>,
    hours: number = 24
): MaintenanceAlertData {
    const recentHours = hourlyData.slice(-hours);

    const precipitation24h = recentHours.reduce((sum, h) => sum + (h.precipitation || 0), 0);
    const maxWindSpeed = Math.max(...recentHours.map(h => h.windSpeed || 0));

    // WMO Weather Codes:
    // 95, 96, 99 = Thunderstorm
    // 77, 85, 86 = Snow/ice (could include hail-like)
    const hadThunderstorm = recentHours.some(h => [95, 96, 99].includes(h.weatherCode));
    const hadHail = recentHours.some(h => [96, 99].includes(h.weatherCode)); // Thunderstorm with hail

    return {
        precipitation24h,
        maxWindSpeed,
        hadThunderstorm,
        hadHail,
    };
}
