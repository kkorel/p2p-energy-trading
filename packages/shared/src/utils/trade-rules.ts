/**
 * Trade Rules Enforcement
 *
 * Implements the guardrails from "Rules of the Trade" document:
 * - 1-hour delivery blocks (06:00-18:00)
 * - Gate closure (T-4h before delivery start)
 * - Trade window (T-24h max future)
 * - Minimum 1 kWh trade size, max 2 decimal places
 * - Capacity-based trading limits
 */

// ==================== Constants ====================

/** Delivery day starts at 06:00 */
export const DELIVERY_START_HOUR = 6;

/** Delivery day ends at 18:00 */
export const DELIVERY_END_HOUR = 18;

/** Gate closure: no trades allowed within this many hours of delivery start */
export const GATE_CLOSURE_HOURS = 4;

/** Trade window: trades allowed up to this many hours before delivery start */
export const TRADE_WINDOW_HOURS = 168; // 7 days

/** Minimum trade size in kWh */
export const MIN_TRADE_KWH = 1;

/** Maximum decimal places for quantity */
export const QTY_DECIMAL_PLACES = 2;

// ==================== Quantity Validation ====================

/**
 * Round quantity to allowed decimal places (2)
 */
export function roundQuantity(value: number): number {
  const factor = Math.pow(10, QTY_DECIMAL_PLACES);
  return Math.round(value * factor) / factor;
}

/**
 * Validate trade quantity meets minimum and precision rules.
 * Returns null if valid, error string if invalid.
 */
export function validateQuantity(qty: number): string | null {
  if (qty == null || isNaN(qty)) return 'Quantity is required';
  if (qty < MIN_TRADE_KWH) return `Minimum trade size is ${MIN_TRADE_KWH} kWh`;
  return null;
}

// ==================== Time Window Snapping ====================

/**
 * Snap a time to the nearest hour boundary (floor).
 * E.g. 08:30 → 08:00, 14:45 → 14:00
 */
export function snapToHourFloor(date: Date): Date {
  const snapped = new Date(date);
  snapped.setMinutes(0, 0, 0);
  return snapped;
}

/**
 * Snap a time to the nearest hour boundary (ceil).
 * E.g. 08:30 → 09:00, 14:00 → 14:00
 */
export function snapToHourCeil(date: Date): Date {
  const snapped = new Date(date);
  if (snapped.getMinutes() > 0 || snapped.getSeconds() > 0 || snapped.getMilliseconds() > 0) {
    snapped.setHours(snapped.getHours() + 1, 0, 0, 0);
  } else {
    snapped.setMinutes(0, 0, 0);
  }
  return snapped;
}

/**
 * Clamp an hour to the allowed delivery range [06:00, 18:00].
 */
function clampHour(hour: number): number {
  return Math.max(DELIVERY_START_HOUR, Math.min(DELIVERY_END_HOUR, hour));
}

/**
 * Snap a time window to valid 1-hour delivery blocks within 06:00-18:00.
 *
 * Per trade rules:
 * - Start is floored to nearest hour, clamped to >=06:00
 * - End is ceiled to nearest hour, clamped to <=18:00
 * - Returns the snapped start/end as ISO strings
 *
 * Example: 08:30-10:45 → 08:00-11:00
 */
export function snapTimeWindow(startTime: string, endTime: string): { startTime: string; endTime: string } {
  const start = new Date(startTime);
  const end = new Date(endTime);

  // Snap start down to hour, end up to hour
  const snappedStart = snapToHourFloor(start);
  const snappedEnd = snapToHourCeil(end);

  const startHour = snappedStart.getHours();
  const endHour = snappedEnd.getHours();

  // Check if the entire requested window falls outside delivery hours (06:00-18:00).
  // This happens for evening/night requests (e.g., 22:00-02:00).
  // In this case, advance to the next day's delivery window.
  const startAfterDelivery = startHour >= DELIVERY_END_HOUR;

  if (startAfterDelivery) {
    // Entire window is after 18:00 — advance to next day 06:00-18:00
    snappedStart.setDate(snappedStart.getDate() + 1);
    snappedStart.setHours(DELIVERY_START_HOUR, 0, 0, 0);
    snappedEnd.setFullYear(snappedStart.getFullYear(), snappedStart.getMonth(), snappedStart.getDate());
    snappedEnd.setHours(DELIVERY_END_HOUR, 0, 0, 0);
    return {
      startTime: snappedStart.toISOString(),
      endTime: snappedEnd.toISOString(),
    };
  }

  // Clamp hours to delivery range
  snappedStart.setHours(clampHour(startHour), 0, 0, 0);

  // Special case: if end is on a different day and before delivery hours (e.g., 02:00 next day),
  // treat as end-of-delivery on the start day
  if (endHour < DELIVERY_START_HOUR && snappedEnd.getDate() !== snappedStart.getDate()) {
    snappedEnd.setFullYear(snappedStart.getFullYear(), snappedStart.getMonth(), snappedStart.getDate());
    snappedEnd.setHours(DELIVERY_END_HOUR, 0, 0, 0);
  } else {
    snappedEnd.setHours(clampHour(endHour), 0, 0, 0);
  }

  // Ensure end > start (at least 1 hour)
  if (snappedEnd.getTime() <= snappedStart.getTime()) {
    snappedEnd.setTime(snappedStart.getTime());
    snappedEnd.setHours(snappedStart.getHours() + 1);
    // If that pushes past delivery end, advance to next day
    if (snappedEnd.getHours() > DELIVERY_END_HOUR) {
      snappedStart.setDate(snappedStart.getDate() + 1);
      snappedStart.setHours(DELIVERY_START_HOUR, 0, 0, 0);
      snappedEnd.setFullYear(snappedStart.getFullYear(), snappedStart.getMonth(), snappedStart.getDate());
      snappedEnd.setHours(DELIVERY_END_HOUR, 0, 0, 0);
    }
  }

  return {
    startTime: snappedStart.toISOString(),
    endTime: snappedEnd.toISOString(),
  };
}

