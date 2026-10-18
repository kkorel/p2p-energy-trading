/**
 * DISCOM Mock Service
 * Simulates DISCOM verification of energy delivery after trade window ends
 * 
 * In production, this would be replaced by real DISCOM webhook/API integration
 */

import { prisma } from './db';
import {
    createLogger,
    updateTrustAfterDiscom,
    calculateAllowedLimit,
} from '@p2p/shared';

const logger = createLogger('DISCOM-MOCK');

// Configuration from environment
const DISCOM_CONFIG = {
    successRate: parseFloat(process.env.DISCOM_SUCCESS_RATE || '0.85'),
    checkIntervalMs: parseInt(process.env.DISCOM_CHECK_INTERVAL_MS || '60000'),
};

export interface DiscomVerifyResult {
    orderId: string;
    transactionId: string;
    sellerId: string;
    expectedQty: number;
    deliveredQty: number;
    status: 'FULL' | 'PARTIAL' | 'FAILED';
    deliveryRatio: number;
}

let isRunning = false;
let intervalId: NodeJS.Timeout | null = null;

/**
 * Get time window end from order (from selectedOffer or from itemsJson)
 */
function getTimeWindowEnd(order: any): Date | null {
    // First try from selectedOffer relation
    if (order.selectedOffer?.timeWindowEnd) {
        return order.selectedOffer.timeWindowEnd;
    }

    // Fallback: parse from itemsJson
    try {
        const items = JSON.parse(order.itemsJson || '[]');
        if (items.length > 0 && items[0].timeWindow?.endTime) {
            return new Date(items[0].timeWindow.endTime);
        }
    } catch (e) {
        // Ignore parse errors
    }

    return null;
}

/**
 * Recover stuck DRAFT orders that have payment escrowed
 * These are orders where the confirm callback didn't complete properly
 */
async function recoverStuckDraftOrders() {
    // Find ALL DRAFT orders (they shouldn't exist - orders should be PENDING/ACTIVE)
    const allDraftOrders = await prisma.order.findMany({
        where: { status: 'DRAFT' },
        select: { id: true, paymentStatus: true, escrowedAt: true, totalPrice: true },
    });

    if (allDraftOrders.length > 0) {
        logger.info(`Found ${allDraftOrders.length} DRAFT orders - checking for recovery`, {
            orders: allDraftOrders.map(o => ({ 
                id: o.id.substring(0, 8), 
                paymentStatus: o.paymentStatus,
                hasEscrow: !!o.escrowedAt,
                total: o.totalPrice,
            })),
        });
        
        for (const order of allDraftOrders) {
            // Recover if payment was taken OR if order has a price (was quoted)
            if (order.escrowedAt || order.paymentStatus === 'ESCROWED' || (order.totalPrice && order.totalPrice > 0)) {
                try {
                    await prisma.order.update({
                        where: { id: order.id },
                        data: { status: 'ACTIVE' },
                    });
                    logger.info(`Recovered order ${order.id.substring(0, 8)} from DRAFT to ACTIVE`);
                } catch (e: any) {
                    logger.error(`Failed to recover order ${order.id.substring(0, 8)}: ${e.message}`);
                }
            }
        }
    }
}

/**
 * Find orders that have completed their time window and haven't been verified
 */
async function findOrdersPastTimeWindow() {
    // First recover any stuck DRAFT orders
    await recoverStuckDraftOrders();
    
    const now = new Date();

    // Get ACTIVE orders that haven't been DISCOM verified yet
    // Skip external orders (providerId is null) - we can't verify those locally
    const orders = await prisma.order.findMany({
        where: {
            status: 'ACTIVE',
            discomVerified: false,
            providerId: { not: null }, // Only process local provider orders
        },
        include: {
            selectedOffer: true,
        },
    });

    logger.info(`Found ${orders.length} ACTIVE orders not yet verified`, {
        now: now.toISOString(),
    });

    // Filter to orders whose time window has ended
    const pastWindow = orders.filter(order => {
        const timeWindowEnd = getTimeWindowEnd(order);
        
        if (!timeWindowEnd) {
            logger.info(`Order ${order.id.substring(0, 8)} has no time window info`);
            return false;
        }

        const isPast = timeWindowEnd < now;
        logger.info(`Order ${order.id.substring(0, 8)}: windowEnd=${timeWindowEnd.toISOString()}, now=${now.toISOString()}, isPast=${isPast}`);
        return isPast;
    });

    return pastWindow;
}

