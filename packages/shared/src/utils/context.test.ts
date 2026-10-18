/**
 * Comprehensive unit tests for Context Utilities
 * Tests Beckn context creation and callback context creation
 */

import { createContext, createCallbackContext, CreateContextOptions } from './context';
import { BecknContext, BecknAction, BECKN_DOMAIN, BECKN_VERSION, BECKN_SCHEMA_CONTEXT } from '../types/beckn';

// UUID v4 regex pattern
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ISO 8601 timestamp regex
const ISO_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/;

describe('Context Utilities', () => {
  describe('createContext', () => {
    const baseOptions: CreateContextOptions = {
      action: 'discover',
      bap_id: 'test-bap-id',
      bap_uri: 'https://test-bap.example.com',
    };

    it('should create context with required fields', () => {
      const context = createContext(baseOptions);

      expect(context.domain).toBe(BECKN_DOMAIN);
      expect(context.version).toBe(BECKN_VERSION);
      expect(context.action).toBe('discover');
      expect(context.bap_id).toBe('test-bap-id');
      expect(context.bap_uri).toBe('https://test-bap.example.com');
    });

    it('should generate valid UUID v4 for message_id when not provided', () => {
      const context = createContext(baseOptions);

      expect(context.message_id).toMatch(UUID_V4_REGEX);
    });

    it('should generate valid UUID v4 for transaction_id when not provided', () => {
      const context = createContext(baseOptions);

      expect(context.transaction_id).toMatch(UUID_V4_REGEX);
    });

    it('should use provided message_id', () => {
      const context = createContext({
        ...baseOptions,
        message_id: 'custom-message-123',
      });

      expect(context.message_id).toBe('custom-message-123');
    });

    it('should use provided transaction_id', () => {
      const context = createContext({
        ...baseOptions,
        transaction_id: 'custom-txn-456',
      });

      expect(context.transaction_id).toBe('custom-txn-456');
    });

    it('should set timestamp in ISO 8601 format', () => {
      const before = new Date().toISOString();
      const context = createContext(baseOptions);
      const after = new Date().toISOString();

      expect(context.timestamp).toMatch(ISO_TIMESTAMP_REGEX);
      expect(new Date(context.timestamp).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime() - 1000);
      expect(new Date(context.timestamp).getTime()).toBeLessThanOrEqual(new Date(after).getTime() + 1000);
    });

    it('should set default ttl to PT30S', () => {
      const context = createContext(baseOptions);

      expect(context.ttl).toBe('PT30S');
    });

    it('should use provided ttl', () => {
      const context = createContext({
        ...baseOptions,
        ttl: 'PT60S',
      });

      expect(context.ttl).toBe('PT60S');
    });

    it('should include bpp_id when provided', () => {
      const context = createContext({
        ...baseOptions,
        bpp_id: 'test-bpp-id',
      });

      expect(context.bpp_id).toBe('test-bpp-id');
    });

    it('should include bpp_uri when provided', () => {
      const context = createContext({
        ...baseOptions,
        bpp_uri: 'https://test-bpp.example.com',
      });

      expect(context.bpp_uri).toBe('https://test-bpp.example.com');
    });

    it('should have undefined bpp_id when not provided', () => {
      const context = createContext(baseOptions);

      expect(context.bpp_id).toBeUndefined();
    });

    it('should have undefined bpp_uri when not provided', () => {
      const context = createContext(baseOptions);

      expect(context.bpp_uri).toBeUndefined();
    });

    it('should include default location', () => {
      const context = createContext(baseOptions);

      expect(context.location).toBeDefined();
    });

    it('should use provided location', () => {
      const customLocation = {
        country: { code: 'IND', name: 'India' },
        city: { code: 'MUM', name: 'Mumbai' },
      };
      const context = createContext({
        ...baseOptions,
        location: customLocation,
      });

      expect(context.location).toEqual(customLocation);
    });

    it('should always include schema_context', () => {
      const context = createContext(baseOptions);

      expect(context.schema_context).toBe(BECKN_SCHEMA_CONTEXT);
    });

    it('should generate unique message_ids for each call', () => {
      const context1 = createContext(baseOptions);
      const context2 = createContext(baseOptions);

      expect(context1.message_id).not.toBe(context2.message_id);
    });

    it('should generate unique transaction_ids for each call', () => {
      const context1 = createContext(baseOptions);
      const context2 = createContext(baseOptions);

      expect(context1.transaction_id).not.toBe(context2.transaction_id);
    });

    it('should handle all Beckn actions', () => {
      const actions: BecknAction[] = ['discover', 'select', 'init', 'confirm', 'status', 'cancel'];

      actions.forEach(action => {
        const context = createContext({ ...baseOptions, action });
        expect(context.action).toBe(action);
      });
    });

    it('should handle callback actions', () => {
      const callbackActions: BecknAction[] = ['on_discover', 'on_select', 'on_init', 'on_confirm', 'on_status', 'on_cancel'];

      callbackActions.forEach(action => {
        const context = createContext({ ...baseOptions, action });
        expect(context.action).toBe(action);
      });
    });
  });

  describe('createCallbackContext', () => {
    const incomingContext: BecknContext = {
      domain: BECKN_DOMAIN,
      version: BECKN_VERSION,
      action: 'discover',
      timestamp: '2026-01-29T10:00:00.000Z',
      message_id: 'incoming-msg-123',
      transaction_id: 'txn-456',
      bap_id: 'original-bap',
      bap_uri: 'https://original-bap.example.com',
      bpp_id: 'original-bpp',
      bpp_uri: 'https://original-bpp.example.com',
      ttl: 'PT30S',
      location: { country: { code: 'IND', name: 'India' }, city: { code: 'BLR', name: 'Bangalore' } },
      schema_context: BECKN_SCHEMA_CONTEXT,
    };

    it('should preserve domain from incoming context', () => {
      const callback = createCallbackContext(incomingContext, 'on_discover');

      expect(callback.domain).toBe(incomingContext.domain);
    });

    it('should preserve version from incoming context', () => {
      const callback = createCallbackContext(incomingContext, 'on_discover');

      expect(callback.version).toBe(incomingContext.version);
    });

    it('should preserve transaction_id from incoming context', () => {
      const callback = createCallbackContext(incomingContext, 'on_discover');

      expect(callback.transaction_id).toBe('txn-456');
    });

    it('should preserve bap_id from incoming context', () => {
      const callback = createCallbackContext(incomingContext, 'on_discover');

      expect(callback.bap_id).toBe('original-bap');
    });

    it('should preserve bap_uri from incoming context', () => {
      const callback = createCallbackContext(incomingContext, 'on_discover');

      expect(callback.bap_uri).toBe('https://original-bap.example.com');
    });

    it('should preserve bpp_id from incoming context', () => {
      const callback = createCallbackContext(incomingContext, 'on_discover');

      expect(callback.bpp_id).toBe('original-bpp');
    });

    it('should preserve bpp_uri from incoming context', () => {
      const callback = createCallbackContext(incomingContext, 'on_discover');

      expect(callback.bpp_uri).toBe('https://original-bpp.example.com');
    });

    it('should change action to callback action', () => {
      const callback = createCallbackContext(incomingContext, 'on_discover');

      expect(callback.action).toBe('on_discover');
      expect(callback.action).not.toBe(incomingContext.action);
    });

    it('should generate new message_id', () => {
      const callback = createCallbackContext(incomingContext, 'on_discover');

      expect(callback.message_id).not.toBe(incomingContext.message_id);
      expect(callback.message_id).toMatch(UUID_V4_REGEX);
    });

    it('should update timestamp to current time', () => {
      const before = new Date().toISOString();
      const callback = createCallbackContext(incomingContext, 'on_discover');
      const after = new Date().toISOString();

      expect(callback.timestamp).not.toBe(incomingContext.timestamp);
      expect(new Date(callback.timestamp).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime() - 1000);
      expect(new Date(callback.timestamp).getTime()).toBeLessThanOrEqual(new Date(after).getTime() + 1000);
    });

    it('should preserve ttl from incoming context', () => {
      const callback = createCallbackContext(incomingContext, 'on_discover');

      expect(callback.ttl).toBe('PT30S');
    });

    it('should preserve location from incoming context', () => {
      const callback = createCallbackContext(incomingContext, 'on_discover');

      expect(callback.location).toEqual(incomingContext.location);
    });

    it('should work with all callback action pairs', () => {
      const actionPairs: [BecknAction, BecknAction][] = [
        ['discover', 'on_discover'],
        ['select', 'on_select'],
        ['init', 'on_init'],
        ['confirm', 'on_confirm'],
        ['status', 'on_status'],
        ['cancel', 'on_cancel'],
      ];

      actionPairs.forEach(([incoming, callback]) => {
        const incomingWithAction = { ...incomingContext, action: incoming };
        const result = createCallbackContext(incomingWithAction, callback);
        expect(result.action).toBe(callback);
      });
    });

    it('should generate different message_ids for sequential calls', () => {
      const callback1 = createCallbackContext(incomingContext, 'on_discover');
      const callback2 = createCallbackContext(incomingContext, 'on_discover');

      expect(callback1.message_id).not.toBe(callback2.message_id);
    });

    it('should handle incoming context without optional fields', () => {
      const minimalContext: BecknContext = {
        domain: BECKN_DOMAIN,
        version: BECKN_VERSION,
        action: 'discover',
        timestamp: '2026-01-29T10:00:00.000Z',
        message_id: 'msg-123',
        transaction_id: 'txn-456',
        bap_id: 'bap-id',
        bap_uri: 'https://bap.example.com',
        ttl: 'PT30S',
        location: { country: { code: 'IND', name: 'India' }, city: { code: 'BLR', name: 'Bangalore' } },
        schema_context: BECKN_SCHEMA_CONTEXT,
      };

      const callback = createCallbackContext(minimalContext, 'on_discover');

      expect(callback.bpp_id).toBeUndefined();
      expect(callback.bpp_uri).toBeUndefined();
      expect(callback.transaction_id).toBe('txn-456');
    });
  });
});
