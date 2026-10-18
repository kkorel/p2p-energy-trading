/**
 * Weather Service Unit Tests
 */

import {
    getSolarMultiplier,
    getWindMultiplier,
    getHydroMultiplier,
    calculateWeatherMultiplier,
    getWeatherConditionString,
    findBestTradingWindow,
} from './weather-service';
import {
    getMaintenanceAlert,
    extractMaintenanceData,
} from './maintenance-alerts';
import type { WeatherForecast, HourlyWeather, MaintenanceAlertData } from './types';

// Helper to create hourly weather data
function createHourlyWeather(
    hoursFromNow: number,
    cloudCover: number,
    windSpeed: number,
    precipitation: number = 0,
    weatherCode: number = 0
): HourlyWeather {
    const time = new Date();
    time.setHours(time.getHours() + hoursFromNow, 0, 0, 0);
    return { time, cloudCover, windSpeed, precipitation, weatherCode };
}

describe('Weather Service', () => {
    describe('getSolarMultiplier', () => {
        it('should return 1.0 for clear sky (< 20% cloud)', () => {
            expect(getSolarMultiplier(0)).toBe(1.0);
            expect(getSolarMultiplier(10)).toBe(1.0);
            expect(getSolarMultiplier(19)).toBe(1.0);
        });

        it('should return 0.75 for partly cloudy (20-49% cloud)', () => {
            expect(getSolarMultiplier(20)).toBe(0.75);
            expect(getSolarMultiplier(35)).toBe(0.75);
            expect(getSolarMultiplier(49)).toBe(0.75);
        });

        it('should return 0.45 for overcast (50-79% cloud)', () => {
            expect(getSolarMultiplier(50)).toBe(0.45);
            expect(getSolarMultiplier(65)).toBe(0.45);
            expect(getSolarMultiplier(79)).toBe(0.45);
        });

        it('should return 0.25 for heavy cloud (>= 80% cloud)', () => {
            expect(getSolarMultiplier(80)).toBe(0.25);
            expect(getSolarMultiplier(100)).toBe(0.25);
        });
    });

    describe('getWindMultiplier', () => {
        it('should return 0.1 for too calm (< 5 km/h)', () => {
            expect(getWindMultiplier(0)).toBe(0.1);
            expect(getWindMultiplier(4)).toBe(0.1);
        });

        it('should return 0.4 for light wind (5-11 km/h)', () => {
            expect(getWindMultiplier(5)).toBe(0.4);
            expect(getWindMultiplier(11)).toBe(0.4);
        });

        it('should return 1.0 for optimal wind (12-25 km/h)', () => {
            expect(getWindMultiplier(12)).toBe(1.0);
            expect(getWindMultiplier(20)).toBe(1.0);
            expect(getWindMultiplier(25)).toBe(1.0);
        });

        it('should return 0.8 for high wind (26-50 km/h)', () => {
            expect(getWindMultiplier(26)).toBe(0.8);
            expect(getWindMultiplier(50)).toBe(0.8);
        });

        it('should return 0.5 for very high wind (51-80 km/h)', () => {
            expect(getWindMultiplier(51)).toBe(0.5);
            expect(getWindMultiplier(80)).toBe(0.5);
        });

        it('should return 0.0 for safety shutdown (> 80 km/h)', () => {
            expect(getWindMultiplier(81)).toBe(0.0);
            expect(getWindMultiplier(100)).toBe(0.0);
        });
    });

    describe('getHydroMultiplier', () => {
        it('should always return 1.0 (weather-independent)', () => {
            expect(getHydroMultiplier()).toBe(1.0);
        });
    });

    describe('calculateWeatherMultiplier', () => {
        const now = new Date();
        const windowStart = new Date(now);
        windowStart.setHours(10, 0, 0, 0);
        const windowEnd = new Date(now);
        windowEnd.setHours(14, 0, 0, 0);

        it('should use solar multiplier for Solar source', () => {
            const forecast: WeatherForecast = {
                location: { lat: 12.97, lon: 77.59 },
                hourly: [
                    createHourlyWeather(0, 15, 10), // Clear
                    createHourlyWeather(1, 15, 10),
                    createHourlyWeather(2, 15, 10),
                    createHourlyWeather(3, 15, 10),
                ],
                fetchedAt: now,
            };
            // Override times to be within window
            forecast.hourly.forEach((h, i) => {
                h.time = new Date(windowStart.getTime() + i * 60 * 60 * 1000);
            });

            const multiplier = calculateWeatherMultiplier(forecast, 'SOLAR', windowStart, windowEnd);
            expect(multiplier).toBe(1.0); // Clear sky
        });

        it('should use wind multiplier for Wind source', () => {
            const forecast: WeatherForecast = {
                location: { lat: 12.97, lon: 77.59 },
                hourly: [
                    createHourlyWeather(0, 50, 20), // Optimal wind
                    createHourlyWeather(1, 50, 20),
                    createHourlyWeather(2, 50, 20),
                    createHourlyWeather(3, 50, 20),
                ],
                fetchedAt: now,
            };
            forecast.hourly.forEach((h, i) => {
                h.time = new Date(windowStart.getTime() + i * 60 * 60 * 1000);
            });

            const multiplier = calculateWeatherMultiplier(forecast, 'WIND', windowStart, windowEnd);
            expect(multiplier).toBe(1.0); // Optimal wind
        });

        it('should return 1.0 for HYDRO regardless of weather', () => {
            const forecast: WeatherForecast = {
                location: { lat: 12.97, lon: 77.59 },
                hourly: [
                    createHourlyWeather(0, 100, 0), // Worst solar conditions
                ],
                fetchedAt: now,
            };
            forecast.hourly[0].time = windowStart;

            const multiplier = calculateWeatherMultiplier(forecast, 'HYDRO', windowStart, windowEnd);
            expect(multiplier).toBe(1.0);
        });

        it('should return 0.7 when no data for window', () => {
            const forecast: WeatherForecast = {
                location: { lat: 12.97, lon: 77.59 },
                hourly: [], // No data
                fetchedAt: now,
            };

            const multiplier = calculateWeatherMultiplier(forecast, 'SOLAR', windowStart, windowEnd);
            expect(multiplier).toBe(0.7);
        });
    });

    describe('getWeatherConditionString', () => {
        it('should return friendly descriptions', () => {
            expect(getWeatherConditionString(10, 10)).toBe('Clear skies ☀️');
            expect(getWeatherConditionString(30, 10)).toBe('Slightly sunny 🌤️');
            expect(getWeatherConditionString(50, 10)).toBe('Partly cloudy ⛅');
            expect(getWeatherConditionString(70, 10)).toBe('Cloudy ☁️');
            expect(getWeatherConditionString(90, 10)).toBe('Overcast 🌧️');
        });
    });

    describe('findBestTradingWindow', () => {
        it('should find the best 4-hour window for solar', () => {
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            const forecast: WeatherForecast = {
                location: { lat: 12.97, lon: 77.59 },
                hourly: [],
                fetchedAt: new Date(),
            };

            // Create hours from 6am to 6pm
            for (let h = 6; h <= 18; h++) {
                const time = new Date(today);
                time.setHours(h, 0, 0, 0);
                // Make 10am-2pm the clearest
                const cloudCover = h >= 10 && h <= 13 ? 10 : 60;
                forecast.hourly.push({
                    time,
                    cloudCover,
                    windSpeed: 10,
                    precipitation: 0,
                    weatherCode: 0,
                });
            }

            const result = findBestTradingWindow(forecast, 'SOLAR', today);
            expect(result).not.toBeNull();
            expect(result!.multiplier).toBe(1.0); // Clear sky
            expect(result!.start).toBe('10:00');
        });

        it('should return null when no trading hours available', () => {
            const forecast: WeatherForecast = {
                location: { lat: 12.97, lon: 77.59 },
                hourly: [],
                fetchedAt: new Date(),
            };

            const result = findBestTradingWindow(forecast, 'SOLAR', new Date());
            expect(result).toBeNull();
        });
    });
});