/**
 * Handle external orders - mark them as completed since verification happens on external BPP
 */
async function handleExternalOrders() {
    const now = new Date();
    
    // Find external orders (providerId is null) that are ACTIVE and past their time window
    const externalOrders = await prisma.order.findMany({
        where: {
            status: 'ACTIVE',
            discomVerified: false,
            providerId: null, // External orders
        },
    });
    
    for (const order of externalOrders) {
        const timeWindowEnd = getTimeWindowEnd(order);
        
        if (!timeWindowEnd || timeWindowEnd >= now) {
            continue; // Not yet past time window
        }
        
        logger.info(`External order ${order.id.substring(0, 8)}: marking as completed (verification handled by external BPP)`, {
            transactionId: order.transactionId,
        });
        
        // Mark order as completed and verified
        await prisma.order.update({
            where: { id: order.id },
            data: {
                status: 'COMPLETED',
                discomVerified: true,
                paymentStatus: 'RELEASED', // External orders - assume payment handled externally
            },
        });
    }
}

/**
 * Simulate DISCOM verification - random outcome based on configured success rate
 */
function simulateDiscomVerification(
    orderId: string,
    transactionId: string,
    sellerId: string,
    expectedQty: number
): DiscomVerifyResult {
    const random = Math.random();

    let deliveredQty: number;
    let status: 'FULL' | 'PARTIAL' | 'FAILED';

    if (random < DISCOM_CONFIG.successRate) {
        // Full delivery
        deliveredQty = expectedQty;
        status = 'FULL';
    } else if (random < 0.95) {
        // Partial delivery - random between 20% and 80% of expected
        const partialRatio = 0.2 + Math.random() * 0.6;
        deliveredQty = Math.floor(expectedQty * partialRatio);
        status = 'PARTIAL';
    } else {
        // Complete failure
        deliveredQty = 0;
        status = 'FAILED';
    }

    const deliveryRatio = expectedQty > 0 ? deliveredQty / expectedQty : 0;

    return {
        orderId,
        transactionId,
        sellerId,
        expectedQty,
        deliveredQty,
        status,
        deliveryRatio,
    };
}

/**
 * Process DISCOM verification result - update trust scores AND release payment to seller
 */
