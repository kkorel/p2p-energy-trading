/**
 * Notification Service — Sends proactive WhatsApp messages for order events.
 * 
 * Triggers:
 * - Order confirmed (buyer + seller)
 * - Order matched
 * - Payment escrowed/released
 * - Order completed
 * - Order cancelled
 */

import { createLogger, prisma } from '@p2p/shared';
import { sendProactiveMessage, isWhatsAppConnected } from './whatsapp';

const logger = createLogger('Notifications');

/**
 * User notification preferences and contact info.
 */
interface UserNotificationInfo {
  phone: string | null;
  lang: string;
  notifyOrderUpdates: boolean;
  notifyPayments: boolean;
  notifyTradingAlerts: boolean;
  notifyWeeklyDigest: boolean;
}

/**
 * Get user's phone number, language, and notification preferences.
 */
async function getUserContact(userId: string): Promise<UserNotificationInfo> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      phone: true,
      languagePreference: true,
      name: true,
      notifyOrderUpdates: true,
      notifyPayments: true,
      notifyTradingAlerts: true,
      notifyWeeklyDigest: true,
    },
  });
  
  return {
    phone: user?.phone || null,
    lang: user?.languagePreference || 'en-IN',
    notifyOrderUpdates: user?.notifyOrderUpdates ?? true,
    notifyPayments: user?.notifyPayments ?? true,
    notifyTradingAlerts: user?.notifyTradingAlerts ?? false,
    notifyWeeklyDigest: user?.notifyWeeklyDigest ?? false,
  };
}

/**
 * Simple bilingual message helper.
 */
function msg(lang: string, en: string, hi: string): string {
  return lang === 'hi-IN' ? hi : en;
}

/**
 * Format currency for display.
 */
function formatCurrency(amount: number): string {
  return `₹${amount.toFixed(2)}`;
}

// ============================================
// Order Lifecycle Notifications
// ============================================

/**
 * Notify when an order is confirmed (both buyer and seller).
 */
export async function notifyOrderConfirmed(params: {
  orderId: string;
  transactionId: string;
  buyerId?: string;
  sellerId?: string;
  quantity: number;
  totalPrice: number;
  pricePerKwh: number;
  timeWindow?: string;
  energyType?: string;
}): Promise<void> {
  if (!isWhatsAppConnected()) {
    logger.debug('WhatsApp not connected, skipping order confirmation notification');
    return;
  }

  const { orderId, buyerId, sellerId, quantity, totalPrice, pricePerKwh, timeWindow, energyType } = params;

  // Notify buyer (respecting preferences)
  if (buyerId) {
    const buyer = await getUserContact(buyerId);
    if (buyer.phone && buyer.notifyOrderUpdates) {
      const message = msg(buyer.lang,
        `✅ Order Confirmed!\n\n• ${quantity} kWh ${energyType || 'energy'}\n• ${formatCurrency(pricePerKwh)}/kWh\n• Total: ${formatCurrency(totalPrice)}\n${timeWindow ? `• Time: ${timeWindow}` : ''}\n\nPayment is safe with the platform. You'll be notified when energy is delivered.`,
        `✅ ऑर्डर पक्का हो गया!\n\n• ${quantity} यूनिट ${energyType || 'बिजली'}\n• ${formatCurrency(pricePerKwh)}/यूनिट\n• कुल: ${formatCurrency(totalPrice)}\n${timeWindow ? `• समय: ${timeWindow}` : ''}\n\nआपका पैसा प्लेटफॉर्म पे सुरक्षित है। डिलीवरी होने पे मैसेज मिलेगा।`
      );
      
      sendProactiveMessage(buyer.phone, message).catch(err => {
        logger.warn(`Failed to notify buyer ${buyerId}: ${err.message}`);
      });
    }
  }

  // Notify seller (respecting preferences)
  if (sellerId) {
    const seller = await getUserContact(sellerId);
    if (seller.phone && seller.notifyOrderUpdates) {
      const message = msg(seller.lang,
        `🎉 You got a sale!\n\n• ${quantity} kWh ${energyType || 'energy'}\n• ${formatCurrency(pricePerKwh)}/kWh\n• You'll earn: ${formatCurrency(totalPrice)}\n${timeWindow ? `• Delivery window: ${timeWindow}` : ''}\n\nDeliver energy on time to receive payment.`,
        `🎉 Bikri Ho Gayi!\n\n• ${quantity} kWh ${energyType || 'bijli'}\n• ${formatCurrency(pricePerKwh)}/kWh\n• Kamai: ${formatCurrency(totalPrice)}\n${timeWindow ? `• Delivery time: ${timeWindow}` : ''}\n\nSamay pe energy deliver karo, payment mil jayega.`
      );
      
      sendProactiveMessage(seller.phone, message).catch(err => {
        logger.warn(`Failed to notify seller ${sellerId}: ${err.message}`);
      });
    }
  }

  logger.info(`Order confirmation notifications sent for ${orderId}`);
}

