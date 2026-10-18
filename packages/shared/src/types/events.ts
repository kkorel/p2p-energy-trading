/**
 * Event Types for logging and correlation
 */

// Event direction
export type EventDirection = 'OUTBOUND' | 'INBOUND';

// Event record stored in database
export interface EventRecord {
  id?: number;
  transaction_id: string;
  message_id: string;
  action: string;
  direction: EventDirection;
  raw_json: string;
  created_at: string;
}
