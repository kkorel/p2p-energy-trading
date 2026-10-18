/**
 * Weather Service
 * Fetches weather data from Open-Meteo and calculates capacity multipliers
 */

import { createLogger } from '../utils';
import type { GeoLocation, WeatherForecast, HourlyWeather, SourceType, WeatherCapacity } from './types';

const logger = createLogger('WeatherService');

const OPEN_METEO_API = 'https://api.open-meteo.com/v1';
const OPEN_METEO_GEOCODING = 'https://geocoding-api.open-meteo.com/v1';

// Open-Meteo API response types
interface GeocodingResult {
    latitude: number;
    longitude: number;
    name: string;
}

interface GeocodingApiResponse {
    results?: GeocodingResult[];
}

interface WeatherApiResponse {
    hourly: {
        time: string[];
        cloud_cover: number[];
        wind_speed_10m: number[];
        precipitation: number[];
        weather_code: number[];
    };
}

// Cache forecasts to avoid excessive API calls (1 hour TTL)
const forecastCache = new Map<string, { forecast: WeatherForecast; expiresAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Geocode an address to lat/lon coordinates
 */
export async function geocodeAddress(address: string): Promise<GeoLocation | null> {
    try {
        // Extract city/location from address for better results
        const searchQuery = encodeURIComponent(address);
        const url = `${OPEN_METEO_GEOCODING}/search?name=${searchQuery}&count=1&language=en&format=json`;

        const response = await fetch(url);
        if (!response.ok) {
            logger.warn('Geocoding API error', { status: response.status, address });
            return null;
        }

        const data = await response.json() as GeocodingApiResponse;
        if (!data.results || data.results.length === 0) {
            logger.warn('No geocoding results found', { address });
            return null;
        }

        const result = data.results[0];
        return {
            lat: result.latitude,
            lon: result.longitude,
            city: result.name,
        };
    } catch (error) {
        logger.error('Geocoding failed', { error, address });
        return null;
    }
}

/**
 * Fetch weather forecast from Open-Meteo
 */
export async function getWeatherForecast(lat: number, lon: number): Promise<WeatherForecast | null> {
    const cacheKey = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const cached = forecastCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
        return cached.forecast;
    }

    try {
        const url = `${OPEN_METEO_API}/forecast?latitude=${lat}&longitude=${lon}&hourly=cloud_cover,wind_speed_10m,precipitation,weather_code&timezone=auto&forecast_days=2`;

        const response = await fetch(url);
        if (!response.ok) {
            logger.warn('Weather API error', { status: response.status });
            return null;
        }

        const data = await response.json() as WeatherApiResponse;

        const hourly: HourlyWeather[] = data.hourly.time.map((time: string, i: number) => ({
            time: new Date(time),
            cloudCover: data.hourly.cloud_cover[i] ?? 50,
            windSpeed: data.hourly.wind_speed_10m[i] ?? 10,
            precipitation: data.hourly.precipitation[i] ?? 0,
            weatherCode: data.hourly.weather_code[i] ?? 0,
        }));

        const forecast: WeatherForecast = {
            location: { lat, lon },
            hourly,
            fetchedAt: new Date(),
        };

        forecastCache.set(cacheKey, { forecast, expiresAt: Date.now() + CACHE_TTL_MS });
        return forecast;
    } catch (error) {
        logger.error('Weather fetch failed', { error, lat, lon });
        return null;
    }
}

/**
 * Get solar multiplier based on cloud cover
 */
export function getSolarMultiplier(cloudCover: number): number {
    if (cloudCover < 20) return 1.0;      // Clear
    if (cloudCover < 50) return 0.75;     // Partly cloudy
    if (cloudCover < 80) return 0.45;     // Overcast
    return 0.25;                          // Heavy cloud/rain
}

/**
 * Get wind multiplier based on wind speed (km/h)
 */
export function getWindMultiplier(windSpeed: number): number {
    if (windSpeed < 5) return 0.1;        // Too calm
    if (windSpeed < 12) return 0.4;       // Light wind
    if (windSpeed <= 25) return 1.0;      // Optimal
    if (windSpeed <= 50) return 0.8;      // High but OK
    if (windSpeed <= 80) return 0.5;      // Very high
    return 0.0;                           // Safety shutdown
}

/**
 * Get hydro multiplier (weather-independent)
 */
export function getHydroMultiplier(): number {
    return 1.0;
}

/**
 * Calculate weather multiplier for a specific source type and time window
 */
