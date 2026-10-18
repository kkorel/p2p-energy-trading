/**
 * Prisma Client Singleton
 * Provides connection pooling and proper cleanup
 */

import { PrismaClient } from '../generated/prisma';

// Declare global type for development hot-reload
declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

// Connection pool configuration for production
const prismaClientSingleton = () => {
  return new PrismaClient({
    log: process.env.NODE_ENV === 'development' 
      ? ['query', 'error', 'warn'] 
      : ['error'],
    datasources: {
      db: {
        url: process.env.DATABASE_URL,
      },
    },
  });
};

// Use global variable in development to prevent multiple instances during hot-reload
export const prisma = globalThis.prisma ?? prismaClientSingleton();

if (process.env.NODE_ENV !== 'production') {
  globalThis.prisma = prisma;
}

/**
 * Check if PostgreSQL is connected
 */
export async function checkPostgresConnection(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    console.error('PostgreSQL connection check failed:', error);
    return false;
  }
}

/**
 * Disconnect Prisma client (for graceful shutdown)
 */
export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}

/**
 * Connect Prisma client explicitly
 */
export async function connectPrisma(): Promise<void> {
  await prisma.$connect();
}

export type { PrismaClient };