/**
 * Notify when payment is escrowed (funds held).
 */
export async function notifyPaymentEscrowed(params: {
  orderId: string;
  buyerId: string;
  amount: number;
  newBalance: number;
}): Promise<void> {
  if (!isWhatsAppConnected()) return;

  const { buyerId, amount, newBalance } = params;
  const buyer = await getUserContact(buyerId);
  
  if (buyer.phone && buyer.notifyPayments) {
    const message = msg(buyer.lang,
      `🔒 Payment Secured\n\n${formatCurrency(amount)} is safe with the platform.\nNew balance: ${formatCurrency(newBalance)}\n\nSeller will get it after delivery is confirmed.`,
      `🔒 पैसा सुरक्षित\n\n${formatCurrency(amount)} प्लेटफॉर्म पे सेफ है।\nनया बैलेंस: ${formatCurrency(newBalance)}\n\nडिलीवरी होने के बाद सेलर को मिलेगा।`
    );

    sendProactiveMessage(buyer.phone, message).catch(err => {
      logger.warn(`Failed to notify payment secured: ${err.message}`);
    });
  }
}

/**
 * Notify when order is completed successfully (energy delivered).
 */
export async function notifyOrderCompleted(params: {
  orderId: string;
  buyerId?: string;
  sellerId?: string;
  quantity: number;
  totalPrice: number;
  deliveredQty?: number;
}): Promise<void> {
  if (!isWhatsAppConnected()) return;

  const { buyerId, sellerId, quantity, totalPrice, deliveredQty } = params;
  const delivered = deliveredQty ?? quantity;

  // Notify buyer
  if (buyerId) {
    const buyer = await getUserContact(buyerId);
    if (buyer.phone) {
      const message = msg(buyer.lang,
        `⚡ Energy Delivered!\n\n${delivered} kWh received successfully.\nTotal paid: ${formatCurrency(totalPrice)}\n\nThank you for trading with Oorja! 🌱`,
        `⚡ Bijli Mil Gayi!\n\n${delivered} kWh mil gayi.\nTotal: ${formatCurrency(totalPrice)}\n\nOorja ke saath trade karne ke liye dhanyavaad! 🌱`
      );
      
      sendProactiveMessage(buyer.phone, message).catch(err => {
        logger.warn(`Failed to notify buyer completion: ${err.message}`);
      });
    }
  }

  // Notify seller
  if (sellerId) {
    const seller = await getUserContact(sellerId);
    if (seller.phone) {
      const message = msg(seller.lang,
        `💰 Payment Released!\n\n${delivered} kWh delivered successfully.\nEarned: ${formatCurrency(totalPrice)}\n\nGreat job! Keep selling green energy! 🌞`,
        `💰 Payment Mil Gaya!\n\n${delivered} kWh deliver ho gayi.\nKamai: ${formatCurrency(totalPrice)}\n\nBahut badhiya! Green energy bechte raho! 🌞`
      );
      
      sendProactiveMessage(seller.phone, message).catch(err => {
        logger.warn(`Failed to notify seller completion: ${err.message}`);
      });
    }
  }
}

/**
 * Notify when order is cancelled.
 */
