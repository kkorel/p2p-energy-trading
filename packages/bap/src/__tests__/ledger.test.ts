/**
 * Comprehensive unit tests for DEG Ledger Integration
 * Tests trade writing, error handling, and health checks
 */

import { writeTradeToLedger, getTradeFromLedger, checkLedgerHealth } from '../ledger';
import axios from 'axios';
import { config, Order } from '@p2p/shared';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock config
jest.mock('@p2p/shared', () => ({
  config: {
    external: {
      enableLedgerWrites: true,
      ledger: 'https://mock-ledger.example.com',
    },
    bap: { id: 'test-bap-id' },
    bpp: { id: 'test-bpp-id' },
  },
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// Get the mocked config
const mockedConfig = config as jest.Mocked<typeof config>;

describe('DEG Ledger Integration', () => {
  const mockOrder = {
    id: 'order-123',
    transaction_id: 'txn-123',
    status: 'ACTIVE',
    providerId: 'provider-456',
    items: [
      {
        itemId: 'item-1',
        offerId: 'offer-1',
        quantity: 10,
        timeWindow: {
          startTime: '2026-01-29T08:00:00Z',
          endTime: '2026-01-29T16:00:00Z',
        },
      },
    ],
    quote: {
      price: { value: 60, currency: 'INR' },
      totalQuantity: 10,
    },
    created_at: '2026-01-29T07:00:00Z',
    updated_at: '2026-01-29T07:00:00Z',
  } as unknown as Order;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset config to enabled
    (mockedConfig.external as any).enableLedgerWrites = true;
  });

  describe('writeTradeToLedger', () => {
    describe('Config Disabled', () => {
      it('should return success with mock ID when ledger writes disabled', async () => {
        (mockedConfig.external as any).enableLedgerWrites = false;

        const result = await writeTradeToLedger('txn-123', mockOrder, 'buyer-1', 'seller-1');

        expect(result.success).toBe(true);
        expect(result.recordId).toBe('mock-disabled');
        expect(mockedAxios.post).not.toHaveBeenCalled();
      });
    });

    describe('Successful Write', () => {
      it('should return success with recordId on successful write', async () => {
        mockedAxios.post.mockResolvedValue({
          data: {
            success: true,
            recordId: 'ledger-record-abc123',
            creationTime: '2026-01-29T08:00:00Z',
            rowDigest: 'sha256-digest',
          },
        });

        const result = await writeTradeToLedger('txn-123', mockOrder, 'buyer-1', 'seller-1');

        expect(result.success).toBe(true);
        expect(result.recordId).toBe('ledger-record-abc123');
      });

      it('should call correct ledger endpoint', async () => {
        mockedAxios.post.mockResolvedValue({ data: { success: true, recordId: 'r1' } });

        await writeTradeToLedger('txn-123', mockOrder, 'buyer-1', 'seller-1');

        expect(mockedAxios.post).toHaveBeenCalledWith(
          'https://mock-ledger.example.com/ledger/put',
          expect.any(Object),
          expect.any(Object)
        );
      });
    });

    describe('Request Formatting', () => {
      it('should set role to BUYER', async () => {
        mockedAxios.post.mockResolvedValue({ data: { success: true, recordId: 'r1' } });

        await writeTradeToLedger('txn-123', mockOrder, 'buyer-1', 'seller-1');

        expect(mockedAxios.post).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ role: 'BUYER' }),
          expect.any(Object)
        );
      });

      it('should include transaction ID', async () => {
        mockedAxios.post.mockResolvedValue({ data: { success: true, recordId: 'r1' } });

        await writeTradeToLedger('txn-456', mockOrder, 'buyer-1', 'seller-1');

        expect(mockedAxios.post).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ transactionId: 'txn-456' }),
          expect.any(Object)
        );
      });

      it('should include order ID as orderItemId', async () => {
        mockedAxios.post.mockResolvedValue({ data: { success: true, recordId: 'r1' } });

        await writeTradeToLedger('txn-123', mockOrder, 'buyer-1', 'seller-1');

        expect(mockedAxios.post).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ orderItemId: 'order-123' }),
          expect.any(Object)
        );
      });

      it('should include platform IDs from config', async () => {
        mockedAxios.post.mockResolvedValue({ data: { success: true, recordId: 'r1' } });

        await writeTradeToLedger('txn-123', mockOrder, 'buyer-1', 'seller-1');

        expect(mockedAxios.post).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            platformIdBuyer: 'test-bap-id',
            platformIdSeller: 'test-bpp-id',
          }),
          expect.any(Object)
        );
      });

      it('should include buyer and seller IDs', async () => {
        mockedAxios.post.mockResolvedValue({ data: { success: true, recordId: 'r1' } });

        await writeTradeToLedger('txn-123', mockOrder, 'buyer-abc', 'seller-xyz');

        expect(mockedAxios.post).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            buyerId: 'buyer-abc',
            sellerId: 'seller-xyz',
          }),
          expect.any(Object)
        );
      });

      it('should include trade details with ENERGY type', async () => {
        mockedAxios.post.mockResolvedValue({ data: { success: true, recordId: 'r1' } });

        await writeTradeToLedger('txn-123', mockOrder, 'buyer-1', 'seller-1');

        expect(mockedAxios.post).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            tradeDetails: expect.arrayContaining([
              expect.objectContaining({
                tradeType: 'ENERGY',
                tradeQty: 10,
                tradeUnit: 'KWH',
              }),
            ]),
          }),
          expect.any(Object)
        );
      });

      it('should include delivery time window', async () => {
        mockedAxios.post.mockResolvedValue({ data: { success: true, recordId: 'r1' } });

        await writeTradeToLedger('txn-123', mockOrder, 'buyer-1', 'seller-1');

        expect(mockedAxios.post).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            deliveryStartTime: '2026-01-29T08:00:00Z',
            deliveryEndTime: '2026-01-29T16:00:00Z',
          }),
          expect.any(Object)
        );
      });

      it('should include clientReference with transaction-order-timestamp format', async () => {
        mockedAxios.post.mockResolvedValue({ data: { success: true, recordId: 'r1' } });

        await writeTradeToLedger('txn-123', mockOrder, 'buyer-1', 'seller-1');

        expect(mockedAxios.post).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            clientReference: expect.stringMatching(/^txn-123-order-123-\d+$/),
          }),
          expect.any(Object)
        );
      });
    });

    describe('Error Handling', () => {
      it('should return error for ECONNREFUSED', async () => {
        mockedAxios.post.mockRejectedValue({
          code: 'ECONNREFUSED',
          message: 'Connection refused',
        });

        const result = await writeTradeToLedger('txn-123', mockOrder, 'buyer-1', 'seller-1');

        expect(result.success).toBe(false);
        expect(result.error).toContain('unreachable');
      });

      it('should return error for ETIMEDOUT', async () => {
        mockedAxios.post.mockRejectedValue({
          code: 'ETIMEDOUT',
          message: 'Timeout',
        });

        const result = await writeTradeToLedger('txn-123', mockOrder, 'buyer-1', 'seller-1');

        expect(result.success).toBe(false);
        expect(result.error).toContain('timeout');
      });

      it('should return error for ECONNABORTED', async () => {
        mockedAxios.post.mockRejectedValue({
          code: 'ECONNABORTED',
          message: 'Aborted',
        });

        const result = await writeTradeToLedger('txn-123', mockOrder, 'buyer-1', 'seller-1');

        expect(result.success).toBe(false);
        expect(result.error).toContain('timeout');
      });

      it('should return error for 401 response', async () => {
        mockedAxios.post.mockRejectedValue({
          response: { status: 401 },
          message: 'Unauthorized',
        });

        const result = await writeTradeToLedger('txn-123', mockOrder, 'buyer-1', 'seller-1');

        expect(result.success).toBe(false);
        expect(result.error).toContain('authentication failed');
      });

      it('should return error for 400 response', async () => {
        mockedAxios.post.mockRejectedValue({
          response: { status: 400, data: { error: 'Invalid request' } },
          message: 'Bad Request',
        });

        const result = await writeTradeToLedger('txn-123', mockOrder, 'buyer-1', 'seller-1');

        expect(result.success).toBe(false);
        expect(result.error).toContain('validation error');
      });

      it('should return error for 403 response', async () => {
        mockedAxios.post.mockRejectedValue({
          response: { status: 403 },
          message: 'Forbidden',
        });

        const result = await writeTradeToLedger('txn-123', mockOrder, 'buyer-1', 'seller-1');

        expect(result.success).toBe(false);
        expect(result.error).toContain('authorization failed');
      });

      it('should return error when API returns success: false', async () => {
        mockedAxios.post.mockResolvedValue({
          data: { success: false, message: 'Invalid trade data' },
        });

        const result = await writeTradeToLedger('txn-123', mockOrder, 'buyer-1', 'seller-1');

        expect(result.success).toBe(false);
        expect(result.error).toBe('Invalid trade data');
      });

      it('should handle generic errors', async () => {
        mockedAxios.post.mockRejectedValue(new Error('Network error'));

        const result = await writeTradeToLedger('txn-123', mockOrder, 'buyer-1', 'seller-1');

        expect(result.success).toBe(false);
        expect(result.error).toBe('Network error');
      });
    });

    describe('Edge Cases', () => {
      it('should handle order with no items', async () => {
        mockedAxios.post.mockResolvedValue({ data: { success: true, recordId: 'r1' } });
        const orderWithNoItems = { ...mockOrder, items: [] };

        const result = await writeTradeToLedger('txn-123', orderWithNoItems as Order, 'buyer-1', 'seller-1');

        expect(result.success).toBe(true);
        expect(mockedAxios.post).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ tradeDetails: [] }),
          expect.any(Object)
        );
      });

      it('should handle order with undefined items', async () => {
        mockedAxios.post.mockResolvedValue({ data: { success: true, recordId: 'r1' } });
        const orderWithNoItems = { ...mockOrder, items: undefined };

        const result = await writeTradeToLedger('txn-123', orderWithNoItems as Order, 'buyer-1', 'seller-1');

        // Should not throw
        expect(result.success).toBe(true);
      });
    });
  });

  describe('getTradeFromLedger (mocked)', () => {
    it('should return mock record with correct structure', async () => {
      const result = await getTradeFromLedger('txn-123', 'order-456');

      expect(result.success).toBe(true);
      expect(result.records).toBeDefined();
      expect(result.records!.length).toBe(1);
    });

    it('should include transaction ID in mock record', async () => {
      const result = await getTradeFromLedger('txn-abc', 'order-def');

      expect(result.records![0].transactionId).toBe('txn-abc');
    });

    it('should include record ID in mock record', async () => {
      const result = await getTradeFromLedger('txn-xyz');

      expect(result.records![0].recordId).toMatch(/^mock-txn-xyz$/);
    });

    it('should include platform IDs in mock record', async () => {
      const result = await getTradeFromLedger('txn-123');

      expect(result.records![0].platformIdBuyer).toBe('test-bap-id');
      expect(result.records![0].platformIdSeller).toBe('test-bpp-id');
    });

    it('should include trade details in mock record', async () => {
      const result = await getTradeFromLedger('txn-123');

      expect(result.records![0].tradeDetails).toBeDefined();
      expect(result.records![0].tradeDetails![0]).toEqual({
        tradeType: 'ENERGY',
        tradeQty: 10,
        tradeUnit: 'KWH',
      });
    });

    it('should handle missing order ID', async () => {
      const result = await getTradeFromLedger('txn-123');

      expect(result.success).toBe(true);
      expect(result.records![0].orderItemId).toBe('unknown');
    });
  });

  describe('checkLedgerHealth', () => {
    it('should return true when ledger writes disabled', async () => {
      (mockedConfig.external as any).enableLedgerWrites = false;

      const result = await checkLedgerHealth();

      expect(result).toBe(true);
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it('should return true when health check returns 200', async () => {
      mockedAxios.get.mockResolvedValue({ status: 200 });

      const result = await checkLedgerHealth();

      expect(result).toBe(true);
    });

    it('should call correct health endpoint', async () => {
      mockedAxios.get.mockResolvedValue({ status: 200 });

      await checkLedgerHealth();

      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://mock-ledger.example.com/health',
        expect.objectContaining({ timeout: 5000 })
      );
    });

    it('should return false when health check fails', async () => {
      mockedAxios.get.mockRejectedValue(new Error('Connection failed'));

      const result = await checkLedgerHealth();

      expect(result).toBe(false);
    });

    it('should return false for non-200 response', async () => {
      mockedAxios.get.mockResolvedValue({ status: 503 });

      const result = await checkLedgerHealth();

      expect(result).toBe(false);
    });

    it('should return false on timeout', async () => {
      mockedAxios.get.mockRejectedValue({ code: 'ETIMEDOUT' });

      const result = await checkLedgerHealth();

      expect(result).toBe(false);
    });
  });
});
