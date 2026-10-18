/**
 * Beckn Context Utilities
 */

import {v4 as uuidv4} from 'uuid';

import {
  BECKN_DOMAIN,
  BECKN_SCHEMA_CONTEXT,
  BECKN_VERSION,
  BECKN_DEFAULT_LOCATION,
  BecknAction,
  BecknContext,
  BecknLocation,
} from '../types/beckn';

export interface CreateContextOptions {
  action: BecknAction;
  transaction_id?: string;
  message_id?: string;
  bap_id: string;
  bap_uri: string;
  bpp_id?: string;
  bpp_uri?: string;
  ttl?: string;
  location?: BecknLocation;
}

/**
 * Create a new Beckn context
 */
export function createContext(options: CreateContextOptions): BecknContext {
  return {
    domain: BECKN_DOMAIN,
    version: BECKN_VERSION,
    action: options.action,
    timestamp: new Date().toISOString(),
    message_id: options.message_id || uuidv4(),
    transaction_id: options.transaction_id || uuidv4(),
    bap_id: options.bap_id,
    bap_uri: options.bap_uri,
    bpp_id: options.bpp_id,
    bpp_uri: options.bpp_uri,
    ttl: options.ttl || 'PT30S',
    // Beckn v2.0 requires location and schema_context
    location: options.location || BECKN_DEFAULT_LOCATION,
    schema_context: BECKN_SCHEMA_CONTEXT,
  };
}

/**
 * Create a callback context from an incoming context
 */
export function createCallbackContext(
  incomingContext: BecknContext,
  callbackAction: BecknAction
): BecknContext {
  return {
    ...incomingContext,
    action: callbackAction,
    message_id: uuidv4(),
    timestamp: new Date().toISOString(),
  };
}