describe('Maintenance Alerts', () => {
    describe('getMaintenanceAlert', () => {
        it('should always alert for hail (no cooldown)', () => {
            const weather: MaintenanceAlertData = {
                precipitation24h: 0,
                maxWindSpeed: 0,
                hadThunderstorm: false,
                hadHail: true,
            };
            // Recent alert but hail overrides cooldown
            const recentAlert = new Date(Date.now() - 1000);

            const alert = getMaintenanceAlert(weather, recentAlert);
            expect(alert).not.toBeNull();
            expect(alert).toContain('Hail');
        });

        it('should alert for heavy rain (> 30mm)', () => {
            const weather: MaintenanceAlertData = {
                precipitation24h: 35,
                maxWindSpeed: 10,
                hadThunderstorm: false,
                hadHail: false,
            };

            const alert = getMaintenanceAlert(weather);
            expect(alert).not.toBeNull();
            expect(alert).toContain('Heavy rain');
        });

        it('should alert for thunderstorm', () => {
            const weather: MaintenanceAlertData = {
                precipitation24h: 10,
                maxWindSpeed: 30,
                hadThunderstorm: true,
                hadHail: false,
            };

            const alert = getMaintenanceAlert(weather);
            expect(alert).not.toBeNull();
            expect(alert).toContain('Thunderstorm');
        });

        it('should alert for high winds (> 50 km/h)', () => {
            const weather: MaintenanceAlertData = {
                precipitation24h: 5,
                maxWindSpeed: 55,
                hadThunderstorm: false,
                hadHail: false,
            };

            const alert = getMaintenanceAlert(weather);
            expect(alert).not.toBeNull();
            expect(alert).toContain('High winds');
        });

        it('should respect 3-day cooldown for non-hail alerts', () => {
            const weather: MaintenanceAlertData = {
                precipitation24h: 40, // Would normally trigger
                maxWindSpeed: 10,
                hadThunderstorm: false,
                hadHail: false,
            };
            // Alert sent 1 day ago
            const recentAlert = new Date(Date.now() - 24 * 60 * 60 * 1000);

            const alert = getMaintenanceAlert(weather, recentAlert);
            expect(alert).toBeNull();
        });

        it('should alert after cooldown expires', () => {
            const weather: MaintenanceAlertData = {
                precipitation24h: 40,
                maxWindSpeed: 10,
                hadThunderstorm: false,
                hadHail: false,
            };
            // Alert sent 4 days ago (past 3-day cooldown)
            const oldAlert = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);

            const alert = getMaintenanceAlert(weather, oldAlert);
            expect(alert).not.toBeNull();
        });

        it('should return null when no severe weather', () => {
            const weather: MaintenanceAlertData = {
                precipitation24h: 5,
                maxWindSpeed: 20,
                hadThunderstorm: false,
                hadHail: false,
            };

            const alert = getMaintenanceAlert(weather);
            expect(alert).toBeNull();
        });
    });

    describe('extractMaintenanceData', () => {
        it('should calculate 24h precipitation total', () => {
            const hourly = Array(24).fill(null).map(() => ({
                precipitation: 2,
                windSpeed: 10,
                weatherCode: 0,
            }));

            const data = extractMaintenanceData(hourly);
            expect(data.precipitation24h).toBe(48);
        });

        it('should find max wind speed', () => {
            const hourly = [
                { precipitation: 0, windSpeed: 20, weatherCode: 0 },
                { precipitation: 0, windSpeed: 55, weatherCode: 0 },
                { precipitation: 0, windSpeed: 30, weatherCode: 0 },
            ];

            const data = extractMaintenanceData(hourly);
            expect(data.maxWindSpeed).toBe(55);
        });

        it('should detect thunderstorm from weather codes', () => {
            const hourly = [
                { precipitation: 10, windSpeed: 30, weatherCode: 95 }, // Thunderstorm
            ];

            const data = extractMaintenanceData(hourly);
            expect(data.hadThunderstorm).toBe(true);
        });

        it('should detect hail from weather codes', () => {
            const hourly = [
                { precipitation: 10, windSpeed: 30, weatherCode: 99 }, // Thunderstorm with hail
            ];

            const data = extractMaintenanceData(hourly);
            expect(data.hadHail).toBe(true);
        });
    });
});
