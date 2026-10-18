/**
 * Unit Tests for Utility Functions
 */

import { v4 as uuidv4 } from 'uuid';

describe('UUID Utility', () => {
  it('should generate valid UUID v4', () => {
    const id = uuidv4();
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(id).toMatch(uuidRegex);
  });

  it('should generate unique IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(uuidv4());
    }
    expect(ids.size).toBe(1000);
  });
});

describe('Price Calculations', () => {
  const PLATFORM_FEE_PERCENT = 0.025; // 2.5%

  function calculatePlatformFee(amount: number): number {
    return Math.round(amount * PLATFORM_FEE_PERCENT * 100) / 100;
  }

  function calculateTotalWithFee(amount: number): number {
    return amount + calculatePlatformFee(amount);
  }

  it('should calculate platform fee correctly', () => {
    expect(calculatePlatformFee(100)).toBe(2.5);
    expect(calculatePlatformFee(200)).toBe(5);
    expect(calculatePlatformFee(180)).toBe(4.5);
  });

  it('should calculate total with fee correctly', () => {
    expect(calculateTotalWithFee(100)).toBe(102.5);
    expect(calculateTotalWithFee(200)).toBe(205);
    expect(calculateTotalWithFee(180)).toBe(184.5);
  });

  it('should handle zero amounts', () => {
    expect(calculatePlatformFee(0)).toBe(0);
    expect(calculateTotalWithFee(0)).toBe(0);
  });

  it('should handle decimal amounts', () => {
    expect(calculatePlatformFee(99.99)).toBe(2.5);
    expect(calculateTotalWithFee(99.99)).toBe(102.49);
  });
});

describe('Quote Calculation', () => {
  interface PriceInfo {
    pricePerKwh: number;
    currency: string;
  }

  function calculateQuote(priceInfo: PriceInfo, quantity: number) {
    const totalPrice = priceInfo.pricePerKwh * quantity;
    return {
      price: {
        value: totalPrice,
        currency: priceInfo.currency,
      },
      totalQuantity: quantity,
    };
  }

  it('should calculate quote correctly', () => {
    const quote = calculateQuote({ pricePerKwh: 6, currency: 'INR' }, 10);
    expect(quote.price.value).toBe(60);
    expect(quote.price.currency).toBe('INR');
    expect(quote.totalQuantity).toBe(10);
  });

  it('should handle fractional prices', () => {
    const quote = calculateQuote({ pricePerKwh: 5.5, currency: 'INR' }, 10);
    expect(quote.price.value).toBe(55);
  });

  it('should handle large quantities', () => {
    const quote = calculateQuote({ pricePerKwh: 6, currency: 'INR' }, 1000);
    expect(quote.price.value).toBe(6000);
  });
});

describe('Time Window Validation', () => {
  interface TimeWindow {
    startTime: string;
    endTime: string;
  }

  function isValidTimeWindow(window: TimeWindow): boolean {
    const start = new Date(window.startTime);
    const end = new Date(window.endTime);
    return start < end && !isNaN(start.getTime()) && !isNaN(end.getTime());
  }

  function isTimeWindowOverlap(a: TimeWindow, b: TimeWindow): boolean {
    const aStart = new Date(a.startTime).getTime();
    const aEnd = new Date(a.endTime).getTime();
    const bStart = new Date(b.startTime).getTime();
    const bEnd = new Date(b.endTime).getTime();
    
    return aStart < bEnd && bStart < aEnd;
  }

  it('should validate time windows correctly', () => {
    expect(isValidTimeWindow({
      startTime: '2024-01-01T00:00:00Z',
      endTime: '2024-01-01T12:00:00Z',
    })).toBe(true);

    expect(isValidTimeWindow({
      startTime: '2024-01-01T12:00:00Z',
      endTime: '2024-01-01T00:00:00Z',
    })).toBe(false);
  });

  it('should reject invalid dates', () => {
    expect(isValidTimeWindow({
      startTime: 'invalid',
      endTime: '2024-01-01T12:00:00Z',
    })).toBe(false);
  });

  it('should detect overlapping time windows', () => {
    const window1 = {
      startTime: '2024-01-01T08:00:00Z',
      endTime: '2024-01-01T12:00:00Z',
    };
    const window2 = {
      startTime: '2024-01-01T10:00:00Z',
      endTime: '2024-01-01T14:00:00Z',
    };
    const window3 = {
      startTime: '2024-01-01T14:00:00Z',
      endTime: '2024-01-01T18:00:00Z',
    };

    expect(isTimeWindowOverlap(window1, window2)).toBe(true);
    expect(isTimeWindowOverlap(window1, window3)).toBe(false);
    expect(isTimeWindowOverlap(window2, window3)).toBe(false);
  });
});

