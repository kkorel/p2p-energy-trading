/**
 * Database Module for Prosumer App
 * Re-exports Prisma client and Redis from shared package
 */

import {
  prisma,
  connectPrisma,
  disconnectPrisma,
  checkPostgresConnection,
  redis,
  connectRedis,
  disconnectRedis,
  checkRedisConnection,
  createLogger,
} from '@p2p/shared';

const logger = createLogger('DB');

// Re-export for use in other modules
export {
  prisma,
  redis,
  checkPostgresConnection,
  checkRedisConnection,
};

/**
 * Initialize database connections (PostgreSQL + Redis)
 */
export async function initDb(): Promise<void> {
  await connectPrisma();
  await connectRedis();
  logger.info('Database connections initialized');
}

/**
 * Close database connections gracefully
 */
export async function closeDb(): Promise<void> {
  await disconnectPrisma();
  await disconnectRedis();
  logger.info('Database connections closed');
}

/**
 * Check health of all database connections
 */
export async function checkDbHealth(): Promise<{ postgres: boolean; redis: boolean }> {
  const [postgres, redisOk] = await Promise.all([
    checkPostgresConnection(),
    checkRedisConnection(),
  ]);
  return { postgres, redis: redisOk };
}
