/**
 * Event logging for BAP
 * Uses Redis for fast deduplication and Prisma for persistent storage
 */

import { prisma } from './db';
import { EventDirection, isMessageProcessed, markMessageProcessed } from '@p2p/shared';

/**
 * Log an event to the database
 */
export async function logEvent(
  transaction_id: string,
  message_id: string,
  action: string,
  direction: EventDirection,
  raw_json: string
): Promise<void> {
  await prisma.event.create({
    data: {
      transactionId: transaction_id,
      messageId: message_id,
      action,
      direction,
      rawJson: raw_json,
    },
  });
  
  // Also mark in Redis for fast deduplication
  await markMessageProcessed(message_id, direction);
}

/**
 * Check if we've already processed a message with this ID
 * Uses Redis for fast lookups
 */
export async function isDuplicateMessage(message_id: string, direction: EventDirection = 'INBOUND'): Promise<boolean> {
  // First check Redis (fast path)
  const inRedis = await isMessageProcessed(message_id, direction);
  if (inRedis) {
    return true;
  }
  
  // Fallback to database check (for messages processed before Redis was added)
  const event = await prisma.event.findFirst({
    where: {
      messageId: message_id,
      direction: direction,
    },
    select: { id: true },
  });
  
  if (event) {
    // Cache in Redis for future checks
    await markMessageProcessed(message_id, direction);
    return true;
  }
  
  return false;
}

/**
 * Get all events for a transaction
 */
export async function getEventsByTransactionId(transaction_id: string): Promise<any[]> {
  const events = await prisma.event.findMany({
    where: { transactionId: transaction_id },
    orderBy: { createdAt: 'asc' },
  });
  
  return events.map(e => ({
    id: e.id,
    transaction_id: e.transactionId,
    message_id: e.messageId,
    action: e.action,
    direction: e.direction,
    raw_json: e.rawJson,
    created_at: e.createdAt.toISOString(),
  }));
}