describe('Order Status Transitions', () => {
  type OrderStatus = 'DRAFT' | 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';

  const validTransitions: Record<OrderStatus, OrderStatus[]> = {
    'DRAFT': ['PENDING', 'CANCELLED'],
    'PENDING': ['ACTIVE', 'CANCELLED'],
    'ACTIVE': ['COMPLETED', 'CANCELLED'],
    'COMPLETED': [],
    'CANCELLED': [],
  };

  function canTransition(from: OrderStatus, to: OrderStatus): boolean {
    return validTransitions[from].includes(to);
  }

  it('should allow valid transitions', () => {
    expect(canTransition('DRAFT', 'PENDING')).toBe(true);
    expect(canTransition('PENDING', 'ACTIVE')).toBe(true);
    expect(canTransition('ACTIVE', 'COMPLETED')).toBe(true);
  });

  it('should reject invalid transitions', () => {
    expect(canTransition('DRAFT', 'ACTIVE')).toBe(false);
    expect(canTransition('COMPLETED', 'ACTIVE')).toBe(false);
    expect(canTransition('CANCELLED', 'PENDING')).toBe(false);
  });

  it('should allow cancellation from most states', () => {
    expect(canTransition('DRAFT', 'CANCELLED')).toBe(true);
    expect(canTransition('PENDING', 'CANCELLED')).toBe(true);
    expect(canTransition('ACTIVE', 'CANCELLED')).toBe(true);
  });

  it('should not allow any transition from terminal states', () => {
    expect(validTransitions['COMPLETED'].length).toBe(0);
    expect(validTransitions['CANCELLED'].length).toBe(0);
  });
});

describe('Energy Source Validation', () => {
  const validSourceTypes = ['SOLAR', 'WIND', 'HYDRO', 'BIOMASS', 'GRID'];

  function isValidSourceType(type: string): boolean {
    return validSourceTypes.includes(type.toUpperCase());
  }

  it('should validate known source types', () => {
    expect(isValidSourceType('SOLAR')).toBe(true);
    expect(isValidSourceType('WIND')).toBe(true);
    expect(isValidSourceType('HYDRO')).toBe(true);
  });

  it('should be case-insensitive', () => {
    expect(isValidSourceType('solar')).toBe(true);
    expect(isValidSourceType('Solar')).toBe(true);
    expect(isValidSourceType('SOLAR')).toBe(true);
  });

  it('should reject unknown source types', () => {
    expect(isValidSourceType('NUCLEAR')).toBe(false);
    expect(isValidSourceType('COAL')).toBe(false);
    expect(isValidSourceType('')).toBe(false);
  });
});

describe('Input Sanitization', () => {
  function sanitizeInput(input: string): string {
    return input.trim().replace(/[<>]/g, '');
  }

  function isValidQuantity(qty: number): boolean {
    return Number.isInteger(qty) && qty > 0 && qty <= 10000;
  }

  function isValidPrice(price: number): boolean {
    return price > 0 && price <= 1000 && Number.isFinite(price);
  }

  it('should sanitize HTML-like inputs', () => {
    expect(sanitizeInput('<script>alert("xss")</script>')).toBe('scriptalert("xss")/script');
    expect(sanitizeInput('  normal text  ')).toBe('normal text');
  });

  it('should validate quantities', () => {
    expect(isValidQuantity(10)).toBe(true);
    expect(isValidQuantity(0)).toBe(false);
    expect(isValidQuantity(-5)).toBe(false);
    expect(isValidQuantity(10001)).toBe(false);
    expect(isValidQuantity(1.5)).toBe(false);
  });

  it('should validate prices', () => {
    expect(isValidPrice(6)).toBe(true);
    expect(isValidPrice(0.01)).toBe(true);
    expect(isValidPrice(0)).toBe(false);
    expect(isValidPrice(-1)).toBe(false);
    expect(isValidPrice(Infinity)).toBe(false);
  });
});
