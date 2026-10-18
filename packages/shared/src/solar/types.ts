/**
 * Solar Analysis Types
 * Types for Google Solar API integration and trading limit calculation
 */

export interface SolarAnalysis {
    /** Whether Google Solar API returned data for this location */
    available: boolean;

    /** Geocoded coordinates */
    location?: {
        lat: number;
        lon: number;
        formattedAddress?: string;
    };

    /** From Google Solar API Building Insights */
    maxSunshineHours?: number;      // Annual sunshine hours
    maxPanelCount?: number;          // Maximum panels that fit on roof
    yearlyEnergyKwh?: number;        // Estimated yearly production
    roofAreaM2?: number;             // Usable roof area
    imageryQuality?: 'HIGH' | 'MEDIUM' | 'LOW';
    carbonOffsetKg?: number;         // Annual CO2 offset

    /** Calculated values */
    installationScore: number;       // 0.0 - 1.0
    tradingLimitPercent: number;     // 7-15%

    /** Metadata */
    verificationMethod: 'SOLAR_API' | 'DEFAULT';
    analyzedAt: Date;
    errorReason?: string;
}

export interface GoogleSolarBuildingInsights {
    name: string;
    center: {
        latitude: number;
        longitude: number;
    };
    imageryQuality: 'HIGH' | 'MEDIUM' | 'LOW' | 'IMAGERY_QUALITY_UNSPECIFIED';
    solarPotential?: {
        maxArrayPanelsCount: number;
        maxSunshineHoursPerYear: number;
        carbonOffsetFactorKgPerMwh: number;
        roofSegmentStats?: Array<{
            pitchDegrees: number;
            azimuthDegrees: number;
            stats: {
                areaMeters2: number;
                sunshineQuantiles?: number[];
            };
        }>;
        solarPanelConfigs?: Array<{
            panelsCount: number;
            yearlyEnergyDcKwh: number;
        }>;
    };
}

export interface GoogleGeocodingResult {
    results: Array<{
        formatted_address: string;
        geometry: {
            location: {
                lat: number;
                lng: number;
            };
        };
    }>;
    status: string;
}

/** Result from getSolarHeatmap() */
export interface HeatmapResult {
    /** Whether heatmap data was available for this location */
    available: boolean;
    /** Base64-encoded PNG data URL (data:image/png;base64,...) */
    imageBase64?: string;
    /** Image dimensions in pixels */
    width?: number;
    height?: number;
    /** Solar flux statistics across the image */
    fluxStats?: {
        minKwhPerM2: number;
        maxKwhPerM2: number;
        avgKwhPerM2: number;
    };
    /** Geographic bounds of the image */
    bounds?: {
        north: number;
        south: number;
        east: number;
        west: number;
    };
    /** Error reason if available=false */
    errorReason?: string;
}

/** Response from Google Solar API dataLayers:get endpoint */
export interface GoogleDataLayersResponse {
    imageryDate: { year: number; month: number; day: number };
    imageryProcessedDate: { year: number; month: number; day: number };
    dsmUrl: string;
    rgbUrl: string;
    maskUrl: string;
    annualFluxUrl: string;
    monthlyFluxUrl: string;
    hourlyShadeUrls: string[];
    imageryQuality: string;
}

/** Trading limit calculation constants - updated range: 7-15% */
export const LIMIT_THRESHOLDS = {
    HIGH_SUNSHINE: 1800,    // hours/year -> 15% limit
    MEDIUM_SUNSHINE: 1500,  // hours/year -> 12% limit
    LOW_SUNSHINE: 1200,     // hours/year -> 10% limit
    DEFAULT_LIMIT: 10,      // % when no data
    MAX_LIMIT: 15,          // % max initial limit
    MIN_LIMIT: 7,           // % min initial limit
} as const;
