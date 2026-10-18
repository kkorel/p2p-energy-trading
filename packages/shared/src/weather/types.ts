/**
 * Weather Types for P2P Energy Trading
 */

export interface GeoLocation {
    lat: number;
    lon: number;
    city?: string;
}

export interface HourlyWeather {
    time: Date;
    cloudCover: number;        // 0-100%
    windSpeed: number;         // km/h
    precipitation: number;     // mm
    weatherCode: number;       // WMO weather code
}

export interface WeatherForecast {
    location: GeoLocation;
    hourly: HourlyWeather[];
    fetchedAt: Date;
}

export interface WeatherCapacity {
    baseCapacity: number;
    effectiveCapacity: number;
    condition: string;           // "Slightly sunny ☀️", "Cloudy ☁️", etc.
    bestWindow?: {
        start: string;             // "10:00"
        end: string;               // "14:00"
    };
}

export type SourceType = 'SOLAR' | 'WIND' | 'HYDRO' | 'OTHER';

export interface MaintenanceAlertData {
    precipitation24h: number;    // mm in last 24h
    maxWindSpeed: number;        // km/h max in last 24h
    hadThunderstorm: boolean;
    hadHail: boolean;
}