async function processDiscomFeedback(result: DiscomVerifyResult): Promise<void> {
    const { orderId, transactionId, sellerId, expectedQty, deliveredQty, status, deliveryRatio } = result;

    logger.info(`Processing DISCOM feedback for order ${orderId}`, {
        status,
        expectedQty,
        deliveredQty,
        deliveryRatio: (deliveryRatio * 100).toFixed(1) + '%',
    });

    // Get order details for payment processing
    const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: {
            totalPrice: true,
            buyerId: true,
            paymentStatus: true,
        },
    });

    if (!order) {
        logger.error(`Order ${orderId} not found for payment processing`);
        return;
    }

    // Get the seller (user who owns the provider)
    const seller = await prisma.user.findFirst({
        where: { providerId: sellerId },
    });

    if (!seller) {
        // Try to find seller by provider lookup
        const provider = await prisma.provider.findUnique({
            where: { id: sellerId },
            include: { user: true },
        });

        if (!provider?.user) {
            logger.error(`Could not find seller user for provider ${sellerId}`);
            return;
        }
    }

    const sellerUser = seller || await prisma.user.findFirst({
        where: { providerId: sellerId },
    });

    if (!sellerUser) {
        logger.error(`Could not find seller user for order ${orderId}`);
        return;
    }

    // Calculate trust impact
    const { newScore, newLimit, trustImpact } = updateTrustAfterDiscom(
        sellerUser.trustScore,
        deliveredQty,
        expectedQty
    );

    // Calculate payment to seller based on delivery
    // Seller pays DISCOM differential for undelivered quantity
    // Formula: sellerPayment = (delivered × sellerRate) - (discomRate - sellerRate) × undelivered
    
    const orderTotal = order.totalPrice || 0;
    const sellerRate = expectedQty > 0 ? orderTotal / expectedQty : 0;
    const discomRate = parseFloat(process.env.DISCOM_RATE_PER_KWH || '10'); // Default ₹10/kWh
    const undeliveredQty = expectedQty - deliveredQty;
    
    let sellerPayment = 0;
    let discomPenalty = 0;
    
    if (status === 'FULL') {
        // Full delivery: seller gets 100% of order value
        sellerPayment = orderTotal;
        discomPenalty = 0;
    } else if (status === 'PARTIAL' || status === 'FAILED') {
        // Partial/Failed delivery:
        // 1. Seller gets paid for what they delivered
        // 2. MINUS the differential (DISCOM rate - seller rate) × undelivered
        // This differential goes to DISCOM to cover buyer's higher rate
        
        const paymentForDelivered = deliveredQty * sellerRate;
        discomPenalty = Math.max(0, (discomRate - sellerRate) * undeliveredQty);
        
        // Seller payment = delivered amount - DISCOM differential penalty
        sellerPayment = Math.max(0, paymentForDelivered - discomPenalty);
        
        logger.info(`Partial delivery penalty calculation`, {
            deliveredQty,
            undeliveredQty,
            sellerRate: sellerRate.toFixed(2),
            discomRate: discomRate.toFixed(2),
            paymentForDelivered: paymentForDelivered.toFixed(2),
            discomPenalty: discomPenalty.toFixed(2),
            finalSellerPayment: sellerPayment.toFixed(2),
        });
    }
    
    // Amount that goes to DISCOM (penalty + buyer's payment for undelivered portion)
    const toDiscom = discomPenalty + (undeliveredQty * sellerRate);
    // Platform retains any remaining difference
    const platformRetained = orderTotal - sellerPayment - toDiscom;

    // Use transaction to update all records atomically (trust + payment)
    await prisma.$transaction(async (tx) => {
        // 1. Create DISCOM feedback record
        await tx.discomFeedback.create({
            data: {
                orderId,
                sellerId: sellerUser.id,
                transactionId,
                deliveredQty,
                expectedQty,
                deliveryRatio,
                status,
                trustImpact,
                verifiedAt: new Date(),
            },
        });

        // 2. Update seller's trust score and allowed limit
        await tx.user.update({
            where: { id: sellerUser.id },
            data: {
                trustScore: newScore,
                allowedTradeLimit: newLimit,
            },
        });

        // 3. Record trust history
        await tx.trustScoreHistory.create({
            data: {
                userId: sellerUser.id,
                previousScore: sellerUser.trustScore,
                newScore,
                previousLimit: sellerUser.allowedTradeLimit,
                newLimit,
                reason: status === 'FULL' ? 'DELIVERY_SUCCESS' : status === 'PARTIAL' ? 'DELIVERY_PARTIAL' : 'DELIVERY_FAILED',
                orderId,
                metadata: JSON.stringify({
                    expectedQty,
                    deliveredQty,
                    deliveryRatio,
                    trustImpact,
                }),
            },
        });

        // 4. Mark order as DISCOM verified and update payment status
        await tx.order.update({
            where: { id: orderId },
            data: { 
                discomVerified: true,
                status: 'COMPLETED',
                paymentStatus: 'RELEASED',
                releasedAt: new Date(),
            },
        });

        // 5. Update provider stats
        await tx.provider.update({
            where: { id: sellerId },
            data: {
                totalOrders: { increment: 1 },
                successfulOrders: status === 'FULL' ? { increment: 1 } : undefined,
                trustScore: newScore,
            },
        });

        // 5b. Update buyer trust score (small bonus for successful purchase)
        if (order.buyerId) {
            const buyerUser = await tx.user.findUnique({
                where: { id: order.buyerId },
                select: { id: true, trustScore: true, allowedTradeLimit: true },
            });
            
            if (buyerUser) {
                // Buyer gets a small trust boost for successful orders
                // Full delivery: +1%, Partial: +0.5%, Failed: 0%
                const buyerTrustBonus = status === 'FULL' ? 0.01 : status === 'PARTIAL' ? 0.005 : 0;
                const buyerNewScore = Math.min(1.0, buyerUser.trustScore + buyerTrustBonus);
                const buyerNewLimit = calculateAllowedLimit(buyerNewScore);
                
                if (buyerTrustBonus > 0) {
                    await tx.user.update({
                        where: { id: order.buyerId },
                        data: {
                            trustScore: buyerNewScore,
                            allowedTradeLimit: buyerNewLimit,
                        },
                    });
                    
                    await tx.trustScoreHistory.create({
                        data: {
                            userId: order.buyerId,
                            previousScore: buyerUser.trustScore,
                            newScore: buyerNewScore,
                            previousLimit: buyerUser.allowedTradeLimit,
                            newLimit: buyerNewLimit,
                            reason: 'PURCHASE_SUCCESS',
                            orderId,
                            metadata: JSON.stringify({
                                deliveryStatus: status,
                                trustBonus: buyerTrustBonus,
                            }),
                        },
                    });
                    
                    logger.info(`Buyer trust updated after successful purchase`, {
                        buyerId: order.buyerId,
                        previousScore: buyerUser.trustScore.toFixed(3),
                        newScore: buyerNewScore.toFixed(3),
                        bonus: buyerTrustBonus,
                    });
                }
            }
        }

        // 6. PAYMENT RELEASE: Pay seller (minus DISCOM penalty if any)
        if (sellerPayment > 0) {
            await tx.user.update({
                where: { id: sellerUser.id },
                data: { balance: { increment: sellerPayment } },
            });
        }

        // 7. Log DISCOM penalty if partial/failed delivery
        if (discomPenalty > 0) {
            logger.info(`DISCOM penalty applied: ₹${discomPenalty.toFixed(2)} deducted from seller for ${undeliveredQty} kWh undelivered`);
        }

        // 8. Create payment record
        await tx.paymentRecord.create({
            data: {
                type: 'RELEASE',
                orderId,
                buyerId: order.buyerId,
                sellerId: sellerUser.id,
                totalAmount: orderTotal,
                sellerAmount: sellerPayment,
                buyerRefund: null, // No buyer refund - they get energy from DISCOM
                platformFee: toDiscom, // Goes to DISCOM to cover differential
                status: 'COMPLETED',
                completedAt: new Date(),
            },
        });
    });

    logger.info(`Order ${orderId} completed: trust updated + payment released`, {
        sellerId: sellerUser.id,
        previousScore: sellerUser.trustScore.toFixed(3),
        newScore: newScore.toFixed(3),
        trustImpact: trustImpact.toFixed(3),
        newLimit: newLimit + '%',
        deliveryStatus: status,
        delivered: `${deliveredQty}/${expectedQty} kWh`,
        sellerRate: sellerRate.toFixed(2),
        discomRate: discomRate.toFixed(2),
        sellerPayment: sellerPayment.toFixed(2),
        discomPenalty: discomPenalty.toFixed(2),
        toDiscom: toDiscom.toFixed(2),
    });

    // Cleanup: Delete sold-out offers whose delivery time has passed
    try {
        const now = new Date();
        const soldOutOffers = await prisma.catalogOffer.findMany({
            where: {
                providerId: sellerId,
                timeWindowEnd: { lt: now }, // Delivery time has passed
            },
            include: {
                blocks: {
                    where: { status: 'AVAILABLE' },
                },
            },
        });

        for (const offer of soldOutOffers) {
            if (offer.blocks.length === 0) {
                // No available blocks left and delivery time passed - delete offer
                await prisma.catalogOffer.delete({
                    where: { id: offer.id },
                });
                logger.info(`Deleted sold-out offer ${offer.id} (delivery time passed)`);
            }
        }
    } catch (cleanupError: any) {
        logger.error(`Failed to cleanup sold-out offers: ${cleanupError.message}`);
    }
}