export async function notifyOrderCancelled(params: {
  orderId: string;
  buyerId?: string;
  sellerId?: string;
  cancelledBy: 'BUYER' | 'SELLER' | 'SYSTEM';
  reason?: string;
  refundAmount?: number;
}): Promise<void> {
  if (!isWhatsAppConnected()) return;

  const { buyerId, sellerId, cancelledBy, reason, refundAmount } = params;

  // Notify buyer
  if (buyerId) {
    const buyer = await getUserContact(buyerId);
    if (buyer.phone) {
      const refundText = refundAmount ? `\nRefund: ${formatCurrency(refundAmount)}` : '';
      const cancelledByHi = cancelledBy === 'BUYER' ? 'खरीदार' : cancelledBy === 'SELLER' ? 'विक्रेता' : cancelledBy;
      const message = msg(buyer.lang,
        `❌ Order Cancelled\n\nCancelled by: ${cancelledBy}${reason ? `\nReason: ${reason}` : ''}${refundText}\n\nYou can create a new order anytime.`,
        `❌ ऑर्डर रद्द हो गया\n\nकिसने: ${cancelledByHi}${reason ? `\nकारण: ${reason}` : ''}${refundText}\n\nनया ऑर्डर कभी भी कर सकते हो।`
      );
      
      sendProactiveMessage(buyer.phone, message).catch(err => {
        logger.warn(`Failed to notify buyer cancellation: ${err.message}`);
      });
    }
  }

  // Notify seller (only if buyer cancelled)
  if (sellerId && cancelledBy === 'BUYER') {
    const seller = await getUserContact(sellerId);
    if (seller.phone) {
      const message = msg(seller.lang,
        `📢 Order Cancelled\n\nBuyer cancelled the order.${reason ? `\nReason: ${reason}` : ''}\n\nYour listing is still available for other buyers.`,
        `📢 ऑर्डर रद्द\n\nखरीदार ने ऑर्डर रद्द कर दिया।${reason ? `\nकारण: ${reason}` : ''}\n\nआपकी लिस्टिंग अभी भी उपलब्ध है।`
      );
      
      sendProactiveMessage(seller.phone, message).catch(err => {
        logger.warn(`Failed to notify seller cancellation: ${err.message}`);
      });
    }
  }
}

/**
 * Notify about delivery progress (partial delivery, curtailment, etc.)
 */
export async function notifyDeliveryUpdate(params: {
  orderId: string;
  buyerId?: string;
  sellerId?: string;
  deliveredQty: number;
  expectedQty: number;
  curtailedQty?: number;
  curtailmentReason?: string;
}): Promise<void> {
  if (!isWhatsAppConnected()) return;

  const { buyerId, deliveredQty, expectedQty, curtailedQty, curtailmentReason } = params;
  
  // Only notify on significant events (completion, curtailment)
  if (curtailedQty && curtailedQty > 0 && buyerId) {
    const buyer = await getUserContact(buyerId);
    if (buyer.phone) {
      const message = msg(buyer.lang,
        `⚠️ Delivery Update\n\nDelivered: ${deliveredQty}/${expectedQty} kWh\nCurtailed: ${curtailedQty} kWh${curtailmentReason ? `\nReason: ${curtailmentReason}` : ''}\n\nYou may receive a partial refund.`,
        `⚠️ Delivery Update\n\nMila: ${deliveredQty}/${expectedQty} kWh\nCurtail: ${curtailedQty} kWh${curtailmentReason ? `\nKaran: ${curtailmentReason}` : ''}\n\nPartial refund mil sakta hai.`
      );
      
      sendProactiveMessage(buyer.phone, message).catch(err => {
        logger.warn(`Failed to notify delivery update: ${err.message}`);
      });
    }
  }
}

// ============================================
// Trading Alerts (Optional)
// ============================================

/**
 * Notify user about price changes or opportunities.
 */
export async function notifyTradingAlert(params: {
  userId: string;
  alertType: 'PRICE_UP' | 'PRICE_DOWN' | 'OPPORTUNITY' | 'LOW_BALANCE';
  message: string;
}): Promise<void> {
  if (!isWhatsAppConnected()) return;

  const { userId, message } = params;
  const user = await getUserContact(userId);
  
  // Only send if user has trading alerts enabled
  if (user.phone && user.notifyTradingAlerts) {
    sendProactiveMessage(user.phone, message).catch(err => {
      logger.warn(`Failed to send trading alert: ${err.message}`);
    });
  }
}

/**
 * Send a milestone celebration message.
 */
