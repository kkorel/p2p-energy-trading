/**
 * ACK Response Utilities
 */

import { BecknContext, BecknAck, BecknResponse, BecknError } from '../types/beckn';

/**
 * Create a successful ACK response
 */
export function createAck(context: BecknContext): BecknResponse {
  return {
    context,
    ack: {
      ack_status: 'ACK',
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Create a NACK response with error
 */
export function createNack(context: BecknContext, error: BecknError): BecknResponse {
  return {
    context,
    ack: {
      ack_status: 'NACK',
      timestamp: new Date().toISOString(),
      error,
    },
  };
}

/**
 * Common error codes
 */
export const ErrorCodes = {
  INVALID_REQUEST: '40001',
  OFFER_NOT_FOUND: '40401',
  ITEM_NOT_FOUND: '40402',
  ORDER_NOT_FOUND: '40403',
  INSUFFICIENT_QUANTITY: '40901',
  INTERNAL_ERROR: '50001',
} as const;