/**
 * Run a single verification check
 */
async function runVerificationCheck(): Promise<void> {
    logger.info('Running DISCOM verification check...');
    try {
        // First, handle external orders separately
        await handleExternalOrders();
        
        // Then process local orders that need DISCOM verification
        const completedOrders = await findOrdersPastTimeWindow();

        if (completedOrders.length === 0) {
            logger.info('No orders ready for DISCOM verification');
            return;
        }

        logger.info(`Found ${completedOrders.length} orders ready for DISCOM verification`);

        for (const order of completedOrders) {
            try {
                // Parse quote to get expected quantity
                const quote = JSON.parse(order.quoteJson || '{}');
                const expectedQty = quote.totalQuantity || order.totalQty || 0;

                if (expectedQty <= 0) {
                    logger.warn(`Order ${order.id} has no quantity, skipping`);
                    continue;
                }

                const result = simulateDiscomVerification(
                    order.id,
                    order.transactionId,
                    order.providerId || '',
                    expectedQty
                );

                await processDiscomFeedback(result);
            } catch (error: any) {
                logger.error(`Failed to process DISCOM verification for order ${order.id}: ${error.message}`);
            }
        }
    } catch (error: any) {
        logger.error(`DISCOM verification check failed: ${error.message}`);
    }
}