/**
 * Split a time window into 1-hour delivery blocks.
 * E.g. 08:00-11:00 → [08:00-09:00, 09:00-10:00, 10:00-11:00]
 */
export function splitIntoHourlyBlocks(startTime: string, endTime: string): Array<{ startTime: string; endTime: string }> {
  const snapped = snapTimeWindow(startTime, endTime);
  const start = new Date(snapped.startTime);
  const end = new Date(snapped.endTime);
  const blocks: Array<{ startTime: string; endTime: string }> = [];

  const cursor = new Date(start);
  while (cursor.getTime() < end.getTime()) {
    const blockStart = new Date(cursor);
    const blockEnd = new Date(cursor);
    blockEnd.setHours(blockEnd.getHours() + 1);

    // Don't exceed end time
    if (blockEnd.getTime() > end.getTime()) break;

    blocks.push({
      startTime: blockStart.toISOString(),
      endTime: blockEnd.toISOString(),
    });
    cursor.setHours(cursor.getHours() + 1);
  }

  return blocks;
}

// ==================== Gate Closure & Trade Window ====================

export interface TradeWindowCheck {
  allowed: boolean;
  reason?: string;
  gateClosureTime?: string;
  tradeWindowOpens?: string;
}

/**
 * Check if a trade is allowed for the given delivery block.
 *
 * Rules:
 * - Trade window opens T-24h before delivery start
 * - Gate closes T-4h before delivery start
 * - After gate closure: no new trades, modifications, or cancellations
 */
export function checkTradeWindow(deliveryStartTime: string, now?: Date): TradeWindowCheck {
  const deliveryStart = new Date(deliveryStartTime);
  const currentTime = now || new Date();

  if (isNaN(deliveryStart.getTime())) {
    return { allowed: false, reason: 'Invalid delivery start time' };
  }

  // Gate closure: T - 4 hours
  const gateClosure = new Date(deliveryStart.getTime() - GATE_CLOSURE_HOURS * 60 * 60 * 1000);

  // Trade window opens: T - 24 hours
  const tradeWindowOpens = new Date(deliveryStart.getTime() - TRADE_WINDOW_HOURS * 60 * 60 * 1000);

  // Delivery must be in the future
  if (currentTime >= deliveryStart) {
    return {
      allowed: false,
      reason: 'Delivery block has already started or passed',
      gateClosureTime: gateClosure.toISOString(),
      tradeWindowOpens: tradeWindowOpens.toISOString(),
    };
  }

  // Check gate closure
  if (currentTime >= gateClosure) {
    return {
      allowed: false,
      reason: `Gate closed: trading not allowed within ${GATE_CLOSURE_HOURS} hours of delivery (gate closed at ${gateClosure.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })})`,
      gateClosureTime: gateClosure.toISOString(),
      tradeWindowOpens: tradeWindowOpens.toISOString(),
    };
  }

  // No upper limit on how far in advance trades can be placed

  return {
    allowed: true,
    gateClosureTime: gateClosure.toISOString(),
    tradeWindowOpens: tradeWindowOpens.toISOString(),
  };
}

/**
 * Check if a delivery time is within allowed hours (06:00-18:00).
 */
export function isWithinDeliveryHours(startTime: string, endTime: string): boolean {
  const start = new Date(startTime);
  const end = new Date(endTime);
  const startHour = start.getHours();
  const endHour = end.getHours();
  const endMinutes = end.getMinutes();

  // Start must be >= 06:00
  if (startHour < DELIVERY_START_HOUR) return false;
  // End must be <= 18:00
  if (endHour > DELIVERY_END_HOUR) return false;
  if (endHour === DELIVERY_END_HOUR && endMinutes > 0) return false;

  return true;
}

// ==================== Capacity Checks ====================

/**
 * Check if a seller's trade quantity is within their generation capacity for a single hourly block.
 * Returns null if allowed, error string if exceeds capacity.
 */
export function checkSellerCapacity(
  quantityKwh: number,
  installedCapacityKw: number | null | undefined,
  allowedTradeLimitPercent: number = 10
): string | null {
  if (!installedCapacityKw || installedCapacityKw <= 0) return null; // No capacity data, skip check
  const maxPerBlock = (installedCapacityKw * allowedTradeLimitPercent) / 100;
  if (quantityKwh > maxPerBlock) {
    return `Quantity ${quantityKwh} kWh exceeds max ${maxPerBlock.toFixed(2)} kWh per hourly block (capacity: ${installedCapacityKw} kW, limit: ${allowedTradeLimitPercent}%)`;
  }
  return null;
}

/**
 * Check if a buyer's purchase quantity is within their sanctioned load for a single hourly block.
 * Returns null if allowed, error string if exceeds load.
 */
export function checkBuyerCapacity(
  quantityKwh: number,
  sanctionedLoadKw: number | null | undefined
): string | null {
  if (!sanctionedLoadKw || sanctionedLoadKw <= 0) return null; // No load data, skip check
  if (quantityKwh > sanctionedLoadKw) {
    return `Purchase quantity ${quantityKwh} kWh exceeds your sanctioned load of ${sanctionedLoadKw} kW per hourly block`;
  }
  return null;
}