export function calculateWeatherMultiplier(
    forecast: WeatherForecast,
    sourceType: SourceType,
    windowStart: Date,
    windowEnd: Date
): number {
    // Filter hourly data to the time window
    const relevantHours = forecast.hourly.filter(h =>
        h.time >= windowStart && h.time <= windowEnd
    );

    if (relevantHours.length === 0) {
        // No data for window, use conservative estimate
        return 0.7;
    }

    // Calculate average conditions
    const avgCloudCover = relevantHours.reduce((sum, h) => sum + h.cloudCover, 0) / relevantHours.length;
    const avgWindSpeed = relevantHours.reduce((sum, h) => sum + h.windSpeed, 0) / relevantHours.length;

    switch (sourceType) {
        case 'SOLAR':
            return getSolarMultiplier(avgCloudCover);
        case 'WIND':
            return getWindMultiplier(avgWindSpeed);
        case 'HYDRO':
            return getHydroMultiplier();
        default:
            // For 'OTHER', 'BIOMASS', 'GRID', assume solar-like behavior
            return getSolarMultiplier(avgCloudCover);
    }
}

/**
 * Get friendly weather condition string (opaque to users)
 */
export function getWeatherConditionString(cloudCover: number, windSpeed: number): string {
    if (cloudCover < 20) return 'Clear skies ☀️';
    if (cloudCover < 40) return 'Slightly sunny 🌤️';
    if (cloudCover < 60) return 'Partly cloudy ⛅';
    if (cloudCover < 80) return 'Cloudy ☁️';
    return 'Overcast 🌧️';
}

/**
 * Find the best trading window within 6am-6pm for a given day
 */
export function findBestTradingWindow(
    forecast: WeatherForecast,
    sourceType: SourceType,
    date: Date
): { start: string; end: string; multiplier: number } | null {
    // Get hours between 6am and 6pm for the given date
    const dayStart = new Date(date);
    dayStart.setHours(6, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(18, 0, 0, 0);

    const tradingHours = forecast.hourly.filter(h =>
        h.time >= dayStart && h.time <= dayEnd
    );

    if (tradingHours.length === 0) return null;

    // Find the best contiguous 4-hour window
    let bestStart = 0;
    let bestMultiplier = 0;

    for (let i = 0; i <= tradingHours.length - 4; i++) {
        const windowHours = tradingHours.slice(i, i + 4);
        const avgCloud = windowHours.reduce((s, h) => s + h.cloudCover, 0) / 4;
        const avgWind = windowHours.reduce((s, h) => s + h.windSpeed, 0) / 4;

        const multiplier = sourceType === 'WIND'
            ? getWindMultiplier(avgWind)
            : getSolarMultiplier(avgCloud);

        if (multiplier > bestMultiplier) {
            bestMultiplier = multiplier;
            bestStart = i;
        }
    }

    const startHour = tradingHours[bestStart].time;
    const endHour = new Date(startHour.getTime() + 4 * 60 * 60 * 1000);

    return {
        start: startHour.toTimeString().slice(0, 5),
        end: endHour.toTimeString().slice(0, 5),
        multiplier: bestMultiplier,
    };
}

/**
 * Get weather-adjusted capacity for a user
 */
export async function getWeatherAdjustedCapacity(
    baseCapacity: number,
    installationAddress: string,
    sourceType: SourceType,
    windowStart?: Date,
    windowEnd?: Date
): Promise<WeatherCapacity> {
    // Default window is today 6am-6pm
    const now = new Date();
    const defaultStart = new Date(now);
    defaultStart.setHours(6, 0, 0, 0);
    const defaultEnd = new Date(now);
    defaultEnd.setHours(18, 0, 0, 0);

    const start = windowStart || defaultStart;
    const end = windowEnd || defaultEnd;

    // Geocode address
    const location = await geocodeAddress(installationAddress);
    if (!location) {
        // No location found, return base capacity with generic message
        return {
            baseCapacity,
            effectiveCapacity: baseCapacity,
            condition: 'Weather unavailable',
        };
    }

    // Fetch forecast
    const forecast = await getWeatherForecast(location.lat, location.lon);
    if (!forecast) {
        return {
            baseCapacity,
            effectiveCapacity: baseCapacity,
            condition: 'Weather unavailable',
        };
    }

    // Calculate multiplier
    const multiplier = calculateWeatherMultiplier(forecast, sourceType, start, end);
    const effectiveCapacity = Math.round(baseCapacity * multiplier * 10) / 10;

    // Get average conditions for display
    const relevantHours = forecast.hourly.filter(h => h.time >= start && h.time <= end);
    const avgCloud = relevantHours.length > 0
        ? relevantHours.reduce((s, h) => s + h.cloudCover, 0) / relevantHours.length
        : 50;
    const avgWind = relevantHours.length > 0
        ? relevantHours.reduce((s, h) => s + h.windSpeed, 0) / relevantHours.length
        : 10;

    // Find best trading window
    const bestWindow = findBestTradingWindow(forecast, sourceType, now);

    return {
        baseCapacity,
        effectiveCapacity,
        condition: getWeatherConditionString(avgCloud, avgWind),
        bestWindow: bestWindow ? { start: bestWindow.start, end: bestWindow.end } : undefined,
    };
}