/**
 * Start the background DISCOM mock service
 */
export function startDiscomMockService(): void {
    if (isRunning) {
        logger.warn('DISCOM mock service is already running');
        return;
    }

    isRunning = true;

    logger.info('Starting DISCOM mock service', {
        successRate: (DISCOM_CONFIG.successRate * 100).toFixed(0) + '%',
        checkIntervalMs: DISCOM_CONFIG.checkIntervalMs,
    });

    // Run immediately on start
    runVerificationCheck();

    // Then run on interval
    intervalId = setInterval(runVerificationCheck, DISCOM_CONFIG.checkIntervalMs);
}

/**
 * Stop the DISCOM mock service
 */
export function stopDiscomMockService(): void {
    if (!isRunning) {
        return;
    }

    isRunning = false;

    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
    }

    logger.info('DISCOM mock service stopped');
}

/**
 * Manually trigger verification for a specific order (for testing)
 */
export async function verifyOrderDelivery(orderId: string): Promise<DiscomVerifyResult | null> {
    const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: { selectedOffer: true },
    });

    if (!order) {
        logger.error(`Order ${orderId} not found`);
        return null;
    }

    if (order.discomVerified) {
        logger.info(`Order ${orderId} already verified`);
        return null;
    }

    const quote = JSON.parse(order.quoteJson || '{}');
    const expectedQty = quote.totalQuantity || order.totalQty || 0;

    const result = simulateDiscomVerification(
        order.id,
        order.transactionId,
        order.providerId || '',
        expectedQty
    );

    await processDiscomFeedback(result);

    return result;
}

/**
 * Check if DISCOM service is running
 */
export function isDiscomServiceRunning(): boolean {
    return isRunning;
}
