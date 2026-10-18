/**
 * Trust Score Engine
 * Manages credit-score-like trust system for P2P energy trading
 * with proportional penalties based on delivery performance
 */

// Configuration loaded from environment
export interface TrustConfig {
    // New user defaults
    defaultScore: number;
    defaultLimit: number;

    // Score changes
    successBonus: number;
    failurePenalty: number;  // Maximum penalty, scaled by delivery ratio
    meterAnalysisBonus: number;

    // Cancellation penalty for buyers
    cancelPenalty: number;
    // Cancellation penalty for sellers (stricter)
    sellerCancelPenalty: number;

    // Limits mapping (trustScore ranges to allowed %)
    limitTiers: { minScore: number; maxLimit: number }[];
}

// Load config from environment
export function getTrustConfig(): TrustConfig {
    return {
        defaultScore: parseFloat(process.env.TRUST_DEFAULT_SCORE || '0.3'),
        defaultLimit: parseFloat(process.env.TRUST_DEFAULT_LIMIT || '10'),
        successBonus: parseFloat(process.env.TRUST_SUCCESS_BONUS || '0.02'),
        failurePenalty: parseFloat(process.env.TRUST_FAILURE_PENALTY || '0.10'),
        meterAnalysisBonus: parseFloat(process.env.TRUST_METER_BONUS || '0.2'),
        cancelPenalty: parseFloat(process.env.TRUST_CANCEL_PENALTY || '0.03'),
        sellerCancelPenalty: parseFloat(process.env.TRUST_SELLER_CANCEL_PENALTY || '0.05'),
        limitTiers: [
            { minScore: 0.0, maxLimit: 10 },   // 0-30% trust → 10% limit
            { minScore: 0.31, maxLimit: 20 },  // 31-50% trust → 20% limit
            { minScore: 0.51, maxLimit: 40 },  // 51-70% trust → 40% limit
            { minScore: 0.71, maxLimit: 60 },  // 71-85% trust → 60% limit
            { minScore: 0.86, maxLimit: 80 },  // 86-95% trust → 80% limit
            { minScore: 0.96, maxLimit: 100 }, // 96%+ trust → 100% limit
        ],
    };
}

/**
 * Calculate allowed trade limit from trust score
 *
 * @param trustScore - User's current trust score (0-1)
 * @param config - Optional trust config override
 * @param solarLimit - Optional solar-based limit from UserSolarAnalysis (7-15%)
 *                     If provided, returns max(solarLimit, tierLimit) so solar analysis
 *                     provides a floor that the tier system cannot go below
 */
export function calculateAllowedLimit(
    trustScore: number,
    config?: TrustConfig,
    solarLimit?: number
): number {
    const cfg = config || getTrustConfig();

    // Find the highest tier the user qualifies for
    let tierLimit = cfg.defaultLimit;
    for (const tier of cfg.limitTiers) {
        if (trustScore >= tier.minScore) {
            tierLimit = tier.maxLimit;
        }
    }

    // If solar limit is provided, use max of solar and tier
    // This ensures solar-analyzed installations always get at least their solar-based limit
    if (solarLimit !== undefined && solarLimit > 0) {
        return Math.max(solarLimit, tierLimit);
    }

    return tierLimit;
}

/**
 * Calculate allowed trade quantity in kWh
 * Based on production capacity and trust-based percentage limit
 * 
 * @param productionCapacity - User's declared/verified production in kWh/month
 * @param trustScore - User's current trust score (0-1)
 * @returns Allowed trade quantity in kWh
 */
export function calculateAllowedTradeQty(
    productionCapacity: number | null | undefined,
    trustScore: number,
    config?: TrustConfig
): number {
    if (!productionCapacity || productionCapacity <= 0) {
        return 0;
    }

    const limitPercent = calculateAllowedLimit(trustScore, config);
    return productionCapacity * (limitPercent / 100);
}

/**
 * Clamp trust score to valid range [0, 1]
 */
function clampTrustScore(score: number): number {
    return Math.max(0, Math.min(1, score));
}

/**
 * Calculate proportional delivery penalty
 * Full delivery = 0 penalty
 * No delivery = full penalty
 * Partial delivery = proportional penalty
 * 
 * @param expectedQty - Quantity that was promised
 * @param deliveredQty - Quantity actually delivered
 * @param basePenalty - Maximum penalty (from config)
 * @returns Penalty amount (positive number to subtract from trust)
 */
export function calculateDeliveryPenalty(
    expectedQty: number,
    deliveredQty: number,
    basePenalty?: number
): number {
    const cfg = getTrustConfig();
    const penalty = basePenalty ?? cfg.failurePenalty;

    if (expectedQty <= 0) return 0;

    const ratio = Math.min(1, Math.max(0, deliveredQty / expectedQty));
    // Full delivery (ratio=1) → 0 penalty
    // No delivery (ratio=0) → full penalty
    return penalty * (1 - ratio);
}

/**
 * Update trust score after DISCOM verification
 * @returns New trust score, new limit, and actual trust impact
 */