export async function notifyMilestone(params: {
  userId: string;
  milestone: 'FIRST_SALE' | 'FIRST_PURCHASE' | 'ENERGY_100' | 'ENERGY_1000' | 'TRUST_UPGRADED';
  details?: string;
}): Promise<void> {
  if (!isWhatsAppConnected()) return;

  const { userId, milestone, details } = params;
  const user = await getUserContact(userId);
  
  if (!user.phone) return;

  let message: string;
  switch (milestone) {
    case 'FIRST_SALE':
      message = msg(user.lang,
        `🎉 Congratulations on your first sale!\n\n${details || 'You\'ve started your green energy journey.'}\n\nKeep selling and earn more!`,
        `🎉 Pehli bikri mubarak ho!\n\n${details || 'Green energy ka safar shuru ho gaya.'}\n\nBechte raho, kamate raho!`
      );
      break;
    case 'FIRST_PURCHASE':
      message = msg(user.lang,
        `🎉 Your first energy purchase!\n\n${details || 'Welcome to peer-to-peer energy trading.'}\n\nEnjoy clean, affordable energy!`,
        `🎉 Pehli bijli kharidi!\n\n${details || 'P2P energy trading mein swagat hai.'}\n\nSasti, saaf bijli ka maze lo!`
      );
      break;
    case 'ENERGY_100':
      message = msg(user.lang,
        `⚡ 100 kWh Milestone!\n\nYou've traded 100 kWh of green energy!\n\nYou're making a real difference. 🌍`,
        `⚡ 100 kWh Milestone!\n\nAapne 100 kWh green energy trade ki!\n\nAap sach mein fark la rahe ho. 🌍`
      );
      break;
    case 'ENERGY_1000':
      message = msg(user.lang,
        `🏆 1000 kWh MEGA Milestone!\n\nYou've traded 1000 kWh of green energy!\n\nYou're a true energy champion! 🌍💪`,
        `🏆 1000 kWh का MEGA मील का पत्थर!\n\nआपने 1000 kWh ग्रीन एनर्जी ट्रेड की!\n\nआप एनर्जी चैंपियन हो! 🌍💪`
      );
      break;
    case 'TRUST_UPGRADED':
      message = msg(user.lang,
        `🌟 Trust Score Upgraded!\n\n${details || 'Your reliability has improved.'}\n\nYou can now trade larger quantities!`,
        `🌟 ट्रस्ट स्कोर बढ़ गया!\n\n${details || 'आपकी विश्वसनीयता बढ़ गई।'}\n\nअब बड़े ऑर्डर कर सकते हो!`
      );
      break;
    default:
      return;
  }

  sendProactiveMessage(user.phone, message).catch(err => {
    logger.warn(`Failed to send milestone notification: ${err.message}`);
  });
}

// ============================================
// First Login Welcome (Proactive)
// ============================================

/**
 * Send a welcome message to a user on WhatsApp after profile completion.
 * Uses atomic update to prevent duplicate messages from concurrent calls.
 * 
 * @param userId - The user's ID
 * @returns true if the message was sent, false otherwise
 */
export async function sendFirstLoginWelcome(userId: string): Promise<boolean> {
  logger.info(`[WhatsApp Welcome] Attempting to send welcome to user ${userId}`);
  
  if (!isWhatsAppConnected()) {
    logger.warn(`[WhatsApp Welcome] WhatsApp not connected - cannot send welcome to user ${userId}`);
    return false;
  }

  try {
    // First check user details and validate conditions
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { 
        phone: true, 
        name: true,
        languagePreference: true,
        profileComplete: true, 
        whatsappWelcomeSent: true 
      },
    });
    
    logger.info(`[WhatsApp Welcome] User ${userId} status: phone=${user?.phone || 'null'}, profileComplete=${user?.profileComplete}, whatsappWelcomeSent=${user?.whatsappWelcomeSent}`);

    // Early exit if conditions not met (before attempting atomic update)
    if (!user) {
      logger.warn(`[WhatsApp Welcome] User ${userId} not found`);
      return false;
    }
    
    if (!user.phone) {
      logger.info(`[WhatsApp Welcome] Skipping for user ${userId} - no phone number`);
      return false;
    }
    
    if (!user.profileComplete) {
      logger.info(`[WhatsApp Welcome] Skipping for user ${userId} - profile not complete`);
      return false;
    }
    
    if (user.whatsappWelcomeSent) {
      logger.info(`[WhatsApp Welcome] Skipping for user ${userId} - welcome already sent`);
      return false;
    }

    // Atomic check-and-set: only claim the welcome if not already sent
    // This prevents race conditions when multiple routes trigger simultaneously
    const updateResult = await prisma.user.updateMany({
      where: {
        id: userId,
        profileComplete: true,
        whatsappWelcomeSent: false,
      },
      data: { whatsappWelcomeSent: true },
    });

    // If no rows updated, another process already claimed it
    if (updateResult.count === 0) {
      logger.info(`[WhatsApp Welcome] Skipping for user ${userId} - claimed by another process`);
      return false;
    }
    
    logger.info(`[WhatsApp Welcome] Claimed welcome for user ${userId}, proceeding to send message`);

    const userName = user.name || 'friend';
    const lang = user.languagePreference || 'en-IN';

    const message = msg(lang,
      `🎉 Welcome to Oorja, ${userName}!

You've successfully registered on our app. I'm your P2P energy trading assistant, available here on WhatsApp 24/7!

I can help you:
• 🌞 Sell your solar energy
• ⚡ Buy affordable green energy
• 📊 Track orders & earnings
• 💡 Get market insights

Just message me anytime with what you need. Type "help" to see all commands.

Let's start your green energy journey! 🌱`,
      `🎉 ${userName}, ऊर्जा में आपका स्वागत है!

आपने ऐप पर रजिस्टर कर लिया। मैं आपका P2P एनर्जी ट्रेडिंग असिस्टेंट हूं, WhatsApp पर 24/7 उपलब्ध!

मैं आपकी मदद कर सकता हूं:
• 🌞 सोलर एनर्जी बेचना
• ⚡ सस्ती ग्रीन बिजली खरीदना
• 📊 ऑर्डर और कमाई ट्रैक करना
• 💡 मार्केट इनसाइट्स लेना

कुछ भी चाहिए तो मैसेज करो। "help" टाइप करो सभी कमांड्स देखने के लिए।

चलो ग्रीन एनर्जी का सफर शुरू करते हैं! 🌱`
    );

    const success = await sendProactiveMessage(user.phone, message);

    if (success) {
      logger.info(`First login welcome sent to user ${userId} (${user.phone})`);
    } else {
      // Message failed to send - reset flag so it can be retried
      await prisma.user.update({
        where: { id: userId },
        data: { whatsappWelcomeSent: false },
      }).catch(err => {
        logger.error(`Failed to reset whatsappWelcomeSent for user ${userId}: ${err.message}`);
      });
    }

    return success;
  } catch (err: any) {
    logger.error(`Failed to send first login welcome to user ${userId}: ${err.message}`);
    return false;
  }
}