export function updateTrustAfterDiscom(
    currentScore: number,
    deliveredQty: number,
    expectedQty: number,
    config?: TrustConfig
): { newScore: number; newLimit: number; trustImpact: number } {
    const cfg = config || getTrustConfig();

    const ratio = expectedQty > 0 ? deliveredQty / expectedQty : 0;
    let trustImpact: number;

    if (ratio >= 1) {
        // Full delivery - bonus
        trustImpact = cfg.successBonus;
    } else if (ratio > 0) {
        // Partial delivery - proportional penalty
        trustImpact = -calculateDeliveryPenalty(expectedQty, deliveredQty, cfg.failurePenalty);
    } else {
        // No delivery - full penalty
        trustImpact = -cfg.failurePenalty;
    }

    const newScore = clampTrustScore(currentScore + trustImpact);
    const newLimit = calculateAllowedLimit(newScore, cfg);

    return { newScore, newLimit, trustImpact };
}

/**
 * Update trust score after buyer cancellation
 * Penalty is proportional to cancelled quantity
 */
export function updateTrustAfterCancel(
    currentScore: number,
    cancelledQty: number,
    totalOrderQty: number,
    isWithinWindow: boolean,
    config?: TrustConfig
): { newScore: number; newLimit: number; trustImpact: number } {
    const cfg = config || getTrustConfig();

    // No penalty if cancelled outside window (system should block this anyway)
    if (!isWithinWindow) {
        return {
            newScore: currentScore,
            newLimit: calculateAllowedLimit(currentScore, cfg),
            trustImpact: 0
        };
    }

    // Proportional penalty based on cancelled quantity
    const ratio = totalOrderQty > 0 ? cancelledQty / totalOrderQty : 1;
    const trustImpact = -cfg.cancelPenalty * ratio;

    const newScore = clampTrustScore(currentScore + trustImpact);
    const newLimit = calculateAllowedLimit(newScore, cfg);

    return { newScore, newLimit, trustImpact };
}

/**
 * Update trust score after seller cancellation
 * Penalty is proportional to cancelled quantity, stricter than buyer penalty
 */
export function updateTrustAfterSellerCancel(
    currentScore: number,
    cancelledQty: number,
    totalOrderQty: number,
    isWithinWindow: boolean,
    config?: TrustConfig
): { newScore: number; newLimit: number; trustImpact: number } {
    const cfg = config || getTrustConfig();

    // No penalty if cancelled outside window (system should block this anyway)
    if (!isWithinWindow) {
        return {
            newScore: currentScore,
            newLimit: calculateAllowedLimit(currentScore, cfg),
            trustImpact: 0
        };
    }

    // Proportional penalty based on cancelled quantity
    const ratio = totalOrderQty > 0 ? cancelledQty / totalOrderQty : 1;
    const trustImpact = -cfg.sellerCancelPenalty * ratio;

    const newScore = clampTrustScore(currentScore + trustImpact);
    const newLimit = calculateAllowedLimit(newScore, cfg);

    return { newScore, newLimit, trustImpact };
}

/**
 * Update trust score after successful meter data analysis
 */
export function updateTrustAfterMeterAnalysis(
    currentScore: number,
    analysisQuality: 'HIGH' | 'MEDIUM' | 'LOW',
    config?: TrustConfig
): { newScore: number; newLimit: number; trustImpact: number } {
    const cfg = config || getTrustConfig();

    // Quality multiplier
    const qualityMultiplier = {
        'HIGH': 1.0,
        'MEDIUM': 0.6,
        'LOW': 0.3,
    };

    const trustImpact = cfg.meterAnalysisBonus * qualityMultiplier[analysisQuality];
    const newScore = clampTrustScore(currentScore + trustImpact);
    const newLimit = calculateAllowedLimit(newScore, cfg);

    return { newScore, newLimit, trustImpact };
}

/**
 * Get human-readable trust tier description
 */
export function getTrustTierDescription(trustScore: number): string {
    if (trustScore >= 0.96) return 'Platinum (Full Trading)';
    if (trustScore >= 0.86) return 'Gold (80% Trading)';
    if (trustScore >= 0.71) return 'Silver (60% Trading)';
    if (trustScore >= 0.51) return 'Bronze (40% Trading)';
    if (trustScore >= 0.31) return 'Starter (20% Trading)';
    return 'New (10% Trading)';
}

/**
 * Calculate progress to next tier
 */
export function getNextTierProgress(trustScore: number): {
    currentTier: string;
    nextTier: string | null;
    progress: number;
    scoreNeeded: number;
} {
    const tiers = [
        { minScore: 0.0, name: 'New' },
        { minScore: 0.31, name: 'Starter' },
        { minScore: 0.51, name: 'Bronze' },
        { minScore: 0.71, name: 'Silver' },
        { minScore: 0.86, name: 'Gold' },
        { minScore: 0.96, name: 'Platinum' },
    ];

    let currentTierIndex = 0;
    for (let i = tiers.length - 1; i >= 0; i--) {
        if (trustScore >= tiers[i].minScore) {
            currentTierIndex = i;
            break;
        }
    }

    const currentTier = tiers[currentTierIndex].name;

    if (currentTierIndex >= tiers.length - 1) {
        return { currentTier, nextTier: null, progress: 100, scoreNeeded: 0 };
    }

    const nextTier = tiers[currentTierIndex + 1].name;
    const nextTierScore = tiers[currentTierIndex + 1].minScore;
    const currentTierScore = tiers[currentTierIndex].minScore;

    const progress = ((trustScore - currentTierScore) / (nextTierScore - currentTierScore)) * 100;
    const scoreNeeded = nextTierScore - trustScore;

    return { currentTier, nextTier, progress: Math.min(100, Math.max(0, progress)), scoreNeeded };
}