/**
 * Check and trigger milestone notifications after an order is completed.
 * Call this after successful order completion.
 */
export async function checkAndNotifyMilestones(params: {
  userId: string;
  isSeller: boolean;
  orderQuantity: number;
  orderAmount: number;
}): Promise<void> {
  if (!isWhatsAppConnected()) return;

  const { userId, isSeller, orderQuantity, orderAmount } = params;

  try {
    // Get user's total orders to check for milestones
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { providerId: true },
    });

    if (isSeller && user?.providerId) {
      // Check seller milestones
      const sellerOrders = await prisma.order.findMany({
        where: {
          providerId: user.providerId,
          status: { in: ['ACTIVE', 'COMPLETED'] },
        },
        select: { totalQty: true },
      });

      const orderCount = sellerOrders.length;
      const totalKwh = sellerOrders.reduce((sum, o) => sum + (o.totalQty || 0), 0);

      // First sale milestone
      if (orderCount === 1) {
        await notifyMilestone({
          userId,
          milestone: 'FIRST_SALE',
          details: `You sold ${orderQuantity} kWh and earned ₹${orderAmount.toFixed(0)}!`,
        });
        return; // Don't check other milestones on first sale
      }

      // 100 kWh milestone
      if (totalKwh >= 100 && totalKwh - orderQuantity < 100) {
        await notifyMilestone({
          userId,
          milestone: 'ENERGY_100',
        });
        return;
      }

      // 1000 kWh milestone
      if (totalKwh >= 1000 && totalKwh - orderQuantity < 1000) {
        await notifyMilestone({
          userId,
          milestone: 'ENERGY_1000',
        });
        return;
      }
    } else {
      // Check buyer milestones
      const buyerOrders = await prisma.order.findMany({
        where: {
          buyerId: userId,
          status: { in: ['ACTIVE', 'COMPLETED'] },
        },
        select: { totalQty: true },
      });

      const orderCount = buyerOrders.length;
      const totalKwh = buyerOrders.reduce((sum, o) => sum + (o.totalQty || 0), 0);

      // First purchase milestone
      if (orderCount === 1) {
        await notifyMilestone({
          userId,
          milestone: 'FIRST_PURCHASE',
          details: `You bought ${orderQuantity} kWh of clean energy for ₹${orderAmount.toFixed(0)}!`,
        });
        return;
      }

      // 100 kWh milestone
      if (totalKwh >= 100 && totalKwh - orderQuantity < 100) {
        await notifyMilestone({
          userId,
          milestone: 'ENERGY_100',
        });
        return;
      }

      // 1000 kWh milestone
      if (totalKwh >= 1000 && totalKwh - orderQuantity < 1000) {
        await notifyMilestone({
          userId,
          milestone: 'ENERGY_1000',
        });
        return;
      }
    }
  } catch (err: any) {
    logger.warn(`Failed to check milestones: ${err.message}`);
  }
}
